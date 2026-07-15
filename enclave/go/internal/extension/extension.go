package extension

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"

	"keyless-extension/internal/config"
	"keyless-extension/pkg/types"

	"github.com/flare-foundation/go-flare-common/pkg/tee/instruction"
	teetypes "github.com/flare-foundation/tee-node/pkg/types"
	teeutils "github.com/flare-foundation/tee-node/pkg/utils"

	"github.com/flare-foundation/tee-node/pkg/processorutils"

	xrplcrypto "github.com/Peersyst/xrpl-go/pkg/crypto"
	"github.com/Peersyst/xrpl-go/xrpl/rpc"
	xrpltx "github.com/Peersyst/xrpl-go/xrpl/transaction"
	xrpltypes "github.com/Peersyst/xrpl-go/xrpl/transaction/types"
	"github.com/Peersyst/xrpl-go/xrpl/wallet"
)

// Extension holds mutable state for the Keyless extension.
//
// SECURITY MODEL — read this before changing anything here.
//
// The XRPL private key is generated INSIDE this enclave (see processInit) and never leaves it.
// It is not delivered by an operator, not decrypted from chain, not restorable from a backup.
// Nobody — not the person running this machine, not the authors — has ever seen it.
//
// This is the one thing that makes Keyless true rather than theatre. Flare's reference `fce-sign`
// extension takes the opposite approach: an operator generates a key off-chain, encrypts it, and
// ships it in via an UPDATE instruction. That operator keeps a copy, so they can sign anything they
// like straight to the ledger, and every on-chain policy above them is decorative. We do not do
// that, and there is deliberately no code path here that accepts a private key from outside.
//
// The only thing that can make this key sign anything is a PAY instruction, and the Flare TEE node
// only delivers instructions that came from the extension's registered instructionsSender — which
// is the policy contract. So: policy decides, enclave signs, operator watches.
type Extension struct {
	mu     sync.RWMutex
	Server *http.Server

	// signPort is the TEE node's RPC port.
	signPort int

	// xrplWallet is generated in-enclave by INIT. Nil until then.
	xrplWallet *wallet.Wallet

	// xrplClient submits signed transactions to the XRP Ledger.
	xrplClient *rpc.Client
}

// --- DO NOT MODIFY: New(), actionHandler() are boilerplate.
func New(extensionPort, signPort int) *Extension {
	e := &Extension{signPort: signPort}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /state", e.stateHandler)
	mux.HandleFunc("POST /action", e.actionHandler)

	e.Server = &http.Server{Addr: fmt.Sprintf(":%d", extensionPort), Handler: mux}
	return e
}

// stateHandler reports the XRPL address, never the key.
func (e *Extension) stateHandler(w http.ResponseWriter, r *http.Request) {
	e.mu.RLock()
	st := types.State{HasKey: e.xrplWallet != nil}
	if e.xrplWallet != nil {
		st.XrplAddress = string(e.xrplWallet.GetAddress())
	}
	e.mu.RUnlock()

	stateResponse := types.StateResponse{
		StateVersion: teeutils.ToHash(config.Version),
		State:        st,
	}

	if err := json.NewEncoder(w).Encode(stateResponse); err != nil {
		http.Error(w, fmt.Sprintf("sending response: %v", err), http.StatusInternalServerError)
		return
	}
}

func (e *Extension) processAction(action teetypes.Action) (int, []byte) {
	dataFixed, err := processorutils.Parse[instruction.DataFixed](action.Data.Message)
	if err != nil {
		return http.StatusBadRequest, []byte(fmt.Sprintf("decoding fixed data: %v", err))
	}

	switch {
	case dataFixed.OPType == teeutils.ToHash(config.OPTypeKeyless):
		return e.processKeyless(action, dataFixed)

	default:
		return http.StatusNotImplemented, []byte(fmt.Sprintf(
			"unsupported op type: received %s, expected %s (%s)",
			dataFixed.OPType.Hex(), teeutils.ToHash(config.OPTypeKeyless).Hex(), config.OPTypeKeyless,
		))
	}
}

// processKeyless routes KEYLESS_XRP instructions by OPCommand (INIT or PAY).
func (e *Extension) processKeyless(action teetypes.Action, df *instruction.DataFixed) (int, []byte) {
	switch {
	case df.OPCommand == teeutils.ToHash(config.OPCommandInit):
		ar := e.processInit(action, df)
		b, _ := json.Marshal(ar)
		return http.StatusOK, b

	case df.OPCommand == teeutils.ToHash(config.OPCommandPay):
		ar := e.processPay(action, df)
		b, _ := json.Marshal(ar)
		return http.StatusOK, b

	default:
		return http.StatusNotImplemented, []byte(fmt.Sprintf(
			"unsupported op command: received %s, expected one of [%s (%s), %s (%s)]",
			df.OPCommand.Hex(),
			teeutils.ToHash(config.OPCommandInit).Hex(), config.OPCommandInit,
			teeutils.ToHash(config.OPCommandPay).Hex(), config.OPCommandPay,
		))
	}
}

// processInit generates the XRPL key INSIDE the enclave and returns only its public address.
//
// There is no input to this command and no way to influence the key that comes out of it. The seed
// is drawn from the enclave's own entropy; the private key is held in memory here and is never
// written to disk, never logged, never returned, and never sent to the TEE node. The caller learns
// the r-address and nothing else.
//
// Idempotent: if a key already exists, the existing address is returned rather than replacing it.
// Overwriting would strand any funds already held at the old address.
func (e *Extension) processInit(action teetypes.Action, df *instruction.DataFixed) teetypes.ActionResult {
	e.mu.Lock()
	defer e.mu.Unlock()

	if e.xrplWallet == nil {
		w, err := wallet.New(xrplcrypto.SECP256K1())
		if err != nil {
			return buildResult(action, df, nil, 0, fmt.Errorf("key generation failed: %v", err))
		}
		e.xrplWallet = &w
	}

	addr := string(e.xrplWallet.GetAddress())

	encoded, err := abiEncodeString(addr)
	if err != nil {
		return buildResult(action, df, nil, 0, fmt.Errorf("ABI encoding failed: %v", err))
	}
	return buildResult(action, df, encoded, 1, nil)
}

// processPay signs and submits exactly one XRPL payment.
//
// Every field is taken from the instruction, which Flare's TEE node only delivers if it came from
// the extension's registered instructionsSender — the policy contract. The enclave therefore does
// not need to re-check the policy, and deliberately does not try to: the policy is the contract,
// and duplicating it here would just create a second place for the two to disagree.
//
// What the enclave DOES enforce is that it will not invent a payment of its own. There is no code
// path from "operator sends an HTTP request" to "a signature". The only caller of the signing key
// is this function, and this function only runs on an instruction that the chain already authorized.
func (e *Extension) processPay(action teetypes.Action, df *instruction.DataFixed) teetypes.ActionResult {
	e.mu.RLock()
	w := e.xrplWallet
	client := e.xrplClient
	e.mu.RUnlock()

	if w == nil {
		return buildResult(action, df, nil, 0, fmt.Errorf("no XRPL key: send an INIT instruction first"))
	}
	if len(df.OriginalMessage) == 0 {
		return buildResult(action, df, nil, 0, fmt.Errorf("originalMessage is empty"))
	}

	// Decode the payment the policy contract authorized (abi.encode of AuthorizedPayPolicy.XrplPayment).
	p, err := decodeXrplPayment(df.OriginalMessage)
	if err != nil {
		return buildResult(action, df, nil, 0, fmt.Errorf("decoding payment: %v", err))
	}
	if p.Amount == 0 {
		return buildResult(action, df, nil, 0, fmt.Errorf("zero amount"))
	}

	if client == nil {
		client, err = newXrplClient()
		if err != nil {
			return buildResult(action, df, nil, 0, fmt.Errorf("xrpl client: %v", err))
		}
		e.mu.Lock()
		e.xrplClient = client
		e.mu.Unlock()
	}

	// The payment reference goes in an XRPL memo. FAssets requires it to match the redemption's
	// paymentReference exactly, which is how the agent's payment is later matched to the request.
	payment := xrpltx.Payment{
		BaseTx: xrpltx.BaseTx{
			Account: xrpltypes.Address(w.GetAddress()),
			Memos: []xrpltypes.MemoWrapper{
				{
					Memo: xrpltypes.Memo{
						MemoData: hex.EncodeToString(p.PaymentReference[:]),
					},
				},
			},
		},
		Destination: xrpltypes.Address(p.Recipient),
		Amount:      xrpltypes.XRPCurrencyAmount(p.Amount),
	}

	flatTx := payment.Flatten()
	if err := client.Autofill(&flatTx); err != nil {
		return buildResult(action, df, nil, 0, fmt.Errorf("autofill: %v", err))
	}

	txBlob, _, err := w.Sign(flatTx)
	if err != nil {
		return buildResult(action, df, nil, 0, fmt.Errorf("signing failed: %v", err))
	}

	resp, err := client.SubmitTxBlobAndWait(txBlob, true)
	if err != nil {
		return buildResult(action, df, nil, 0, fmt.Errorf("submit: %v", err))
	}

	// Report the XRPL transaction hash back on-chain, so the payment is verifiable end to end.
	encoded, err := abiEncodeString(resp.Hash.String())
	if err != nil {
		return buildResult(action, df, nil, 0, fmt.Errorf("ABI encoding failed: %v", err))
	}
	return buildResult(action, df, encoded, 1, nil)
}

func newXrplClient() (*rpc.Client, error) {
	cfg, err := rpc.NewClientConfig(config.XrplRPCURL)
	if err != nil {
		return nil, err
	}
	return rpc.NewClient(cfg), nil
}

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
// The enclave is a KEYRING. It holds one XRPL private key per walletId, and every key is generated
// INSIDE this enclave (see processInit) and never leaves it. No key is delivered by an operator,
// decrypted from chain, or restorable from a backup. Nobody — not the person running this machine,
// not the authors — has ever seen one.
//
// This is the one thing that makes Keyless true rather than theatre. Flare's reference `fce-sign`
// extension takes the opposite approach: an operator generates a key off-chain, encrypts it, and
// ships it in via an UPDATE instruction. That operator keeps a copy, so they can sign anything they
// like straight to the ledger, and every on-chain policy above them is decorative. We do not do
// that, and there is deliberately no code path here that accepts a private key from outside.
//
// Many wallets can live in one enclave (one key per walletId), which is what makes Keyless
// multi-tenant: each user or agent gets its own XRPL account whose spending is bound by its own
// on-chain policy. The only thing that can make a key sign anything is a PAY (XRPSEND) instruction
// naming that walletId, and the Flare TEE node only delivers instructions that came from the
// extension's registered instructionsSender — the policy contract. So: policy decides which wallet
// pays what, the enclave signs, the operator watches.
type Extension struct {
	mu     sync.RWMutex
	Server *http.Server

	// signPort is the TEE node's RPC port.
	signPort int

	// wallets is the enclave keyring: walletId -> XRPL wallet, each generated in-enclave by INIT.
	wallets map[[32]byte]*wallet.Wallet

	// xrplClient submits signed transactions to the XRP Ledger (shared across wallets).
	xrplClient *rpc.Client
}

// --- DO NOT MODIFY: New(), actionHandler() are boilerplate.
func New(extensionPort, signPort int) *Extension {
	e := &Extension{signPort: signPort, wallets: make(map[[32]byte]*wallet.Wallet)}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /state", e.stateHandler)
	mux.HandleFunc("POST /action", e.actionHandler)

	e.Server = &http.Server{Addr: fmt.Sprintf(":%d", extensionPort), Handler: mux}
	return e
}

// stateHandler reports each wallet's XRPL address, never any key.
func (e *Extension) stateHandler(w http.ResponseWriter, r *http.Request) {
	e.mu.RLock()
	st := types.State{
		HasKey:  len(e.wallets) > 0,
		Wallets: make(map[string]string, len(e.wallets)),
	}
	for id, wlt := range e.wallets {
		addr := string(wlt.GetAddress())
		st.Wallets["0x"+hex.EncodeToString(id[:])] = addr
		st.XrplAddress = addr // back-compat: any one address
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

// processInit generates the XRPL key for one walletId INSIDE the enclave and returns only its
// public address.
//
// The only input is the walletId to create (abi.encode(bytes32) — see decodeWalletID). Nothing about
// the key itself can be influenced from outside: the seed is drawn from the enclave's own entropy;
// the private key is held in memory here and is never written to disk, never logged, never returned,
// and never sent to the TEE node. The caller learns the r-address and nothing else.
//
// Idempotent per walletId: if that wallet already exists, its address is returned rather than
// replaced. Overwriting would strand any funds held at the old address.
func (e *Extension) processInit(action teetypes.Action, df *instruction.DataFixed) teetypes.ActionResult {
	walletID, err := decodeWalletID(df.OriginalMessage)
	if err != nil {
		return buildResult(action, df, nil, 0, fmt.Errorf("decoding walletId: %v", err))
	}

	e.mu.Lock()
	defer e.mu.Unlock()

	w, ok := e.wallets[walletID]
	if !ok {
		nw, err := wallet.New(xrplcrypto.SECP256K1())
		if err != nil {
			return buildResult(action, df, nil, 0, fmt.Errorf("key generation failed: %v", err))
		}
		w = &nw
		e.wallets[walletID] = w
	}

	encoded, err := abiEncodeString(string(w.GetAddress()))
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

	// Select the key for THIS wallet. The policy put walletId in the instruction; a payment for a
	// wallet the enclave hasn't generated (no INIT) has nowhere to draw a key from.
	e.mu.RLock()
	w, ok := e.wallets[p.WalletID]
	client := e.xrplClient
	e.mu.RUnlock()

	if !ok {
		return buildResult(action, df, nil, 0,
			fmt.Errorf("no key for walletId 0x%x: send an INIT instruction for it first", p.WalletID))
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

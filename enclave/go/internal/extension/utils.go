package extension

import (
	"encoding/json"
	"fmt"
	"math"
	"math/big"
	"net/http"

	"keyless-extension/internal/config"

	"github.com/flare-foundation/go-flare-common/pkg/logger"
	"github.com/flare-foundation/go-flare-common/pkg/tee/instruction"
	teetypes "github.com/flare-foundation/tee-node/pkg/types"

	"github.com/ethereum/go-ethereum/accounts/abi"
)

// NOTE: the upstream fce-sign example had decryptViaNode() and parseSecp256k1PrivateKey() here, to
// support an UPDATE_KEY instruction that imports an operator-supplied private key. Both are gone on
// purpose. If no code can import a key, then no operator can have kept a copy of one — the guarantee
// becomes structural rather than a promise. Do not add them back.

func (e *Extension) actionHandler(w http.ResponseWriter, r *http.Request) {
	var action teetypes.Action
	err := json.NewDecoder(r.Body).Decode(&action)
	if err != nil {
		http.Error(w, fmt.Sprintf("decoding action: %v", err), http.StatusBadRequest)
		return
	}

	logger.Infof("received action, ID: %s", action.Data.ID)

	status, body := e.processAction(action)

	logger.Infof("sending action result, ID: %s, status: %d, log: %s", action.Data.ID, status, getLogFromBody(body))

	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func buildResult(a teetypes.Action, df *instruction.DataFixed, data []byte, status uint8, err error) teetypes.ActionResult {
	ar := teetypes.ActionResult{
		ID:            a.Data.ID,
		SubmissionTag: a.Data.SubmissionTag,
		Version:       config.Version,
		OPType:        df.OPType,
		OPCommand:     df.OPCommand,
		Data:          data,
		Status:        status,
	}
	switch status {
	case 0:
		ar.Log = fmt.Sprintf("error: %v", err)
	case 1:
		ar.Log = "ok"
	}
	return ar
}

func getLogFromBody(body []byte) string {
	var ar teetypes.ActionResult
	if err := json.Unmarshal(body, &ar); err != nil {
		return string(body)
	}
	return ar.Log
}

// --- the payment the policy contract authorized ---

// XrplPayment mirrors AuthorizedPayPolicy.XrplPayment in backend/src/AuthorizedPayPolicy.sol.
// Keep the two in lockstep: the contract abi.encode()s that struct into the instruction message,
// and this is what decodes it.
type XrplPayment struct {
	WalletID         [32]byte
	Recipient        string
	Amount           uint64 // XRPL drops
	PaymentReference [32]byte
}

// abiXrplPayment is the decode target. Field names must match the tuple component names.
type abiXrplPayment struct {
	WalletId         [32]byte //nolint:revive // must match the Solidity component name
	Recipient        string
	Amount           *big.Int
	PaymentReference [32]byte
}

func xrplPaymentArgs() (abi.Arguments, error) {
	t, err := abi.NewType("tuple", "", []abi.ArgumentMarshaling{
		{Name: "walletId", Type: "bytes32"},
		{Name: "recipient", Type: "string"},
		{Name: "amount", Type: "uint256"},
		{Name: "paymentReference", Type: "bytes32"},
	})
	if err != nil {
		return nil, err
	}
	return abi.Arguments{{Type: t}}, nil
}

// decodeWalletID reads the walletId an INIT instruction targets. The policy sends it as
// abi.encode(bytes32 walletId), which is exactly the 32-byte value. Multiple wallets can be
// generated in the same enclave, one key per walletId — that is what makes Keyless multi-tenant
// (each user/agent gets its own rule-bound XRPL account) without ever exposing a key.
func decodeWalletID(message []byte) ([32]byte, error) {
	var id [32]byte
	if len(message) < 32 {
		return id, fmt.Errorf("INIT message too short for walletId: got %d bytes, need 32", len(message))
	}
	copy(id[:], message[:32])
	if id == ([32]byte{}) {
		return id, fmt.Errorf("walletId is zero")
	}
	return id, nil
}

// decodeXrplPayment decodes abi.encode(AuthorizedPayPolicy.XrplPayment) from the instruction message.
func decodeXrplPayment(message []byte) (*XrplPayment, error) {
	args, err := xrplPaymentArgs()
	if err != nil {
		return nil, err
	}

	values, err := args.Unpack(message)
	if err != nil {
		return nil, fmt.Errorf("unpack: %w", err)
	}
	if len(values) != 1 {
		return nil, fmt.Errorf("expected 1 value, got %d", len(values))
	}

	decoded, ok := abi.ConvertType(values[0], new(abiXrplPayment)).(*abiXrplPayment)
	if !ok || decoded == nil {
		return nil, fmt.Errorf("unexpected payment encoding")
	}

	if decoded.Amount == nil {
		return nil, fmt.Errorf("amount is nil")
	}
	// XRPL amounts are drops in a signed 64-bit field; anything larger is not a payment we can make.
	if !decoded.Amount.IsUint64() || decoded.Amount.Uint64() > math.MaxInt64 {
		return nil, fmt.Errorf("amount out of range: %s", decoded.Amount.String())
	}
	if decoded.Recipient == "" {
		return nil, fmt.Errorf("recipient is empty")
	}

	return &XrplPayment{
		WalletID:         decoded.WalletId,
		Recipient:        decoded.Recipient,
		Amount:           decoded.Amount.Uint64(),
		PaymentReference: decoded.PaymentReference,
	}, nil
}

// --- ABI encoding of results ---

// abiEncodeString ABI-encodes a single string, so the on-chain state verifier can read it back.
func abiEncodeString(s string) ([]byte, error) {
	t, err := abi.NewType("string", "", nil)
	if err != nil {
		return nil, err
	}
	return abi.Arguments{{Type: t}}.Pack(s)
}

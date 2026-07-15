package extension

import (
	"encoding/hex"
	"testing"
)

// goldenPayment is the EXACT output of Solidity's
//
//	abi.encode(AuthorizedPayPolicy.XrplPayment{
//	    walletId:         bytes32("wallet-1"),
//	    recipient:        "rREDEEMERaddressYYYYYYYYYYYYYYYYYYY",
//	    amount:           4_900_000,
//	    paymentReference: bytes32("redref"),
//	})
//
// produced with `cast abi-encode "f((bytes32,string,uint256,bytes32))" ...`.
//
// This is the wire format between the policy contract and this enclave. If the two ever disagree,
// the enclave signs a payment nobody authorized — or, more likely, refuses to sign a legitimate
// redemption and the agent silently defaults. Pin it with a golden vector rather than trusting that
// two ABI implementations in two languages agree.
const goldenPayment = "0000000000000000000000000000000000000000000000000000000000000020" +
	"77616c6c65742d31000000000000000000000000000000000000000000000000" +
	"0000000000000000000000000000000000000000000000000000000000000080" +
	"00000000000000000000000000000000000000000000000000000000004ac4a0" +
	"7265647265660000000000000000000000000000000000000000000000000000" +
	"0000000000000000000000000000000000000000000000000000000000000023" +
	"7252454445454d45526164647265737359595959595959595959595959595959" +
	"5959590000000000000000000000000000000000000000000000000000000000"

func TestDecodeXrplPayment_MatchesSolidityEncoding(t *testing.T) {
	raw, err := hex.DecodeString(goldenPayment)
	if err != nil {
		t.Fatalf("bad golden hex: %v", err)
	}

	p, err := decodeXrplPayment(raw)
	if err != nil {
		t.Fatalf("decode failed: %v", err)
	}

	if got, want := p.Recipient, "rREDEEMERaddressYYYYYYYYYYYYYYYYYYY"; got != want {
		t.Errorf("recipient = %q, want %q", got, want)
	}
	if got, want := p.Amount, uint64(4_900_000); got != want {
		t.Errorf("amount = %d, want %d", got, want)
	}
	if got, want := string(trimRight(p.WalletID[:])), "wallet-1"; got != want {
		t.Errorf("walletId = %q, want %q", got, want)
	}
	if got, want := string(trimRight(p.PaymentReference[:])), "redref"; got != want {
		t.Errorf("paymentReference = %q, want %q", got, want)
	}
}

func TestDecodeXrplPayment_RejectsGarbage(t *testing.T) {
	if _, err := decodeXrplPayment([]byte{0x01, 0x02, 0x03}); err == nil {
		t.Fatal("expected error on malformed message, got nil")
	}
}

func TestDecodeXrplPayment_RejectsEmptyRecipient(t *testing.T) {
	// Same shape as the golden vector but with a zero-length recipient string.
	raw, _ := hex.DecodeString(
		"0000000000000000000000000000000000000000000000000000000000000020" +
			"77616c6c65742d31000000000000000000000000000000000000000000000000" +
			"0000000000000000000000000000000000000000000000000000000000000080" +
			"00000000000000000000000000000000000000000000000000000000004ac4a0" +
			"7265647265660000000000000000000000000000000000000000000000000000" +
			"0000000000000000000000000000000000000000000000000000000000000000",
	)
	if _, err := decodeXrplPayment(raw); err == nil {
		t.Fatal("expected error on empty recipient, got nil")
	}
}

func trimRight(b []byte) []byte {
	i := len(b)
	for i > 0 && b[i-1] == 0 {
		i--
	}
	return b[:i]
}

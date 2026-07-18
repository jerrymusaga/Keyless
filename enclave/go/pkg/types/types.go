// Package types contains types useful to other apps interacting with the Keyless extension.
package types

import "github.com/ethereum/go-ethereum/common"

// State holds the extension's observable state, returned by GET /state.
//
// The enclave is a KEYRING: it holds one XRPL key per walletId, each generated in-enclave by an
// INIT instruction. Wallets maps walletId (0x-hex) -> the classic r-address of that wallet's key.
// HasKey/XrplAddress are kept for back-compat and reflect whether any wallet exists (and one of the
// addresses); prefer Wallets.
//
// No private key is EVER exposed here or anywhere else. Every key is generated inside the enclave
// and never leaves it — that is the entire premise of Keyless. Anyone (including whoever runs this
// machine) can read this endpoint and learn only what is already public on the XRP Ledger.
type State struct {
	HasKey      bool              `json:"hasKey"`
	XrplAddress string            `json:"xrplAddress"`
	Wallets     map[string]string `json:"wallets"`
}

// --- DO NOT MODIFY below this line. ---

// StateResponse is the envelope returned by GET /state.
type StateResponse struct {
	StateVersion common.Hash `json:"stateVersion"`
	State        State       `json:"state"`
}

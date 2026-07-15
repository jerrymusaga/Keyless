// Package types contains types useful to other apps interacting with the Keyless extension.
package types

import "github.com/ethereum/go-ethereum/common"

// State holds the extension's observable state, returned by GET /state.
//
// HasKey reports whether the enclave has generated its XRPL key yet (INIT). XrplAddress is the
// public classic address of that key.
//
// The private key is NEVER exposed here or anywhere else. It is generated inside the enclave and
// never leaves it — that is the entire premise of Keyless. Anyone (including whoever runs this
// machine) can read this endpoint and learn only what is already public on the XRP Ledger.
type State struct {
	HasKey      bool   `json:"hasKey"`
	XrplAddress string `json:"xrplAddress"`
}

// --- DO NOT MODIFY below this line. ---

// StateResponse is the envelope returned by GET /state.
type StateResponse struct {
	StateVersion common.Hash `json:"stateVersion"`
	State        State       `json:"state"`
}

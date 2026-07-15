// Package config contains configuration values and defaults used by the Keyless extension.
package config

import (
	"os"
	"strconv"
	"time"
)

const (
	Version = "0.1.0"

	// OPType and OPCommand strings — MUST match the bytes32 constants in
	// backend/src/AuthorizedPayPolicy.sol (OP_TYPE / OP_PAY).
	//
	// KEYLESS_XRP is deliberately NOT one of Flare's system op types: those are reserved for
	// extension 0, and InstructionsFacet rejects them from non-system instruction senders.
	OPTypeKeyless = "KEYLESS_XRP"

	// OPCommandInit makes the enclave generate its OWN XRPL key and return only the address.
	OPCommandInit = "INIT"

	// OPCommandPay makes the enclave sign and submit exactly one XRPL payment.
	OPCommandPay = "PAY"

	TimeoutShutdown = 5 * time.Second
)

// Defaults — overridden by env vars in init().
var (
	ExtensionPort = 7702
	SignPort      = 7701
	ConfigPort    = 5501

	// XrplRPCURL is the XRPL node the enclave submits signed transactions to.
	XrplRPCURL = "https://s.altnet.rippletest.net:51234/"
)

func init() {
	if v := os.Getenv("EXTENSION_PORT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			ExtensionPort = n
		}
	}
	if v := os.Getenv("SIGN_PORT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			SignPort = n
		}
	}
	if v := os.Getenv("CONFIG_PORT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			ConfigPort = n
		}
	}
	if v := os.Getenv("XRPL_RPC_URL"); v != "" {
		XrplRPCURL = v
	}
}

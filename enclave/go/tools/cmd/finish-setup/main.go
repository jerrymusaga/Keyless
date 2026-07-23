// Command finish-setup completes extension setup steps 3 & 4 that register-extension
// aborted when it FATAL'd on a stale-ABI event parse (the on-chain txs in step 2 had
// already succeeded, but the crash skipped the remaining steps).
//
// It is idempotent and does NOT touch Register() (step 1), so it will not mint a new
// extension. It calls the raw binding transactors + CheckTx only — no event parsing —
// so the stale event ABIs cannot break it.
//
//	go run ./cmd/finish-setup -a <addresses.json> -c <rpc> -id <extensionId>
package main

import (
	"context"
	"flag"
	"math/big"

	"keyless-extension/tools/pkg/configs"
	"keyless-extension/tools/pkg/fccutils"
	"keyless-extension/tools/pkg/support"

	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/flare-foundation/go-flare-common/pkg/logger"
	"github.com/flare-foundation/tee-node/pkg/wallets"
)

func main() {
	af := flag.String("a", configs.AddressesFile, "file with deployed addresses")
	cf := flag.String("c", configs.ChainNodeURL, "chain node url")
	idF := flag.Int64("id", 0, "extension id")
	flag.Parse()

	if *idF == 0 {
		logger.Fatal("must pass -id <extensionId>")
	}
	extID := big.NewInt(*idF)

	s, err := support.DefaultSupport(*af, *cf)
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	deployer := crypto.PubkeyToAddress(s.Prv.PublicKey)
	logger.Infof("Extension: %s  Deployer: %s", extID.String(), deployer.Hex())

	callOpts := &bind.CallOpts{From: deployer, Context: context.Background()}

	// --- Step 3: allow the deployer as a wallet project (manager) owner ---
	isPO, err := s.TeeOwnerAllowlist.IsAllowedTeeWalletProjectOwner(callOpts, extID, deployer)
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	if isPO {
		logger.Info("Step 3: deployer already a wallet project owner — skip")
	} else {
		opts, err := bind.NewKeyedTransactorWithChainID(s.Prv, s.ChainID)
		if err != nil {
			fccutils.FatalWithCause(err)
		}
		tx, err := s.TeeOwnerAllowlist.AddAllowedTeeWalletProjectOwners(opts, extID, []common.Address{deployer})
		if err != nil {
			fccutils.FatalWithCause(err)
		}
		if _, err := support.CheckTx(tx, s.ChainClient); err != nil {
			fccutils.FatalWithCause(err)
		}
		logger.Infof("Step 3: added wallet project owner (tx %s)", tx.Hash().Hex())
	}

	// --- Step 4: allow the EVM (secp256k1) key type on the extension ---
	isKT, err := s.TeeExtensionRegistry.IsKeyTypeSupported(callOpts, extID, wallets.EVMType)
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	if isKT {
		logger.Info("Step 4: EVM key type already supported — skip")
	} else {
		opts, err := bind.NewKeyedTransactorWithChainID(s.Prv, s.ChainID)
		if err != nil {
			fccutils.FatalWithCause(err)
		}
		tx, err := s.TeeExtensionRegistry.AddSupportedKeyTypes(opts, extID, [][32]byte{wallets.EVMType})
		if err != nil {
			fccutils.FatalWithCause(err)
		}
		if _, err := support.CheckTx(tx, s.ChainClient); err != nil {
			fccutils.FatalWithCause(err)
		}
		logger.Infof("Step 4: added EVM key type (tx %s)", tx.Hash().Hex())
	}

	logger.Info("finish-setup done.")
}

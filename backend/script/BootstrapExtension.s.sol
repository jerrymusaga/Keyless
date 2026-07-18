// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Script, console2} from "forge-std/Script.sol";
import {IFlareTeeManager} from "../src/interfaces/IFlareTeeManager.sol";

/// @notice Stand up the Keyless TEE extension on Flare Confidential Compute.
///
/// @dev This is step 1 of the build and the load-bearing one: it proves the whole chain is open to
///      us. Every call here is permissionless or self-authorized — none of it needs Flare governance.
///      (Contrast with the abandoned PMW path, where `TeePayments.addPMWMultisigAccount` requires the
///      wallet's project to be on extension 0, the governance-owned system extension. That gate is
///      why we run our own extension instead.)
///
///      What this script does, in order:
///        1. register()                       → we own a fresh extension id
///        2. addAllowedTeeMachineOwners       → we may register TEE machines under it
///        3. addAllowedTeeWalletProjectOwners → we may create wallet projects under it
///        4. addSupportedKeyTypes([XRP])      → its wallets may hold XRPL keys
///        5. addTeeVersion(codeHash, [TEST_PLATFORM]) → the trust anchor: only this image may join
///
///      Run:
///        forge script script/BootstrapExtension.s.sol:BootstrapExtension \
///          --rpc-url $COSTON2_RPC --broadcast --private-key $PK
///
///      Then put the printed EXTENSION_ID in .env — the wallet + policy scripts need it.
contract BootstrapExtension is Script {
    /// @notice Flare's TEE manager diamond on Coston2. All facets are reached through this address.
    address constant FLARE_TEE_MANAGER = 0x004224fa1BF1Acd3D233f011FB03b8dd5fA5d41F;

    /// @notice System-supported key type for XRPL keys. (`getSystemSupportedKeyTypes()` → [XRP, EVM])
    bytes32 constant KEY_TYPE_XRP = bytes32("XRP");

    /// @notice The only signing algo Flare supports for XRP keys — and the one XRPL itself uses.
    /// @dev From `getSystemSupportedSigningAlgos(XRP)`.
    bytes32 constant SIGNING_ALGO_XRP = bytes32("sha512half-secp256k1-ecdsa");

    /// @notice Attestation platform. TEST_PLATFORM needs no TDX/SEV hardware — live third-party
    ///         machines run on it today (some behind ngrok), which is what makes a demo feasible.
    ///         Swap for GCP_INTEL_TDX / GCP_AMD_SEV in production.
    bytes32 constant PLATFORM_TEST = bytes32("TEST_PLATFORM");
    bytes32 constant PLATFORM_GCP_INTEL_TDX = bytes32("GCP_INTEL_TDX");

    /// @notice Code hash of the reference FCE image (`flare-foundation/fce-sign`), as run by the live
    ///         third-party machines on Coston2. Override with TEE_CODE_HASH once our fork is built —
    ///         a machine can only join if it attests to a code hash registered here.
    bytes32 constant REFERENCE_CODE_HASH =
        0x194844cf417dde867073e5ab7199fa4d21fd82b5dbe2bdea8b3d7fc18d10fdc2;

    /// @dev Observed as bytes32(0) on the live third-party extensions.
    bytes32 constant GOVERNANCE_HASH = bytes32(0);

    function run() external {
        IFlareTeeManager tee = IFlareTeeManager(FLARE_TEE_MANAGER);

        address owner = msg.sender;
        bytes32 codeHash = vm.envOr("TEE_CODE_HASH", REFERENCE_CODE_HASH);
        string memory version = vm.envOr("TEE_VERSION", string("keyless-v1"));

        // The extension's instructions sender is the ONLY address its TEE machines will obey. That
        // will be the policy contract, but it isn't deployed yet — and register() rejects address(0).
        // So we park it on the deployer and rebind with setExtensionContracts() after deploying the
        // policy. Until it is rebound, nothing can instruct our machines but us.
        address instructionsSender = vm.envOr("EXT_INSTRUCTIONS_SENDER", owner);
        address stateVerifier = vm.envOr("EXT_STATE_VERIFIER", address(0));

        vm.startBroadcast();

        uint256 extensionId = tee.register(stateVerifier, instructionsSender);

        address[] memory owners = new address[](1);
        owners[0] = owner;
        tee.addAllowedTeeMachineOwners(extensionId, owners);
        tee.addAllowedTeeWalletProjectOwners(extensionId, owners);

        bytes32[] memory keyTypes = new bytes32[](1);
        keyTypes[0] = KEY_TYPE_XRP;
        tee.addSupportedKeyTypes(extensionId, keyTypes);

        bytes32[] memory platforms = new bytes32[](1);
        platforms[0] = PLATFORM_TEST;
        tee.addTeeVersion(extensionId, version, codeHash, platforms, GOVERNANCE_HASH);

        vm.stopBroadcast();

        // Read the state back rather than trusting that the writes did what we think.
        require(tee.getExtensionOwner(extensionId) == owner, "not extension owner");
        require(tee.isAllowedTeeMachineOwner(extensionId, owner), "machine owner not allowed");
        require(tee.isAllowedTeeWalletProjectOwner(extensionId, owner), "project owner not allowed");
        require(
            tee.isCodeHashPlatformSupported(extensionId, codeHash, PLATFORM_TEST),
            "code hash / platform not registered"
        );

        console2.log("=== Keyless extension is live ===");
        console2.log("EXTENSION_ID       :", extensionId);
        console2.log("owner              :", owner);
        console2.log("instructionsSender :", instructionsSender, "(placeholder - rebind to the policy)");
        console2.log("code hash          :", vm.toString(codeHash));
        console2.log("platform           : TEST_PLATFORM");
        console2.log("");
        console2.log("Put EXTENSION_ID=%s in backend/.env, then:", vm.toString(extensionId));
        console2.log("  1. run a TEE machine on the registered code hash, register it, toProduction()");
        console2.log("  2. CreateWallet.s.sol      - project + wallet (TEE generates the XRPL key)");
        console2.log("  3. deploy the policy, then setExtensionContracts() to bind it as the sender");
    }
}

/// @notice Bind the extension to the deployed KeylessAccounts manager.
/// @dev Run AFTER KeylessAccounts is deployed. From this point KeylessAccounts is the only thing on
///      earth that can instruct our TEE machines — which is the entire Keyless guarantee. Once bound,
///      createWallet() can send INIT and pay() can send XRPSEND.
contract BindPolicy is Script {
    address constant FLARE_TEE_MANAGER = 0x004224fa1BF1Acd3D233f011FB03b8dd5fA5d41F;

    function run() external {
        IFlareTeeManager tee = IFlareTeeManager(FLARE_TEE_MANAGER);

        uint256 extensionId = vm.envUint("EXTENSION_ID");
        address accounts = vm.envAddress("KEYLESS_ACCOUNTS");
        // We don't run an on-chain state verifier; the authorization guarantee is the manager + rules.
        address verifier = vm.envOr("KEYLESS_VERIFIER", address(0));

        vm.startBroadcast();
        tee.setExtensionContracts(extensionId, verifier, accounts);
        vm.stopBroadcast();

        require(
            tee.getTeeExtensionInstructionsSender(extensionId) == accounts,
            "KeylessAccounts is not the instructions sender"
        );

        console2.log("Extension %s is now driven ONLY by KeylessAccounts %s", extensionId, accounts);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Script, console2} from "forge-std/Script.sol";
import {KeylessAccounts} from "../src/KeylessAccounts.sol";
import {AllowlistRule} from "../src/rules/AllowlistRule.sol";
import {RateLimitRule} from "../src/rules/RateLimitRule.sol";
import {SubscriptionRule} from "../src/rules/SubscriptionRule.sol";
import {FdcEscrowRule} from "../src/rules/FdcEscrowRule.sol";
import {ITeeExtensionRegistry} from "../src/interfaces/ITeeExtensionRegistry.sol";
import {ITeeMachineRegistry} from "../src/interfaces/ITeeMachineRegistry.sol";

/// @notice Deploys the Keyless product: the multi-tenant account manager + the four rule modules.
///
/// @dev Deploy order (updated fce-sign scaffold — the registry split + id-discovery model):
///   1. Deploy this: KeylessAccounts (as the extension's instruction sender) + the rule modules.
///   2. Register the extension via the fce-sign flow (`pre-build.sh`) with KeylessAccounts as the
///      instructions sender — this assigns a public extension id (>= 0x10000) and binds it.
///   3. Call `KeylessAccounts.setExtensionId()` once so the contract discovers + caches its id.
///   4. Run a TEE machine on the registered code hash (`register-tee -command rRap`).
///
///   The registry addresses (TEE_EXTENSION_REGISTRY / TEE_MACHINE_REGISTRY) are resolved by the
///   fce-sign deploy tooling for the target chain; pass them here as env vars.
contract DeployKeyless is Script {
    /// @dev Flare's FdcVerification on Coston2. Override via FDC_VERIFICATION for another network.
    address constant FDC_VERIFICATION_COSTON2 = 0x906507E0B64bcD494Db73bd0459d1C667e14B933;

    function run() external {
        address extReg = vm.envAddress("TEE_EXTENSION_REGISTRY");
        address machReg = vm.envAddress("TEE_MACHINE_REGISTRY");
        address claimBack = vm.envOr("CLAIM_BACK", msg.sender);
        address fdc = vm.envOr("FDC_VERIFICATION", FDC_VERIFICATION_COSTON2);
        // The enclave relayer key that reports XRPL addresses on-chain. Defaults to the deployer.
        address reporter = vm.envOr("ENCLAVE_REPORTER", msg.sender);

        vm.startBroadcast();
        KeylessAccounts accounts = new KeylessAccounts(
            ITeeExtensionRegistry(extReg), ITeeMachineRegistry(machReg), claimBack, reporter
        );
        AllowlistRule allowlist = new AllowlistRule(address(accounts));
        RateLimitRule rateLimit = new RateLimitRule(address(accounts));
        SubscriptionRule subscription = new SubscriptionRule(address(accounts));
        FdcEscrowRule escrow = new FdcEscrowRule(address(accounts), fdc);
        vm.stopBroadcast();

        console2.log("=== Keyless deployed ===");
        console2.log("KeylessAccounts  :", address(accounts));
        console2.log("AllowlistRule    :", address(allowlist));
        console2.log("RateLimitRule    :", address(rateLimit));
        console2.log("SubscriptionRule :", address(subscription));
        console2.log("FdcEscrowRule    :", address(escrow));
        console2.log("Enclave reporter :", reporter);
        console2.log("");
        console2.log("Next: register the extension (fce-sign pre-build) with KeylessAccounts as the");
        console2.log("instructions sender, then call KeylessAccounts.setExtensionId().");
    }
}

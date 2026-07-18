// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Script, console2} from "forge-std/Script.sol";
import {KeylessAccounts} from "../src/KeylessAccounts.sol";
import {AllowlistRule} from "../src/rules/AllowlistRule.sol";
import {RateLimitRule} from "../src/rules/RateLimitRule.sol";
import {SubscriptionRule} from "../src/rules/SubscriptionRule.sol";
import {FdcEscrowRule} from "../src/rules/FdcEscrowRule.sol";
import {IFlareTeeManager} from "../src/interfaces/IFlareTeeManager.sol";

/// @notice Deploys the Keyless product: the multi-tenant account manager + the three rule modules.
///
/// @dev Deploy order for the whole system:
///   1. BootstrapExtension.s.sol       -> EXTENSION_ID (register our own FCE extension)
///   2. run a TEE machine on the code hash -> register it -> toProduction()
///   3. Deploy.s.sol (this file)        -> KeylessAccounts + rules; put KEYLESS_ACCOUNTS in .env
///   4. BootstrapExtension.s.sol:BindPolicy -> make KeylessAccounts the extension's instructionsSender
///
///   After that a user (or the UI) calls createWallet() — which itself sends the INIT that makes the
///   enclave generate that wallet's key. No separate INIT step, no rebinding dance.
contract DeployKeyless is Script {
    address constant FLARE_TEE_MANAGER = 0x004224fa1BF1Acd3D233f011FB03b8dd5fA5d41F;
    /// @dev Flare's FdcVerification on Coston2. Override via FDC_VERIFICATION for another network.
    address constant FDC_VERIFICATION_COSTON2 = 0x906507E0B64bcD494Db73bd0459d1C667e14B933;

    function run() external {
        uint256 extensionId = vm.envUint("EXTENSION_ID");
        address claimBack = vm.envOr("CLAIM_BACK", msg.sender);
        address fdc = vm.envOr("FDC_VERIFICATION", FDC_VERIFICATION_COSTON2);

        vm.startBroadcast();
        KeylessAccounts accounts =
            new KeylessAccounts(IFlareTeeManager(FLARE_TEE_MANAGER), extensionId, claimBack);
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
        console2.log("");
        console2.log("Next: KEYLESS_ACCOUNTS=%s in .env, then run BindPolicy", vm.toString(address(accounts)));
        console2.log("Then createWallet() creates an account and sends its own INIT.");
    }
}

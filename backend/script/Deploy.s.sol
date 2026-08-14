// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Script, console2} from "forge-std/Script.sol";
import {KeylessAccounts} from "../src/KeylessAccounts.sol";
import {ExchangeRule} from "../src/rules/ExchangeRule.sol";
import {RateLimitRule} from "../src/rules/RateLimitRule.sol";
import {ScheduledRule} from "../src/rules/ScheduledRule.sol";
import {ConditionalRule} from "../src/rules/ConditionalRule.sol";
import {FxrpRule} from "../src/rules/FxrpRule.sol";
import {ITeeExtensionRegistry} from "../src/interfaces/ITeeExtensionRegistry.sol";
import {ITeeMachineRegistry} from "../src/interfaces/ITeeMachineRegistry.sol";

/// @notice Deploys Keyless: the multi-tenant account manager + the five live policies.
///
/// @dev Deploy order (the fce-sign scaffold's registry-split + id-discovery model):
///   1. Deploy this: KeylessAccounts (the extension's instructions sender) + the rule modules.
///   2. Register the extension via the fce-sign flow (`enclave/scripts/pre-build.sh`) with
///      KeylessAccounts as the instructions sender — this assigns a public extension id (>= 0x10000)
///      and binds it.
///   3. Call `KeylessAccounts.setExtensionId()` once so the contract discovers + caches its id.
///   4. Run a TEE machine on the registered code hash (`register-tee -command rRap`).
///
///   The registry addresses (TEE_EXTENSION_REGISTRY / TEE_MACHINE_REGISTRY) are resolved by the
///   fce-sign deploy tooling for the target chain; pass them here as env vars.
///
///   AllowlistRule and SubscriptionRule are NOT deployed here. They are retired — strict subsets of
///   ExchangeRule and RateLimitRule — and their sources are kept only because live accounts still point
///   at the deployed copies. See the note at the top of each.
contract DeployKeyless is Script {
    /// @dev Flare's FdcVerification on Coston2. Override via FDC_VERIFICATION for another network.
    address constant FDC_VERIFICATION_COSTON2 = 0x906507E0B64bcD494Db73bd0459d1C667e14B933;
    /// @dev Flare Smart Accounts diamond on Coston2. Override via FSA_DIAMOND.
    address constant FSA_DIAMOND_COSTON2 = 0x434936d47503353f06750Db1A444DBDC5F0AD37c;
    /// @dev FAssets Core Vault — where an XRPL payment must land to mint FXRP. Override via CORE_VAULT.
    string constant CORE_VAULT_COSTON2 = "rDhpmiPq4BVBDWMVdSrmkgt8thKyRzGV1p";
    /// @dev Flare Smart Accounts' XRPL provider wallet — every FSA instruction is a payment here,
    ///      carrying the instruction in its reference. Override via FSA_PROVIDER_WALLET.
    string constant FSA_PROVIDER_WALLET_COSTON2 = "rEyj8nsHLdgt79KJWzXR5BgF7ZbaohbXwq";
    /// @dev Cap on the XRPL trigger payment for an FSA instruction, in drops (10 XRP). The trigger is a
    ///      messaging cost, not the value being moved, so it should stay small. Override via
    ///      FXRP_MAX_TRIGGER; 0 means uncapped.
    uint256 constant FXRP_MAX_TRIGGER = 10_000_000;

    function run() external {
        address extReg = vm.envAddress("TEE_EXTENSION_REGISTRY");
        address machReg = vm.envAddress("TEE_MACHINE_REGISTRY");
        address claimBack = vm.envOr("CLAIM_BACK", msg.sender);
        address fdc = vm.envOr("FDC_VERIFICATION", FDC_VERIFICATION_COSTON2);
        address fsa = vm.envOr("FSA_DIAMOND", FSA_DIAMOND_COSTON2);
        string memory coreVault = vm.envOr("CORE_VAULT", CORE_VAULT_COSTON2);
        string memory fsaWallet = vm.envOr("FSA_PROVIDER_WALLET", FSA_PROVIDER_WALLET_COSTON2);
        uint256 maxTrigger = vm.envOr("FXRP_MAX_TRIGGER", FXRP_MAX_TRIGGER);
        // The enclave relayer key that reports XRPL addresses on-chain. Defaults to the deployer.
        address reporter = vm.envOr("ENCLAVE_REPORTER", msg.sender);

        vm.startBroadcast();
        KeylessAccounts accounts = new KeylessAccounts(
            ITeeExtensionRegistry(extReg), ITeeMachineRegistry(machReg), claimBack, reporter
        );
        ExchangeRule exchange = new ExchangeRule(address(accounts));
        RateLimitRule rateLimit = new RateLimitRule(address(accounts));
        ScheduledRule scheduled = new ScheduledRule(address(accounts));
        ConditionalRule conditional = new ConditionalRule(address(accounts), fdc);
        FxrpRule fxrp = new FxrpRule(address(accounts), coreVault, fsaWallet, fsa, maxTrigger);
        vm.stopBroadcast();

        console2.log("=== Keyless deployed ===");
        console2.log("KeylessAccounts  :", address(accounts));
        console2.log("ExchangeRule     :", address(exchange));
        console2.log("RateLimitRule    :", address(rateLimit));
        console2.log("ScheduledRule    :", address(scheduled));
        console2.log("ConditionalRule  :", address(conditional));
        console2.log("FxrpRule         :", address(fxrp));
        console2.log("Enclave reporter :", reporter);
        console2.log("");
        console2.log("Next: register the extension (fce-sign pre-build) with KeylessAccounts as the");
        console2.log("instructions sender, then call KeylessAccounts.setExtensionId().");
    }
}

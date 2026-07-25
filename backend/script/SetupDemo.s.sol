// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Script, console2} from "forge-std/Script.sol";
import {KeylessAccounts} from "../src/KeylessAccounts.sol";
import {AllowlistRule} from "../src/rules/AllowlistRule.sol";
import {RateLimitRule} from "../src/rules/RateLimitRule.sol";
import {SubscriptionRule} from "../src/rules/SubscriptionRule.sol";
import {FdcEscrowRule} from "../src/rules/FdcEscrowRule.sol";

/// @notice Creates the four demo accounts the public no-login showcase (/see) dry-runs against. Each is
///         a real on-chain account owned by the deployer, configured with a rule so the showcase's
///         read-only `authorize` calls produce genuine verdicts. No XRP is funded and the enclave is not
///         needed — the showcase only reads rule config.
///
/// @dev Fixed salts, so walletIds are deterministic. Re-running reverts WalletExists (change salts to
///      reset). Prints the four walletIds to hardcode in the frontend.
contract SetupDemo is Script {
    // Demo destinations (any string is valid on-chain; the rule stores keccak of it).
    string constant EXCHANGE = "rw15KUmEBEERnbNFys2gVpc26FTABwVDMC";
    string constant MERCHANT = "randbAijaVXWYaMxLEvSv8twud84xUF3dv";

    function run() external {
        KeylessAccounts accounts = KeylessAccounts(vm.envAddress("KEYLESS_ACCOUNTS"));
        AllowlistRule allowlist = AllowlistRule(vm.envAddress("ALLOWLIST_RULE"));
        RateLimitRule rateLimit = RateLimitRule(vm.envAddress("RATELIMIT_RULE"));
        SubscriptionRule subscription = SubscriptionRule(vm.envAddress("SUBSCRIPTION_RULE"));
        FdcEscrowRule escrow = FdcEscrowRule(vm.envAddress("ESCROW_RULE"));

        // Instruction fee to attach; excess refunds to claimBack. Override via INIT_FEE if the chain's
        // fee differs. (The scaffold dropped on-chain fee quoting.)
        uint256 initFee = vm.envOr("INIT_FEE", uint256(1000));

        vm.startBroadcast();

        // 1. Exchange-only (Allowlist)
        bytes32 wAllow = accounts.createWallet{value: initFee}(bytes32("demo-allowlist"));
        accounts.setRule(wAllow, address(allowlist));
        allowlist.allow(wAllow, EXCHANGE);

        // 2. Agent wallet (RateLimit): allowlist + 10 XRP/day cap
        bytes32 wRate = accounts.createWallet{value: initFee}(bytes32("demo-ratelimit"));
        accounts.setRule(wRate, address(rateLimit));
        rateLimit.allow(wRate, EXCHANGE);
        rateLimit.configure(wRate, 0, 10_000_000, 1 days, 0, true);

        // 3. Subscription: merchant may pull <= 9.99 XRP / 30 days
        bytes32 wSub = accounts.createWallet{value: initFee}(bytes32("demo-subscription"));
        accounts.setRule(wSub, address(subscription));
        subscription.configure(wSub, MERCHANT, 9_990_000, 30 days);

        // 4. Conditional (FDC Escrow): payee + cap + condition (stays locked until proven)
        bytes32 wEsc = accounts.createWallet{value: initFee}(bytes32("demo-escrow"));
        accounts.setRule(wEsc, address(escrow));
        escrow.configure(wEsc, EXCHANGE, 100_000_000, keccak256(bytes("delivery == true")));

        vm.stopBroadcast();

        console2.log("=== Demo accounts for /see ===");
        console2.log("allowlist   :", vm.toString(wAllow));
        console2.log("rateLimit   :", vm.toString(wRate));
        console2.log("subscription:", vm.toString(wSub));
        console2.log("escrow      :", vm.toString(wEsc));
    }
}

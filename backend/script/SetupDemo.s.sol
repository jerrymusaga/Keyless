// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Script, console2} from "forge-std/Script.sol";
import {KeylessAccounts} from "../src/KeylessAccounts.sol";
import {ExchangeRule} from "../src/rules/ExchangeRule.sol";
import {RateLimitRule} from "../src/rules/RateLimitRule.sol";
import {ScheduledRule} from "../src/rules/ScheduledRule.sol";
import {ConditionalRule} from "../src/rules/ConditionalRule.sol";
import {CalendarLib} from "../src/lib/CalendarLib.sol";
import {IWeb2Json} from "../src/interfaces/IFdc.sol";

/// @notice Creates the four demo accounts the public no-login showcase (`/see`) dry-runs against. Each is
///         a real on-chain account owned by the deployer, configured with a rule so the showcase's
///         read-only `authorize` calls produce genuine verdicts. No XRP is funded and the enclave is not
///         needed — the showcase only reads rule config.
///
/// @dev Fixed salts, so walletIds are deterministic. Re-running reverts `WalletExists` (change the salts
///      to reset). Prints the four walletIds to paste into `frontend/lib/showcase.ts`.
///
///      These must stay on the SAME rule deployments a new account gets today. An earlier version of this
///      script set up the retired AllowlistRule and SubscriptionRule, so the showcase was proving
///      contracts nobody is given any more — the demos are only worth anything if they're the live path.
contract SetupDemo is Script {
    // Demo destinations (any string is valid on-chain; the rule stores keccak of it).
    string constant EXCHANGE = "rw15KUmEBEERnbNFys2gVpc26FTABwVDMC";
    string constant PAYER = "randbAijaVXWYaMxLEvSv8twud84xUF3dv";
    string constant PAYEE = "rNayb1SABfnBH4MzuoAbKTsXu6kWeV6cHL";

    /// @dev The bool-predicate shape every condition template uses: jq returns `{ok: <bool>}`, so
    ///      "satisfied" is `keccak(abi.encode(true))`. Safe only because the rule pins the request too.
    string constant BOOL_SIG =
        "{\"components\":[{\"internalType\":\"bool\",\"name\":\"ok\",\"type\":\"bool\"}],\"name\":\"task\",\"type\":\"tuple\"}";

    function run() external {
        KeylessAccounts accounts = KeylessAccounts(vm.envAddress("KEYLESS_ACCOUNTS"));
        ExchangeRule exchange = ExchangeRule(vm.envAddress("EXCHANGE_RULE"));
        RateLimitRule rateLimit = RateLimitRule(vm.envAddress("RATELIMIT_RULE"));
        ScheduledRule scheduled = ScheduledRule(vm.envAddress("SCHEDULED_RULE"));
        ConditionalRule conditional = ConditionalRule(vm.envAddress("CONDITIONAL_RULE"));

        // Instruction fee to attach; excess refunds to claimBack. Override via INIT_FEE if the chain's
        // fee differs. (The scaffold dropped on-chain fee quoting.)
        uint256 initFee = vm.envOr("INIT_FEE", uint256(1000));

        vm.startBroadcast();

        // 1. Exchange & allowlist: may only ever pay one address.
        bytes32 wExchange = accounts.createWallet{value: initFee}(bytes32("demo-exchange"));
        accounts.setRule(wExchange, address(exchange));
        exchange.allow(wExchange, EXCHANGE);

        // 2. Spending limit: the allowlist PLUS 10 XRP per rolling day.
        bytes32 wRate = accounts.createWallet{value: initFee}(bytes32("demo-ratelimit"));
        accounts.setRule(wRate, address(rateLimit));
        rateLimit.allow(wRate, EXCHANGE);
        rateLimit.configure(wRate, 0, 10_000_000, 1 days, 0, true);

        // 3. Scheduled: exactly 25 XRP to one payee, on the 1st of each month, 12 times. Payee, amount
        //    and date are all pinned, so the showcase's "pay early / pay a bit less / pay someone else"
        //    presets are all refusals.
        bytes32 wSched = accounts.createWallet{value: initFee}(bytes32("demo-scheduled"));
        accounts.setRule(wSched, address(scheduled));
        ScheduledRule.LineInput[] memory lines = new ScheduledRule.LineInput[](1);
        lines[0] = ScheduledRule.LineInput({
            recipient: PAYEE,
            amount: 25_000_000,
            unit: CalendarLib.CAL_MONTH,
            offsetDays: 0, // the 1st
            runs: 12,
            startAt: 0 // the next boundary from now
        });
        scheduled.configure(wSched, lines);

        // 4. Conditional (FDC): a payee and a cap, gated on a PINNED live API request. Stays locked until
        //    an FDC Web2Json attestation of exactly this request returns `true`.
        //
        //    Coinbase, NOT CoinGecko: every attestation provider fetches the API independently and they
        //    must agree, and CoinGecko's free-tier throttling means requests against it never reach
        //    consensus. Query params belong in `queryParams`, never inline in the url.
        IWeb2Json.RequestBody memory req;
        req.url = "https://api.coinbase.com/v2/prices/XRP-USD/spot";
        req.httpMethod = "GET";
        req.headers = "{}";
        req.queryParams = "{}";
        req.body = "{}";
        req.postProcessJq = "{ok: ((.data.amount|tonumber) >= 5)}";
        req.abiSignature = BOOL_SIG;

        // A threshold above today's price, so the condition genuinely hasn't been met and the showcase's
        // refusal is real. The deadline hands the money back to the payer if it never is.
        bytes32 wCond = accounts.createWallet{value: initFee}(bytes32("demo-conditional"));
        accounts.setRule(wCond, address(conditional));
        conditional.configure(
            wCond, EXCHANGE, 100_000_000, req, keccak256(abi.encode(true)), 1801353600, PAYER
        ); // 1801353600 = 2027-01-31T00:00:00Z

        vm.stopBroadcast();

        console2.log("=== Demo accounts for /see ===");
        console2.log("exchange   :", vm.toString(wExchange));
        console2.log("rateLimit  :", vm.toString(wRate));
        console2.log("scheduled  :", vm.toString(wSched));
        console2.log("conditional:", vm.toString(wCond));
        console2.log("");
        console2.log("Paste these into frontend/lib/showcase.ts (DEMOS[].walletId).");
    }
}

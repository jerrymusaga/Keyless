// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {KeylessAccounts} from "../src/KeylessAccounts.sol";
import {AllowlistRule} from "../src/rules/AllowlistRule.sol";
import {ExchangeRule} from "../src/rules/ExchangeRule.sol";
import {RateLimitRule} from "../src/rules/RateLimitRule.sol";
import {SubscriptionRule} from "../src/rules/SubscriptionRule.sol";
import {FxrpMintRule} from "../src/rules/FxrpMintRule.sol";
import {FxrpDefiRule} from "../src/rules/FxrpDefiRule.sol";
import {FxrpRule} from "../src/rules/FxrpRule.sol";
import {ConditionalRule} from "../src/rules/ConditionalRule.sol";
import {ScheduledRule} from "../src/rules/ScheduledRule.sol";
import {CalendarLib} from "../src/lib/CalendarLib.sol";
import {KeylessRuleBase} from "../src/rules/KeylessRuleBase.sol";
import {ITeeExtensionRegistry} from "../src/interfaces/ITeeExtensionRegistry.sol";
import {ITeeMachineRegistry} from "../src/interfaces/ITeeMachineRegistry.sol";
import {IWeb2Json} from "../src/interfaces/IFdc.sol";
import {MockTeeRegistry, MockFdcVerification, MockFsa} from "./Mocks.sol";

contract KeylessAccountsTest is Test {
    MockTeeRegistry tee;
    KeylessAccounts accounts;

    uint256 constant EXT_ID = 0x10000; // first public extension id
    uint256 constant FEE = 1000;
    address constant CLAIMBACK = address(0xC1a1);
    address reporter = makeAddr("enclaveReporter");

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address agent = makeAddr("agent");
    string constant EXCHANGE = "rEXCHANGEdepositXXXXXXXXXXXXXXXXXXX";
    string constant ATTACKER = "rATTACKERwalletXXXXXXXXXXXXXXXXXXXX";

    function setUp() public {
        tee = new MockTeeRegistry();
        address[] memory m = new address[](1);
        m[0] = makeAddr("teeMachine");
        tee.setMachines(m);

        accounts = new KeylessAccounts(
            ITeeExtensionRegistry(address(tee)), ITeeMachineRegistry(address(tee)), CLAIMBACK, reporter
        );
        tee.bindExtension(EXT_ID, address(accounts)); // simulate the registry assigning our extension id
        accounts.setExtensionId(); // discover + cache it

        vm.deal(alice, 1 ether);
        vm.deal(bob, 1 ether);
        vm.deal(agent, 1 ether);
    }

    function _wallet(address owner, bytes32 salt) internal returns (bytes32 id) {
        vm.prank(owner);
        id = accounts.createWallet{value: FEE}(salt);
    }

    // --- lifecycle -----------------------------------------------------------

    function test_createWallet_setsOwnerAndInits() public {
        bytes32 id = _wallet(alice, "main");
        assertEq(accounts.ownerOf(id), alice);
        assertEq(accounts.walletIdFor(alice, "main"), id);
        // creating a wallet sends exactly one INIT instruction to one machine
        assertEq(tee.instructionCount(), 1);
        assertEq(tee.lastOpCommand(), accounts.OP_INIT());
        assertEq(tee.lastWalletId(), id, "INIT must target the new walletId");
    }

    function test_createWallet_cannotStealExistingId() public {
        _wallet(alice, "main");
        vm.prank(alice);
        vm.expectRevert(KeylessAccounts.WalletExists.selector);
        accounts.createWallet{value: FEE}("main");
    }

    // --- extension id discovery ----------------------------------------------

    function test_setExtensionId_discoversAndCaches() public view {
        assertEq(accounts.extensionId(), EXT_ID);
        assertTrue(accounts.isBound());
    }

    function test_setExtensionId_cannotSetTwice() public {
        vm.expectRevert(KeylessAccounts.ExtensionIdAlreadySet.selector);
        accounts.setExtensionId();
    }

    function test_setExtensionId_revertsWhenNotRegistered() public {
        // a fresh manager not bound to any extension
        KeylessAccounts fresh = new KeylessAccounts(
            ITeeExtensionRegistry(address(tee)), ITeeMachineRegistry(address(tee)), CLAIMBACK, reporter
        );
        vm.expectRevert(KeylessAccounts.ExtensionIdNotFound.selector);
        fresh.setExtensionId();
    }

    function test_send_revertsBeforeExtensionIdSet() public {
        KeylessAccounts fresh = new KeylessAccounts(
            ITeeExtensionRegistry(address(tee)), ITeeMachineRegistry(address(tee)), CLAIMBACK, reporter
        );
        tee.bindExtension(0x10001, address(fresh)); // registered, but setExtensionId not yet called
        vm.prank(alice);
        vm.expectRevert(KeylessAccounts.ExtensionIdNotSet.selector);
        fresh.createWallet{value: FEE}("x");
    }

    function test_walletCount_increments() public {
        assertEq(accounts.walletCount(), 0);
        _wallet(alice, "a");
        _wallet(bob, "b");
        assertEq(accounts.walletCount(), 2);
    }

    function test_activeCount_tracksRuleTransitions() public {
        bytes32 id = _wallet(alice, "a");
        AllowlistRule rule = new AllowlistRule(address(accounts));
        assertEq(accounts.activeCount(), 0);

        vm.startPrank(alice);
        accounts.setRule(id, address(rule));
        assertEq(accounts.activeCount(), 1, "first rule -> active");
        accounts.setRule(id, address(rule)); // same non-zero rule: no double count
        assertEq(accounts.activeCount(), 1, "re-set does not double count");
        accounts.setRule(id, address(0)); // clear the rule
        assertEq(accounts.activeCount(), 0, "cleared -> inactive");
        vm.stopPrank();
    }

    function test_pay_revertsWithoutRule() public {
        bytes32 id = _wallet(alice, "main");
        vm.expectRevert(KeylessAccounts.NoRule.selector);
        accounts.pay{value: FEE}(id, EXCHANGE, 1_000_000, bytes32("r"));
    }

    // --- xrpl address writeback ----------------------------------------------

    string constant RADDR = "rKeyLessWa11etXXXXXXXXXXXXXXXXXXXXX";

    function test_reportXrplAddress_onlyReporter_andReadableOnChain() public {
        bytes32 id = _wallet(alice, "main");
        assertEq(bytes(accounts.xrplAddressOf(id)).length, 0, "empty before report");

        // a stranger (even the owner) cannot report the address
        vm.prank(alice);
        vm.expectRevert(KeylessAccounts.NotReporter.selector);
        accounts.reportXrplAddress(id, RADDR);

        // the enclave reporter records it; the UI can now read it straight from chain
        vm.prank(reporter);
        accounts.reportXrplAddress(id, RADDR);
        assertEq(accounts.xrplAddressOf(id), RADDR);
    }

    function test_reportXrplAddress_isIdempotent_firstWins() public {
        bytes32 id = _wallet(alice, "main");
        vm.startPrank(reporter);
        accounts.reportXrplAddress(id, RADDR);
        // a later report can't repoint a (possibly funded) wallet's deposit address
        accounts.reportXrplAddress(id, "rATTACKERredirectXXXXXXXXXXXXXXXXXX");
        vm.stopPrank();
        assertEq(accounts.xrplAddressOf(id), RADDR, "first report wins");
    }

    function test_reportXrplAddress_rejectsUnknownWallet() public {
        vm.prank(reporter);
        vm.expectRevert(KeylessAccounts.UnknownWallet.selector);
        accounts.reportXrplAddress(bytes32("nope"), RADDR);
    }

    // --- allowlist rule: the headline (can't be drained) ---------------------

    function test_allowlist_paysAllowed_andSignsOnce() public {
        bytes32 id = _wallet(alice, "exchange");
        AllowlistRule rule = new AllowlistRule(address(accounts));
        vm.startPrank(alice);
        accounts.setRule(id, address(rule));
        rule.allow(id, EXCHANGE);
        vm.stopPrank();

        accounts.pay{value: FEE}(id, EXCHANGE, 5_000_000, bytes32("r"));
        assertEq(tee.lastRecipient(), EXCHANGE);
        assertEq(tee.lastAmount(), 5_000_000);
        assertEq(tee.lastWalletId(), id);
        assertEq(tee.lastTeeIdCount(), 1, "exactly one machine");
    }

    /// @notice THE MONEY SHOT: hold the key, control the box, still can't send to the attacker.
    function test_allowlist_cannotPayAttacker_noInstructionSent() public {
        bytes32 id = _wallet(alice, "exchange");
        AllowlistRule rule = new AllowlistRule(address(accounts));
        vm.startPrank(alice);
        accounts.setRule(id, address(rule));
        rule.allow(id, EXCHANGE);
        vm.stopPrank();

        uint256 before = tee.instructionCount();
        vm.prank(bob); // anyone can try; the rule is the gate
        vm.expectRevert(abi.encodeWithSelector(KeylessRuleBase.Rejected.selector, "recipient not allowed"));
        accounts.pay{value: FEE}(id, ATTACKER, 5_000_000, bytes32("steal"));
        assertEq(tee.instructionCount(), before, "no instruction may reach the enclave");
    }

    function test_allowlist_allowMany_addsAllInOneTx() public {
        bytes32 id = _wallet(alice, "exchange");
        AllowlistRule rule = new AllowlistRule(address(accounts));
        string[] memory recips = new string[](2);
        recips[0] = EXCHANGE;
        recips[1] = "rSecondExchangeDepositXXXXXXXXXXXXX";
        vm.startPrank(alice);
        accounts.setRule(id, address(rule));
        rule.allowMany(id, recips);
        vm.stopPrank();

        accounts.pay{value: FEE}(id, EXCHANGE, 1_000_000, bytes32("a"));
        assertEq(tee.lastRecipient(), EXCHANGE);
        accounts.pay{value: FEE}(id, "rSecondExchangeDepositXXXXXXXXXXXXX", 1_000_000, bytes32("b"));
        assertEq(tee.lastRecipient(), "rSecondExchangeDepositXXXXXXXXXXXXX");
    }

    function test_allowlist_onlyOwnerConfigures() public {
        bytes32 id = _wallet(alice, "exchange");
        AllowlistRule rule = new AllowlistRule(address(accounts));
        vm.prank(alice);
        accounts.setRule(id, address(rule));

        vm.prank(bob);
        vm.expectRevert(KeylessRuleBase.NotWalletOwner.selector);
        rule.allow(id, ATTACKER);
    }

    /// @notice Blast radius: a rule governs ONLY its own walletId. Alice's rule can't touch Bob's wallet.
    function test_rule_isScopedToOneWallet() public {
        bytes32 aliceId = _wallet(alice, "w");
        bytes32 bobId = _wallet(bob, "w");
        AllowlistRule rule = new AllowlistRule(address(accounts));

        vm.prank(alice);
        accounts.setRule(aliceId, address(rule));
        // Alice allowlisting on her wallet does nothing to Bob's, and she can't configure his.
        vm.prank(alice);
        vm.expectRevert(KeylessRuleBase.NotWalletOwner.selector);
        rule.allow(bobId, ATTACKER);
    }

    // --- rate limit rule: the agent wallet -----------------------------------

    function test_rateLimit_capsSpendPerWindow_thenResets() public {
        bytes32 id = _wallet(alice, "agent");
        RateLimitRule rule = new RateLimitRule(address(accounts));
        vm.startPrank(alice);
        accounts.setRule(id, address(rule));
        rule.allow(id, EXCHANGE);
        rule.configure(id, 0, 10_000_000, 1 days, 0, true); // max 10 XRP/day, allowlist-only, no per-tx cap
        vm.stopPrank();

        // agent spends up to the cap across calls
        vm.startPrank(agent);
        accounts.pay{value: FEE}(id, EXCHANGE, 6_000_000, bytes32("a"));
        accounts.pay{value: FEE}(id, EXCHANGE, 4_000_000, bytes32("b")); // now at 10M
        // one more drop over the cap in the same window -> blocked
        vm.expectRevert(abi.encodeWithSelector(KeylessRuleBase.Rejected.selector, "limit exceeded"));
        accounts.pay{value: FEE}(id, EXCHANGE, 1, bytes32("c"));
        vm.stopPrank();

        // next window: cap refreshes
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(agent);
        accounts.pay{value: FEE}(id, EXCHANGE, 9_000_000, bytes32("d"));
        assertEq(tee.lastAmount(), 9_000_000);
    }

    function test_rateLimit_stillEnforcesAllowlist() public {
        bytes32 id = _wallet(alice, "agent");
        RateLimitRule rule = new RateLimitRule(address(accounts));
        vm.startPrank(alice);
        accounts.setRule(id, address(rule));
        rule.configure(id, 0, 10_000_000, 1 days, 0, true);
        vm.stopPrank();

        // a hijacked agent tries the attacker; not allowlisted -> blocked regardless of the cap
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(KeylessRuleBase.Rejected.selector, "recipient not allowed"));
        accounts.pay{value: FEE}(id, ATTACKER, 1_000_000, bytes32("x"));
    }

    function test_rateLimit_openMode_allowsAnyRecipientWithinCap() public {
        bytes32 id = _wallet(alice, "allowance");
        RateLimitRule rule = new RateLimitRule(address(accounts));
        vm.startPrank(alice);
        accounts.setRule(id, address(rule));
        rule.configure(id, 0, 10_000_000, 1 days, 0, false); // open mode: no allowlist
        vm.stopPrank();

        // pays a never-allowlisted address just fine, as long as it's under the cap
        vm.prank(agent);
        accounts.pay{value: FEE}(id, ATTACKER, 8_000_000, bytes32("a"));
        assertEq(tee.lastAmount(), 8_000_000);

        // still bounded by the window cap
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(KeylessRuleBase.Rejected.selector, "limit exceeded"));
        accounts.pay{value: FEE}(id, ATTACKER, 3_000_000, bytes32("b"));
    }

    function test_rateLimit_perTxCap_boundsSinglePayment() public {
        bytes32 id = _wallet(alice, "capped");
        RateLimitRule rule = new RateLimitRule(address(accounts));
        vm.startPrank(alice);
        accounts.setRule(id, address(rule));
        rule.allow(id, EXCHANGE);
        rule.configure(id, 0, 100_000_000, 1 days, 5_000_000, true); // 100 XRP/day but max 5 XRP/tx
        vm.stopPrank();

        vm.startPrank(agent);
        vm.expectRevert(abi.encodeWithSelector(KeylessRuleBase.Rejected.selector, "over per-tx limit"));
        accounts.pay{value: FEE}(id, EXCHANGE, 6_000_000, bytes32("a"));
        // at or under the per-tx cap is fine
        accounts.pay{value: FEE}(id, EXCHANGE, 5_000_000, bytes32("b"));
        assertEq(tee.lastAmount(), 5_000_000);
        vm.stopPrank();
    }

    function test_rateLimit_calendarMath_exact() public {
        RateLimitRule rule = new RateLimitRule(address(accounts));
        // month starts (unit 2), computed independently in Python
        assertEq(rule.calendarStart(1784993400, 2), 1782864000, "2026-07-25 -> 2026-07-01");
        assertEq(rule.calendarStart(1773532800, 2), 1772323200, "2026-03-15 -> 2026-03-01");
        assertEq(rule.calendarStart(1768003200, 2), 1767225600, "2026-01-10 -> 2026-01-01");
        assertEq(rule.calendarStart(1709251140, 2), 1706745600, "2024-02-29 leap -> 2024-02-01");
        assertEq(rule.calendarStart(1798758000, 2), 1796083200, "2026-12-31 -> 2026-12-01");
        // week (unit 1) -> Monday 00:00; day (unit 0) -> midnight
        assertEq(rule.calendarStart(1784993400, 1), 1784505600, "Sat 2026-07-25 -> Mon 2026-07-20");
        assertEq(rule.calendarStart(1784993400, 0), 1784937600, "day -> 2026-07-25 00:00");
    }

    function test_rateLimit_calendarMode_resetsOnMonthBoundary() public {
        bytes32 id = _wallet(alice, "monthly");
        RateLimitRule rule = new RateLimitRule(address(accounts));
        vm.warp(1784993400); // 2026-07-25
        vm.startPrank(alice);
        accounts.setRule(id, address(rule));
        rule.configure(id, 1, 100_000_000, 2, 0, false); // MODE_CALENDAR, 100 XRP/month, open
        vm.stopPrank();

        vm.startPrank(agent);
        accounts.pay{value: FEE}(id, ATTACKER, 100_000_000, bytes32("a")); // spends the month
        vm.expectRevert(abi.encodeWithSelector(KeylessRuleBase.Rejected.selector, "limit exceeded"));
        accounts.pay{value: FEE}(id, ATTACKER, 1, bytes32("b"));
        vm.stopPrank();

        // cross into August -> budget refreshes on the 1st
        vm.warp(1782864000 + 40 days); // early August 2026
        vm.prank(agent);
        accounts.pay{value: FEE}(id, ATTACKER, 90_000_000, bytes32("c"));
        assertEq(tee.lastAmount(), 90_000_000);
    }

    function test_rateLimit_untilMode_hardStopsAtDate() public {
        bytes32 id = _wallet(alice, "trip");
        RateLimitRule rule = new RateLimitRule(address(accounts));
        vm.warp(1784993400); // 2026-07-25
        uint256 deadline = 1784993400 + 10 days;
        vm.startPrank(alice);
        accounts.setRule(id, address(rule));
        rule.configure(id, 2, 50_000_000, deadline, 0, false); // MODE_UNTIL: 50 XRP total until the deadline
        vm.stopPrank();

        vm.startPrank(agent);
        accounts.pay{value: FEE}(id, ATTACKER, 30_000_000, bytes32("a"));
        // one-time budget: no reset, so the total is enforced across time
        vm.expectRevert(abi.encodeWithSelector(KeylessRuleBase.Rejected.selector, "limit exceeded"));
        accounts.pay{value: FEE}(id, ATTACKER, 25_000_000, bytes32("b"));
        vm.stopPrank();

        // after the deadline: hard stop, nothing more can leave
        vm.warp(deadline + 1);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(KeylessRuleBase.Rejected.selector, "budget period ended"));
        accounts.pay{value: FEE}(id, ATTACKER, 1_000_000, bytes32("c"));
    }

    // --- FXRP mint rule: the undrainable on-ramp -----------------------------

    string constant CORE_VAULT = "rDhpmiPq4BVBDWMVdSrmkgt8thKyRzGV1p";

    function test_fxrpMint_paysCoreVaultWithOwnerMemo() public {
        bytes32 id = _wallet(alice, "onramp");
        FxrpMintRule rule = new FxrpMintRule(address(accounts), CORE_VAULT);
        address flareRecipient = address(0xc0fFee1234567890123456789012345678901234);
        vm.startPrank(alice);
        accounts.setRule(id, address(rule));
        rule.configure(id, flareRecipient);
        vm.stopPrank();

        // the memo is exactly DIRECT_MINTING(0x4642505266410018) | zero(4) | recipient(20)
        bytes32 memo = rule.mintMemo(flareRecipient);
        assertEq(memo, bytes32((uint256(0x4642505266410018) << 192) | uint256(uint160(flareRecipient))));

        // permissionless: anyone can push the mint payment, it can only go to the core vault with the memo
        accounts.pay{value: FEE}(id, CORE_VAULT, 20_000_000, memo);
        assertEq(tee.lastRecipient(), CORE_VAULT);
        assertEq(tee.lastAmount(), 20_000_000);
    }

    function test_fxrpMint_rejectsNonCoreVaultRecipient() public {
        bytes32 id = _wallet(alice, "onramp2");
        FxrpMintRule rule = new FxrpMintRule(address(accounts), CORE_VAULT);
        address flareRecipient = address(0xBEEF);
        vm.startPrank(alice);
        accounts.setRule(id, address(rule));
        rule.configure(id, flareRecipient);
        vm.stopPrank();

        // even with a valid mint memo, it can only pay the core vault — not a thief's address
        bytes32 memo = rule.mintMemo(flareRecipient);
        vm.expectRevert(abi.encodeWithSelector(KeylessRuleBase.Rejected.selector, "must pay the FXRP core vault"));
        accounts.pay{value: FEE}(id, ATTACKER, 20_000_000, memo);
    }

    function test_fxrpMint_rejectsMemoForDifferentRecipient() public {
        bytes32 id = _wallet(alice, "onramp3");
        FxrpMintRule rule = new FxrpMintRule(address(accounts), CORE_VAULT);
        vm.startPrank(alice);
        accounts.setRule(id, address(rule));
        rule.configure(id, address(0xA11CE));
        vm.stopPrank();

        // a memo crediting someone else's Flare address is rejected — mints can only land at the owner's
        bytes32 wrongMemo = rule.mintMemo(address(0xBAD));
        vm.expectRevert(abi.encodeWithSelector(KeylessRuleBase.Rejected.selector, "wrong mint memo"));
        accounts.pay{value: FEE}(id, CORE_VAULT, 20_000_000, wrongMemo);
    }

    function test_fxrpMint_rejectsBeforeConfigure() public {
        bytes32 id = _wallet(alice, "onramp4");
        FxrpMintRule rule = new FxrpMintRule(address(accounts), CORE_VAULT);
        vm.prank(alice);
        accounts.setRule(id, address(rule));
        bytes32 memo = rule.mintMemo(address(0xA11CE));
        vm.expectRevert(abi.encodeWithSelector(KeylessRuleBase.Rejected.selector, "no mint recipient set"));
        accounts.pay{value: FEE}(id, CORE_VAULT, 20_000_000, memo);
    }

    // --- FXRP DeFi rule (Flare Smart Accounts, undrainable) ------------------

    string constant FSA_WALLET = "rEyj8nsHLdgt79KJWzXR5BgF7ZbaohbXwq";
    uint256 constant FSA_MAX_TRIGGER = 10_000_000; // 10 XRP

    function _fxrpDefi(bytes32 id) internal returns (FxrpDefiRule rule) {
        rule = new FxrpDefiRule(address(accounts), FSA_WALLET, FSA_MAX_TRIGGER);
        vm.prank(alice);
        accounts.setRule(id, address(rule));
    }

    function test_fxrpDefi_allowsRedeemHomeAndVaultOps() public {
        bytes32 id = _wallet(alice, "defi");
        FxrpDefiRule rule = _fxrpDefi(id);

        // redeem FXRP -> XRP home (0x02) is allowed
        accounts.pay{value: FEE}(id, FSA_WALLET, 1000, rule.redeemHomeRef(5));
        assertEq(tee.lastRecipient(), FSA_WALLET);

        // deposit into a Firelight vault (0x11) is allowed
        accounts.pay{value: FEE}(id, FSA_WALLET, 1000, rule.vaultRef(0x11, 2, 5_000_000));
        // redeem from an Upshift vault (0x22 requestRedeem) is allowed
        accounts.pay{value: FEE}(id, FSA_WALLET, 1000, rule.vaultRef(0x22, 3, 1_000_000));
    }

    function test_fxrpDefi_blocksTransferOut() public {
        bytes32 id = _wallet(alice, "defi");
        FxrpDefiRule rule = _fxrpDefi(id);
        // instruction 0x01 (transfer FXRP to an arbitrary address) is the drain vector — always refused
        bytes32 transferRef = bytes32((uint256(0x01) << 248) | (uint256(9_000_000) << 160) | uint256(uint160(address(0xBAD))));
        vm.expectRevert(abi.encodeWithSelector(KeylessRuleBase.Rejected.selector, "FXRP transfer-out is not allowed"));
        accounts.pay{value: FEE}(id, FSA_WALLET, 1000, transferRef);
    }

    function test_fxrpDefi_blocksWrongRecipientAndUnknownInstruction() public {
        bytes32 id = _wallet(alice, "defi");
        FxrpDefiRule rule = _fxrpDefi(id);
        bytes32 redeemRef = rule.redeemHomeRef(5); // precompute (else expectRevert binds to this staticcall)

        // must pay the FSA provider wallet, not some other address
        vm.expectRevert(abi.encodeWithSelector(KeylessRuleBase.Rejected.selector, "must pay your FSA account"));
        accounts.pay{value: FEE}(id, ATTACKER, 1000, redeemRef);

        // minting instructions (0x00) are out of scope for this rule
        bytes32 mintRef = bytes32((uint256(0x00) << 248) | (uint256(5) << 160));
        vm.expectRevert(abi.encodeWithSelector(KeylessRuleBase.Rejected.selector, "instruction not permitted"));
        accounts.pay{value: FEE}(id, FSA_WALLET, 1000, mintRef);
    }

    function test_fxrpDefi_capsTriggerAmount() public {
        bytes32 id = _wallet(alice, "defi");
        FxrpDefiRule rule = _fxrpDefi(id);
        bytes32 redeemRef = rule.redeemHomeRef(5); // precompute (else expectRevert binds to this staticcall)
        vm.expectRevert(abi.encodeWithSelector(KeylessRuleBase.Rejected.selector, "trigger amount too large"));
        accounts.pay{value: FEE}(id, FSA_WALLET, FSA_MAX_TRIGGER + 1, redeemRef);
    }

    // --- unified FXRP rule (mint to own FSA account + undrainable DeFi) ------

    string constant KL_XRPL = "rKeyLessDepositXXXXXXXXXXXXXXXXXXXX";

    function _fxrp(bytes32 id) internal returns (FxrpRule rule, MockFsa fsa) {
        fsa = new MockFsa();
        rule = new FxrpRule(address(accounts), CORE_VAULT, FSA_WALLET, address(fsa), FSA_MAX_TRIGGER);
        vm.prank(alice);
        accounts.setRule(id, address(rule));
    }

    function test_fxrp_mintsOnlyToOwnPersonalAccount() public {
        bytes32 id = _wallet(alice, "fxrp");
        (FxrpRule rule, MockFsa fsa) = _fxrp(id);
        // provision the account's XRPL deposit address, as the enclave reporter would
        vm.prank(reporter);
        accounts.reportXrplAddress(id, KL_XRPL);
        address pa = fsa.getPersonalAccount(KL_XRPL);

        // minting that credits the account's OWN FSA personal account is allowed
        accounts.pay{value: FEE}(id, CORE_VAULT, 20_000_000, rule.mintMemo(pa));
        assertEq(tee.lastRecipient(), CORE_VAULT);

        // minting to any other Flare address is refused — mints can't be repointed to a thief
        bytes32 badMemo = rule.mintMemo(address(0xBAD));
        vm.expectRevert(abi.encodeWithSelector(KeylessRuleBase.Rejected.selector, "must mint to your FSA account"));
        accounts.pay{value: FEE}(id, CORE_VAULT, 20_000_000, badMemo);
    }

    function test_fxrp_mintRevertsBeforeXrplProvisioned() public {
        bytes32 id = _wallet(alice, "fxrp");
        (FxrpRule rule,) = _fxrp(id);
        bytes32 memo = rule.mintMemo(address(0x1234));
        vm.expectRevert(bytes("xrpl address not provisioned yet"));
        accounts.pay{value: FEE}(id, CORE_VAULT, 20_000_000, memo);
    }

    function test_fxrp_defiSafeSetAndBlocksTransferOut() public {
        bytes32 id = _wallet(alice, "fxrp");
        (FxrpRule rule,) = _fxrp(id);
        // vault deposit + redeem-home are allowed
        accounts.pay{value: FEE}(id, FSA_WALLET, 1000, rule.redeemHomeRef(5));
        accounts.pay{value: FEE}(id, FSA_WALLET, 1000, rule.vaultRef(0x11, 1, 5_000_000));
        // transferring FXRP out is blocked
        bytes32 xfer = bytes32((uint256(0x01) << 248) | (uint256(9) << 160) | uint256(uint160(address(0xBAD))));
        vm.expectRevert(abi.encodeWithSelector(KeylessRuleBase.Rejected.selector, "FXRP transfer-out is not allowed"));
        accounts.pay{value: FEE}(id, FSA_WALLET, 1000, xfer);
    }

    function test_fxrp_blocksUnknownRecipient() public {
        bytes32 id = _wallet(alice, "fxrp");
        (FxrpRule rule,) = _fxrp(id);
        bytes32 redeemRef = rule.redeemHomeRef(5);
        vm.expectRevert(abi.encodeWithSelector(KeylessRuleBase.Rejected.selector, "recipient not allowed"));
        accounts.pay{value: FEE}(id, ATTACKER, 1000, redeemRef);
    }

    // --- Conditional: the deadline / fallback (no stranded funds) ------------
    //
    // Under this rule the account may pay NOBODY except the payee, and only once proven. So a condition
    // that never comes true would strand a locked account forever. A deadline plus a fallback recipient
    // (normally the payer themselves) closes that: before the deadline only the payee can be paid, after
    // it only the fallback can, and never both.

    string constant PAYER_BACK = "rPAYERrefundXXXXXXXXXXXXXXXXXXXXXXX";

    function _expiringSetup(uint256 deadline)
        internal
        returns (ConditionalRule rule, bytes32 id, IWeb2Json.RequestBody memory req)
    {
        MockFdcVerification fdc = new MockFdcVerification();
        rule = new ConditionalRule(address(accounts), address(fdc));
        req = _req(API_URL, "{\"ids\":\"ripple\"}", API_JQ);
        id = _wallet(alice, "expiring");
        vm.startPrank(alice);
        accounts.setRule(id, address(rule));
        rule.configure(id, EXCHANGE, 10_000_000, req, keccak256(abi.encode(true)), deadline, PAYER_BACK);
        vm.stopPrank();
    }

    function test_conditional_beforeDeadline_neitherSideCanBePaid() public {
        (, bytes32 id,) = _expiringSetup(block.timestamp + 30 days);

        vm.expectRevert(abi.encodeWithSelector(KeylessRuleBase.Rejected.selector, "condition not proven yet"));
        accounts.pay{value: FEE}(id, EXCHANGE, 1_000_000, bytes32("r"));
        // the fallback is NOT a way to jump the queue while the window is open
        vm.expectRevert(abi.encodeWithSelector(KeylessRuleBase.Rejected.selector, "condition not proven yet"));
        accounts.pay{value: FEE}(id, PAYER_BACK, 1_000_000, bytes32("r"));
    }

    function test_conditional_afterDeadline_onlyFallbackIsPayable() public {
        (ConditionalRule rule, bytes32 id,) = _expiringSetup(block.timestamp + 30 days);
        vm.warp(block.timestamp + 31 days);
        assertTrue(rule.isExpired(id), "unproven past its deadline");

        // the payee never earned it
        vm.expectRevert(
            abi.encodeWithSelector(KeylessRuleBase.Rejected.selector, "condition expired - only the fallback may be paid")
        );
        accounts.pay{value: FEE}(id, EXCHANGE, 1_000_000, bytes32("r"));

        // the payer gets their money back — the account is not stranded
        accounts.pay{value: FEE}(id, PAYER_BACK, 1_000_000, bytes32("r"));
        assertEq(tee.lastRecipient(), PAYER_BACK);
    }

    function test_conditional_proofAfterDeadlineCannotReopenTheWindow() public {
        (ConditionalRule rule, bytes32 id, IWeb2Json.RequestBody memory req) = _expiringSetup(block.timestamp + 7 days);
        vm.warp(block.timestamp + 8 days);
        vm.expectRevert(ConditionalRule.DeadlinePassed.selector);
        rule.release(id, _web2Proof(req, abi.encode(true)));
    }

    function test_conditional_provenBeforeDeadline_paysPayeeNotFallback() public {
        (ConditionalRule rule, bytes32 id, IWeb2Json.RequestBody memory req) = _expiringSetup(block.timestamp + 7 days);
        rule.release(id, _web2Proof(req, abi.encode(true)));
        vm.warp(block.timestamp + 8 days); // deadline passes AFTER it was proven — irrelevant now

        accounts.pay{value: FEE}(id, EXCHANGE, 1_000_000, bytes32("r"));
        assertEq(tee.lastRecipient(), EXCHANGE);
        vm.expectRevert(abi.encodeWithSelector(KeylessRuleBase.Rejected.selector, "recipient is not the payee"));
        accounts.pay{value: FEE}(id, PAYER_BACK, 1_000_000, bytes32("r"));
    }

    function test_conditional_configureRejectsBadDeadlineOrDanglingFallback() public {
        MockFdcVerification fdc = new MockFdcVerification();
        ConditionalRule rule = new ConditionalRule(address(accounts), address(fdc));
        IWeb2Json.RequestBody memory req = _req(API_URL, "{}", API_JQ);
        bytes32 id = _wallet(alice, "bad");
        vm.startPrank(alice);
        accounts.setRule(id, address(rule));
        vm.expectRevert(abi.encodeWithSelector(KeylessRuleBase.Rejected.selector, "deadline already passed"));
        rule.configure(id, EXCHANGE, 1_000_000, req, keccak256(abi.encode(true)), block.timestamp, PAYER_BACK);
        // a fallback with no deadline could never be reached
        vm.expectRevert(abi.encodeWithSelector(KeylessRuleBase.Rejected.selector, "fallback needs a deadline"));
        rule.configure(id, EXCHANGE, 1_000_000, req, keccak256(abi.encode(true)), 0, PAYER_BACK);
        vm.stopPrank();
    }

    // --- subscription rule ---------------------------------------------------

    function test_subscription_merchantCappedAndCancellable() public {
        bytes32 id = _wallet(alice, "sub");
        SubscriptionRule rule = new SubscriptionRule(address(accounts));
        vm.startPrank(alice);
        accounts.setRule(id, address(rule));
        rule.configure(id, EXCHANGE, 10_000_000, 30 days); // merchant may pull <=10 XRP/30d
        vm.stopPrank();

        // merchant pulls within cap
        accounts.pay{value: FEE}(id, EXCHANGE, 10_000_000, bytes32("m"));
        // second pull same window over cap -> blocked
        vm.expectRevert(abi.encodeWithSelector(KeylessRuleBase.Rejected.selector, "over subscription cap"));
        accounts.pay{value: FEE}(id, EXCHANGE, 1, bytes32("m2"));

        // merchant cannot redirect to another address
        vm.expectRevert(abi.encodeWithSelector(KeylessRuleBase.Rejected.selector, "recipient is not the merchant"));
        accounts.pay{value: FEE}(id, ATTACKER, 1, bytes32("m3"));

        // owner cancels -> nothing further
        vm.prank(alice);
        rule.cancel(id);
        vm.warp(block.timestamp + 31 days);
        vm.expectRevert(abi.encodeWithSelector(KeylessRuleBase.Rejected.selector, "no active subscription"));
        accounts.pay{value: FEE}(id, EXCHANGE, 1_000_000, bytes32("m4"));
    }

    // --- ConditionalRule: pay when the world proves the condition (v2) --------
    //
    // The headline test here is `test_conditional_forgedProofFromAnotherApiIsRejected`: the superseded
    // FdcEscrowRule verified only that a proof was genuine and that its RESPONSE matched, never which
    // request produced it. Conditions are naturally a jq predicate returning a bool, so every boolean
    // escrow committed to the same hash — keccak(abi.encode(true)) = 0xb10e2d5276… — and `release()` is
    // permissionless. Verified live on Coston2: an attestation of "github stars > 0" produces exactly
    // that hash, so it would have released a "delivery == true" escrow. v2 pins the whole request.

    string constant API_URL = "https://api.coingecko.com/api/v3/simple/price";
    string constant API_JQ = "{ok: (.ripple.usd >= 1)}";
    string constant BOOL_SIG = "{\"components\":[{\"name\":\"ok\",\"type\":\"bool\"}],\"name\":\"task\",\"type\":\"tuple\"}";

    /// @dev A request as the FDC attests it. `qp` is the query — same url + different query is a
    ///      different question (ids=ripple vs ids=bitcoin), which is why the whole struct is pinned.
    function _req(string memory url, string memory qp, string memory jq)
        internal
        pure
        returns (IWeb2Json.RequestBody memory r)
    {
        r.url = url;
        r.httpMethod = "GET";
        r.headers = "{}";
        r.queryParams = qp;
        r.body = "{}";
        r.postProcessJq = jq;
        r.abiSignature = BOOL_SIG;
    }

    /// @dev A Web2Json proof attesting `data` for `req`. merkleProof is empty — the mock stands in for
    ///      the Merkle-root check, so `setResult(true)` means "Flare really attested this".
    function _web2Proof(IWeb2Json.RequestBody memory req, bytes memory data)
        internal
        pure
        returns (IWeb2Json.Proof memory p)
    {
        p.data.votingRound = 1414809;
        p.data.requestBody = req;
        p.data.responseBody.abiEncodedData = data;
    }

    function _conditionWallet(ConditionalRule rule, IWeb2Json.RequestBody memory req, bytes32 expected)
        internal
        returns (bytes32 id)
    {
        id = _wallet(alice, "conditional");
        vm.startPrank(alice);
        accounts.setRule(id, address(rule));
        rule.configure(id, EXCHANGE, 10_000_000, req, expected, 0, ""); // waits forever, no fallback
        vm.stopPrank();
    }

    function _conditionalSetup() internal returns (ConditionalRule rule, bytes32 id, IWeb2Json.RequestBody memory req) {
        MockFdcVerification fdc = new MockFdcVerification();
        rule = new ConditionalRule(address(accounts), address(fdc));
        req = _req(API_URL, "{\"ids\":\"ripple\"}", API_JQ);
        id = _conditionWallet(rule, req, keccak256(abi.encode(true)));
    }

    function test_conditional_locksUntilProven_thenPays() public {
        (ConditionalRule rule, bytes32 id, IWeb2Json.RequestBody memory req) = _conditionalSetup();

        // before the proof, even the pinned payee cannot be paid — and nothing reaches the enclave
        uint256 before = tee.instructionCount();
        vm.expectRevert(abi.encodeWithSelector(KeylessRuleBase.Rejected.selector, "condition not proven yet"));
        accounts.pay{value: FEE}(id, EXCHANGE, 5_000_000, bytes32("r"));
        assertEq(tee.instructionCount(), before, "no XRPL instruction while unproven");

        // the world says yes: anyone may submit the attested proof
        rule.release(id, _web2Proof(req, abi.encode(true)));

        accounts.pay{value: FEE}(id, EXCHANGE, 5_000_000, bytes32("r"));
        assertEq(tee.lastRecipient(), EXCHANGE);
    }

    /// THE VULNERABILITY. A genuinely-attested proof of the attacker's OWN api that returns the same
    /// `true` must NOT release someone else's condition. Under the old response-only check it did.
    function test_conditional_forgedProofFromAnotherApiIsRejected() public {
        (ConditionalRule rule, bytes32 id,) = _conditionalSetup();

        // attacker attests their own endpoint — a real FDC attestation (mock verifier returns true),
        // whose jq predicate yields the identical payload the escrow commits to.
        // Note the payload is byte-identical to the one this condition commits to: every boolean
        // condition shares keccak(abi.encode(true)). Only the request binding stops it.
        IWeb2Json.RequestBody memory evil = _req("https://attacker.example/always-true", "{}", "{ok: true}");

        vm.expectRevert(ConditionalRule.WrongRequest.selector);
        rule.release(id, _web2Proof(evil, abi.encode(true)));

        // and the account still cannot pay
        vm.expectRevert(abi.encodeWithSelector(KeylessRuleBase.Rejected.selector, "condition not proven yet"));
        accounts.pay{value: FEE}(id, EXCHANGE, 1_000_000, bytes32("r"));
    }

    /// Same URL, different question. CoinGecko /simple/price with ids=bitcoin is not ids=ripple — pinning
    /// only the url would have missed this, which is why the whole request struct is committed.
    function test_conditional_sameUrlDifferentQueryIsRejected() public {
        (ConditionalRule rule, bytes32 id,) = _conditionalSetup();
        IWeb2Json.RequestBody memory otherAsset = _req(API_URL, "{\"ids\":\"bitcoin\"}", API_JQ);
        vm.expectRevert(ConditionalRule.WrongRequest.selector);
        rule.release(id, _web2Proof(otherAsset, abi.encode(true)));
    }

    /// A tampered jq (a predicate rewritten to always pass) is a different request too.
    function test_conditional_tamperedTransformIsRejected() public {
        (ConditionalRule rule, bytes32 id,) = _conditionalSetup();
        IWeb2Json.RequestBody memory tampered = _req(API_URL, "{\"ids\":\"ripple\"}", "{ok: true}");
        vm.expectRevert(ConditionalRule.WrongRequest.selector);
        rule.release(id, _web2Proof(tampered, abi.encode(true)));
    }

    function test_conditional_rejectsUnverifiedProof() public {
        MockFdcVerification fdc = new MockFdcVerification();
        ConditionalRule rule = new ConditionalRule(address(accounts), address(fdc));
        IWeb2Json.RequestBody memory req = _req(API_URL, "{\"ids\":\"ripple\"}", API_JQ);
        bytes32 id = _conditionWallet(rule, req, keccak256(abi.encode(true)));

        fdc.setResult(false); // Flare did not attest this
        vm.expectRevert(ConditionalRule.ProofNotVerified.selector);
        rule.release(id, _web2Proof(req, abi.encode(true)));
    }

    /// The right request, but the world said no — the attested value isn't the one that means "go".
    function test_conditional_rejectsWhenWorldSaysNo() public {
        (ConditionalRule rule, bytes32 id, IWeb2Json.RequestBody memory req) = _conditionalSetup();
        vm.expectRevert(ConditionalRule.ConditionNotMet.selector);
        rule.release(id, _web2Proof(req, abi.encode(false)));
    }

    function test_conditional_enforcesPayeeAndCapAfterRelease() public {
        (ConditionalRule rule, bytes32 id, IWeb2Json.RequestBody memory req) = _conditionalSetup();
        rule.release(id, _web2Proof(req, abi.encode(true)));

        // proven, but still only the pinned payee
        vm.expectRevert(abi.encodeWithSelector(KeylessRuleBase.Rejected.selector, "recipient is not the payee"));
        accounts.pay{value: FEE}(id, ATTACKER, 1_000_000, bytes32("r"));

        // and never more than the cap, across releases
        accounts.pay{value: FEE}(id, EXCHANGE, 9_000_000, bytes32("r"));
        vm.expectRevert(abi.encodeWithSelector(KeylessRuleBase.Rejected.selector, "over the cap"));
        accounts.pay{value: FEE}(id, EXCHANGE, 2_000_000, bytes32("r"));
    }

    function test_conditional_cannotProveTwice_andOwnerCanCancel() public {
        (ConditionalRule rule, bytes32 id, IWeb2Json.RequestBody memory req) = _conditionalSetup();
        rule.release(id, _web2Proof(req, abi.encode(true)));

        vm.expectRevert(ConditionalRule.AlreadyProven.selector);
        rule.release(id, _web2Proof(req, abi.encode(true)));

        // a stranger cannot cancel; the owner can, and then nothing may be paid
        vm.prank(bob);
        vm.expectRevert(KeylessRuleBase.NotWalletOwner.selector);
        rule.cancel(id);

        vm.prank(alice);
        rule.cancel(id);
        vm.expectRevert(abi.encodeWithSelector(KeylessRuleBase.Rejected.selector, "no active condition"));
        accounts.pay{value: FEE}(id, EXCHANGE, 1_000_000, bytes32("r"));
    }

    // --- lockable rules: undrainable even against a stolen control key ---------

    function _lockedExchangeWallet() internal returns (bytes32 id, AllowlistRule rule) {
        id = _wallet(alice, "savings");
        rule = new AllowlistRule(address(accounts));
        vm.startPrank(alice);
        accounts.setRule(id, address(rule));
        rule.allow(id, EXCHANGE);
        accounts.lockRule(id);
        vm.stopPrank();
    }

    function test_lock_requiresRule_andOnlyOwner() public {
        bytes32 id = _wallet(alice, "savings");
        // can't lock a wallet with no rule (would brick it)
        vm.prank(alice);
        vm.expectRevert(KeylessAccounts.NoRule.selector);
        accounts.lockRule(id);

        AllowlistRule rule = new AllowlistRule(address(accounts));
        vm.prank(alice);
        accounts.setRule(id, address(rule));
        // a stranger cannot lock someone else's wallet
        vm.prank(bob);
        vm.expectRevert(KeylessAccounts.NotWalletOwner.selector);
        accounts.lockRule(id);
    }

    /// @notice THE control-key defense: once locked, even the owner key (i.e. a thief holding it) cannot
    ///         repoint the rule or widen the allowlist — so the account can only keep paying the exchange.
    function test_lock_defeatsStolenControlKey_butKeepsPaying() public {
        (bytes32 id, AllowlistRule rule) = _lockedExchangeWallet();
        assertTrue(accounts.isLocked(id));

        // attacker holds Alice's control key. Every path to redirect funds is frozen:
        AllowlistRule evil = new AllowlistRule(address(accounts));
        vm.startPrank(alice);
        vm.expectRevert(KeylessAccounts.Locked.selector);
        accounts.setRule(id, address(evil)); // can't repoint to a permissive rule
        vm.expectRevert(KeylessRuleBase.Locked.selector);
        rule.allow(id, ATTACKER); // can't widen the existing allowlist
        vm.stopPrank();

        // draining to the attacker is still refused...
        vm.expectRevert(abi.encodeWithSelector(KeylessRuleBase.Rejected.selector, "recipient not allowed"));
        accounts.pay{value: FEE}(id, ATTACKER, 5_000_000, bytes32("steal"));

        // ...while the account keeps working exactly as before: it still pays the exchange.
        accounts.pay{value: FEE}(id, EXCHANGE, 5_000_000, bytes32("ok"));
        assertEq(tee.lastRecipient(), EXCHANGE);
        assertEq(tee.lastAmount(), 5_000_000);
    }

    // --- exchange rule: allowlist + optional destination tag + optional per-tx cap ------------

    /// @dev The destination tag rides in the top 4 bytes of paymentReference (as the enclave reads it).
    function _tagRef(uint32 tag) internal pure returns (bytes32) {
        return bytes32(uint256(tag) << 224);
    }

    function test_exchange_paysAllowed_noTag() public {
        bytes32 id = _wallet(alice, "ex");
        ExchangeRule rule = new ExchangeRule(address(accounts));
        vm.startPrank(alice);
        accounts.setRule(id, address(rule));
        rule.allow(id, EXCHANGE); // plain address, no tag required
        vm.stopPrank();

        accounts.pay{value: FEE}(id, EXCHANGE, 5_000_000, bytes32("memo"));
        assertEq(tee.lastRecipient(), EXCHANGE);
        assertEq(tee.lastAmount(), 5_000_000);
    }

    function test_exchange_requiresExactTag() public {
        bytes32 id = _wallet(alice, "ex");
        ExchangeRule rule = new ExchangeRule(address(accounts));
        vm.startPrank(alice);
        accounts.setRule(id, address(rule));
        rule.allowWithTag(id, EXCHANGE, 777); // CEX deposit slot: tag 777 required
        vm.stopPrank();

        // right tag -> allowed
        accounts.pay{value: FEE}(id, EXCHANGE, 3_000_000, _tagRef(777));
        assertEq(tee.lastAmount(), 3_000_000);

        // wrong tag -> blocked (a stolen key can't redirect to a different deposit slot)
        uint256 before = tee.instructionCount();
        vm.expectRevert(abi.encodeWithSelector(KeylessRuleBase.Rejected.selector, "wrong destination tag"));
        accounts.pay{value: FEE}(id, EXCHANGE, 3_000_000, _tagRef(888));
        assertEq(tee.instructionCount(), before, "no instruction on wrong tag");
    }

    function test_exchange_maxPerTx() public {
        bytes32 id = _wallet(alice, "ex");
        ExchangeRule rule = new ExchangeRule(address(accounts));
        vm.startPrank(alice);
        accounts.setRule(id, address(rule));
        rule.allow(id, EXCHANGE);
        rule.setMaxPerTx(id, 5_000_000); // <= 5 XRP per payment
        vm.stopPrank();

        accounts.pay{value: FEE}(id, EXCHANGE, 5_000_000, bytes32("ok"));

        vm.expectRevert(abi.encodeWithSelector(KeylessRuleBase.Rejected.selector, "over per-tx limit"));
        accounts.pay{value: FEE}(id, EXCHANGE, 5_000_001, bytes32("too much"));
    }

    function test_exchange_rejectsUnlisted() public {
        bytes32 id = _wallet(alice, "ex");
        ExchangeRule rule = new ExchangeRule(address(accounts));
        vm.startPrank(alice);
        accounts.setRule(id, address(rule));
        rule.allow(id, EXCHANGE);
        vm.stopPrank();

        vm.expectRevert(abi.encodeWithSelector(KeylessRuleBase.Rejected.selector, "recipient not allowed"));
        accounts.pay{value: FEE}(id, ATTACKER, 1_000_000, bytes32("steal"));
    }

    // --- ScheduledRule (payroll / DCA) ---------------------------------------

    string constant PAYEE = "rALICEsalaryXXXXXXXXXXXXXXXXXXXXXXX";
    // 1 Feb 2027, 00:00 UTC. Also a Monday, so month-start and week-start coincide and the weekly
    // case can be checked against the same anchor.
    uint64 constant FEB_2027 = 1801440000;

    function _scheduled() internal returns (ScheduledRule r, bytes32 id) {
        r = new ScheduledRule(address(accounts));
        id = _wallet(alice, "payroll");
        vm.prank(alice);
        accounts.setRule(id, address(r));
    }

    function _monthly(string memory recipient, uint256 amount, uint32 runs)
        internal
        pure
        returns (ScheduledRule.LineInput[] memory ls)
    {
        ls = new ScheduledRule.LineInput[](1);
        ls[0] = ScheduledRule.LineInput({
            recipient: recipient,
            amount: amount,
            unit: CalendarLib.CAL_MONTH,
            offsetDays: 0,
            runs: runs,
            startAt: 0
        });
    }

    function test_scheduled_paysOnTheDueDateAndNotBefore() public {
        vm.warp(FEB_2027);
        (ScheduledRule r, bytes32 id) = _scheduled();
        vm.prank(alice);
        r.configure(id, _monthly(PAYEE, 500_000_000, 0));

        (uint64 due, uint256 owed) = r.nextRun(id);
        assertEq(due, FEB_2027 + 28 days, "first run is 1 March");
        assertEq(owed, 500_000_000);

        // A day early is still refused.
        vm.warp(due - 1);
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(
                KeylessRuleBase.Rejected.selector, "nothing scheduled is due for that recipient and amount"
            )
        );
        accounts.pay{value: FEE}(id, PAYEE, 500_000_000, bytes32("run"));

        vm.warp(due);
        vm.prank(agent); // permissionless: anyone may trigger a due line
        accounts.pay{value: FEE}(id, PAYEE, 500_000_000, bytes32("run"));
    }

    /// THE test. A trigger that has been dark for three months must pay exactly once on its return —
    /// `nextDue += period` would leave the line in the past and fire three times in a row.
    function test_scheduled_outageSkipsMissedRunsAndNeverAccrues() public {
        vm.warp(FEB_2027);
        (ScheduledRule r, bytes32 id) = _scheduled();
        vm.prank(alice);
        r.configure(id, _monthly(PAYEE, 500_000_000, 0));

        // Nothing runs through March, April and May. It is now mid-June.
        vm.warp(FEB_2027 + 135 days);
        vm.prank(agent);
        accounts.pay{value: FEE}(id, PAYEE, 500_000_000, bytes32("catchup"));

        // The single missed-window payment is all that is owed; the next is 1 July.
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(
                KeylessRuleBase.Rejected.selector, "nothing scheduled is due for that recipient and amount"
            )
        );
        accounts.pay{value: FEE}(id, PAYEE, 500_000_000, bytes32("again"));

        (uint64 due,) = r.nextRun(id);
        assertGt(due, block.timestamp, "next run must be in the future, not backfilled");
    }

    function test_scheduled_amountIsExactNotACap() public {
        vm.warp(FEB_2027);
        (ScheduledRule r, bytes32 id) = _scheduled();
        vm.prank(alice);
        r.configure(id, _monthly(PAYEE, 500_000_000, 0));
        vm.warp(FEB_2027 + 28 days);

        // Under a cap-style rule 499 XRP would sail through. Here only the pinned amount is a match —
        // a hijacked trigger gets no discretion at all, in either direction.
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(
                KeylessRuleBase.Rejected.selector, "nothing scheduled is due for that recipient and amount"
            )
        );
        accounts.pay{value: FEE}(id, PAYEE, 499_000_000, bytes32("shave"));

        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(
                KeylessRuleBase.Rejected.selector, "nothing scheduled is due for that recipient and amount"
            )
        );
        accounts.pay{value: FEE}(id, PAYEE, 501_000_000, bytes32("top up"));
    }

    function test_scheduled_unscheduledPayeeIsRefused() public {
        vm.warp(FEB_2027);
        (ScheduledRule r, bytes32 id) = _scheduled();
        vm.prank(alice);
        r.configure(id, _monthly(PAYEE, 500_000_000, 0));
        vm.warp(FEB_2027 + 28 days);

        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(
                KeylessRuleBase.Rejected.selector, "nothing scheduled is due for that recipient and amount"
            )
        );
        accounts.pay{value: FEE}(id, ATTACKER, 500_000_000, bytes32("steal"));
    }

    function test_scheduled_runsLeftExhaustsAndStops() public {
        vm.warp(FEB_2027);
        (ScheduledRule r, bytes32 id) = _scheduled();
        vm.prank(alice);
        r.configure(id, _monthly(PAYEE, 500_000_000, 2)); // "stop after 2 payments"

        for (uint256 i = 0; i < 2; ++i) {
            (uint64 due,) = r.nextRun(id);
            vm.warp(due);
            vm.prank(agent);
            accounts.pay{value: FEE}(id, PAYEE, 500_000_000, bytes32("run"));
        }

        vm.warp(block.timestamp + 60 days);
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(
                KeylessRuleBase.Rejected.selector, "nothing scheduled is due for that recipient and amount"
            )
        );
        accounts.pay{value: FEE}(id, PAYEE, 500_000_000, bytes32("third"));

        (uint64 dueAfter, uint256 owed) = r.nextRun(id);
        assertEq(dueAfter, 0, "an exhausted schedule owes nothing");
        assertEq(owed, 0);
        assertFalse(r.hasUnlimitedLine(id));
    }

    function test_scheduled_hasUnlimitedLine_flagsTheLockFootgun() public {
        vm.warp(FEB_2027);
        (ScheduledRule r, bytes32 id) = _scheduled();
        vm.prank(alice);
        r.configure(id, _monthly(PAYEE, 500_000_000, 0));
        // The UI reads this to refuse locking: locked + endless = an irrevocable standing order.
        assertTrue(r.hasUnlimitedLine(id));
    }

    function test_scheduled_offsetLandsOnTheFifteenth() public {
        vm.warp(FEB_2027);
        (ScheduledRule r, bytes32 id) = _scheduled();
        ScheduledRule.LineInput[] memory ls = _monthly(PAYEE, 100, 0);
        ls[0].offsetDays = 14;
        vm.prank(alice);
        r.configure(id, ls);

        (uint64 due,) = r.nextRun(id);
        assertEq(due, FEB_2027 + 14 days, "15 February, not 15 March: this month slot is still ahead");
    }

    function test_scheduled_offsetBeyondTheWindowIsRejected() public {
        vm.warp(FEB_2027);
        (ScheduledRule r, bytes32 id) = _scheduled();
        ScheduledRule.LineInput[] memory ls = _monthly(PAYEE, 100, 0);
        ls[0].offsetDays = 28; // would spill out of February
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(KeylessRuleBase.Rejected.selector, "offset outside the window"));
        r.configure(id, ls);
    }

    function test_scheduled_multipleLinesEachTrackTheirOwnSlot() public {
        vm.warp(FEB_2027);
        (ScheduledRule r, bytes32 id) = _scheduled();
        ScheduledRule.LineInput[] memory ls = new ScheduledRule.LineInput[](2);
        ls[0] = ScheduledRule.LineInput(PAYEE, 500_000_000, CalendarLib.CAL_MONTH, 0, 0, 0);
        ls[1] = ScheduledRule.LineInput(EXCHANGE, 300_000_000, CalendarLib.CAL_MONTH, 0, 0, 0);
        vm.prank(alice);
        r.configure(id, ls);

        (uint64 due, uint256 owed) = r.nextRun(id);
        assertEq(owed, 800_000_000, "both lines fall due the same day");

        vm.warp(due);
        vm.prank(agent);
        accounts.pay{value: FEE}(id, PAYEE, 500_000_000, bytes32("alice"));
        // Paying Alice must not consume Bob's slot.
        vm.prank(agent);
        accounts.pay{value: FEE}(id, EXCHANGE, 300_000_000, bytes32("bob"));

        // ...and neither can run twice in the same month.
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(
                KeylessRuleBase.Rejected.selector, "nothing scheduled is due for that recipient and amount"
            )
        );
        accounts.pay{value: FEE}(id, PAYEE, 500_000_000, bytes32("twice"));
    }

    function test_scheduled_onlyOwnerConfigures_andLockFreezesTheSchedule() public {
        vm.warp(FEB_2027);
        (ScheduledRule r, bytes32 id) = _scheduled();
        vm.prank(alice);
        r.configure(id, _monthly(PAYEE, 500_000_000, 3));

        vm.prank(bob);
        vm.expectRevert(KeylessRuleBase.NotWalletOwner.selector);
        r.configure(id, _monthly(ATTACKER, 500_000_000, 0));

        vm.prank(alice);
        accounts.lockRule(id);

        // A stolen control key can no longer add a payee or cancel the plan.
        vm.prank(alice);
        vm.expectRevert(KeylessRuleBase.Locked.selector);
        r.configure(id, _monthly(ATTACKER, 1, 0));
        vm.prank(alice);
        vm.expectRevert(KeylessRuleBase.Locked.selector);
        r.cancel(id);

        // But the frozen schedule keeps paying.
        (uint64 due,) = r.nextRun(id);
        vm.warp(due);
        vm.prank(agent);
        accounts.pay{value: FEE}(id, PAYEE, 500_000_000, bytes32("still runs"));
    }

    function test_scheduled_cancelStopsEverything() public {
        vm.warp(FEB_2027);
        (ScheduledRule r, bytes32 id) = _scheduled();
        vm.prank(alice);
        r.configure(id, _monthly(PAYEE, 500_000_000, 0));
        vm.prank(alice);
        r.cancel(id);

        vm.warp(FEB_2027 + 28 days);
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(
                KeylessRuleBase.Rejected.selector, "nothing scheduled is due for that recipient and amount"
            )
        );
        accounts.pay{value: FEE}(id, PAYEE, 500_000_000, bytes32("after cancel"));
    }

    function test_scheduled_tooManyLinesIsRejected() public {
        (ScheduledRule r, bytes32 id) = _scheduled();
        uint256 n = r.MAX_LINES() + 1;
        ScheduledRule.LineInput[] memory ls = new ScheduledRule.LineInput[](n);
        for (uint256 i = 0; i < n; ++i) {
            ls[i] = ScheduledRule.LineInput(PAYEE, 1, CalendarLib.CAL_MONTH, 0, 0, 0);
        }
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(KeylessRuleBase.Rejected.selector, "too many scheduled payments"));
        r.configure(id, ls);
    }

    function test_scheduled_weeklyLandsOnMonday() public {
        vm.warp(FEB_2027); // 1 Feb 2027 is a Monday
        (ScheduledRule r, bytes32 id) = _scheduled();
        ScheduledRule.LineInput[] memory ls = _monthly(PAYEE, 100, 12); // "12 weeks of DCA"
        ls[0].unit = CalendarLib.CAL_WEEK;
        vm.prank(alice);
        r.configure(id, ls);

        (uint64 due,) = r.nextRun(id);
        assertEq(due, FEB_2027 + 7 days, "the following Monday");
        assertEq(uint256(due) / 86400 % 7, 4, "unix day 0 is a Thursday, so Mondays are day % 7 == 4");
    }
}

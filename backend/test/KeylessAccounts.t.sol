// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {KeylessAccounts} from "../src/KeylessAccounts.sol";
import {AllowlistRule} from "../src/rules/AllowlistRule.sol";
import {RateLimitRule} from "../src/rules/RateLimitRule.sol";
import {SubscriptionRule} from "../src/rules/SubscriptionRule.sol";
import {FdcEscrowRule} from "../src/rules/FdcEscrowRule.sol";
import {KeylessRuleBase} from "../src/rules/KeylessRuleBase.sol";
import {IFlareTeeManager} from "../src/interfaces/IFlareTeeManager.sol";
import {IWeb2Json} from "../src/interfaces/IFdc.sol";
import {MockFlareTeeManager, MockFdcVerification} from "./Mocks.sol";

contract KeylessAccountsTest is Test {
    MockFlareTeeManager tee;
    KeylessAccounts accounts;

    uint256 constant EXT_ID = 454;
    uint256 constant FEE = 1000;
    address constant CLAIMBACK = address(0xC1a1);

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address agent = makeAddr("agent");
    string constant EXCHANGE = "rEXCHANGEdepositXXXXXXXXXXXXXXXXXXX";
    string constant ATTACKER = "rATTACKERwalletXXXXXXXXXXXXXXXXXXXX";

    function setUp() public {
        tee = new MockFlareTeeManager();
        address[] memory m = new address[](1);
        m[0] = makeAddr("teeMachine");
        tee.setMachines(m);

        accounts = new KeylessAccounts(IFlareTeeManager(address(tee)), EXT_ID, CLAIMBACK);
        tee.setInstructionsSender(address(accounts)); // simulate Flare binding

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

    function test_pay_revertsWithoutRule() public {
        bytes32 id = _wallet(alice, "main");
        vm.expectRevert(KeylessAccounts.NoRule.selector);
        accounts.pay{value: FEE}(id, EXCHANGE, 1_000_000, bytes32("r"));
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
        rule.configure(id, 10_000_000, 1 days); // max 10 XRP/day
        vm.stopPrank();

        // agent spends up to the cap across calls
        vm.startPrank(agent);
        accounts.pay{value: FEE}(id, EXCHANGE, 6_000_000, bytes32("a"));
        accounts.pay{value: FEE}(id, EXCHANGE, 4_000_000, bytes32("b")); // now at 10M
        // one more drop over the cap in the same window -> blocked
        vm.expectRevert(abi.encodeWithSelector(KeylessRuleBase.Rejected.selector, "rate limit exceeded"));
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
        rule.configure(id, 10_000_000, 1 days);
        vm.stopPrank();

        // a hijacked agent tries the attacker; not allowlisted -> blocked regardless of the cap
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(KeylessRuleBase.Rejected.selector, "recipient not allowed"));
        accounts.pay{value: FEE}(id, ATTACKER, 1_000_000, bytes32("x"));
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

    // --- FDC escrow rule: pay when the world proves the condition -------------

    /// @dev A Web2Json proof whose attested payload is `data`. merkleProof is empty — the mock verifier
    ///      stands in for the real Merkle-root check, so only the payload matters here.
    function _proof(bytes memory data) internal pure returns (IWeb2Json.Proof memory p) {
        p.data.votingRound = 5830;
        p.data.responseBody.abiEncodedData = data;
    }

    function _escrowWallet(FdcEscrowRule rule, bytes32 conditionHash) internal returns (bytes32 id) {
        id = _wallet(alice, "escrow");
        vm.startPrank(alice);
        accounts.setRule(id, address(rule));
        rule.configure(id, EXCHANGE, 10_000_000, conditionHash); // pay supplier up to 10 XRP on proof
        vm.stopPrank();
    }

    function test_escrow_locksUntilConditionProven_thenPays() public {
        MockFdcVerification fdc = new MockFdcVerification();
        FdcEscrowRule rule = new FdcEscrowRule(address(accounts), address(fdc));
        bytes memory delivered = abi.encode(true); // the attested "delivery == true" payload
        bytes32 id = _escrowWallet(rule, keccak256(delivered));

        // before proof: even the escrow's own payee cannot be paid, and no instruction reaches the enclave
        uint256 before = tee.instructionCount();
        vm.expectRevert(abi.encodeWithSelector(KeylessRuleBase.Rejected.selector, "condition not proven"));
        accounts.pay{value: FEE}(id, EXCHANGE, 5_000_000, bytes32("e"));
        assertEq(tee.instructionCount(), before, "no instruction before the condition is proven");

        // anyone submits the FDC proof of delivery; the proof is the trust, not the sender
        vm.prank(bob);
        rule.release(id, _proof(delivered));

        // now the supplier can be paid, within the cap
        accounts.pay{value: FEE}(id, EXCHANGE, 6_000_000, bytes32("e1"));
        assertEq(tee.lastRecipient(), EXCHANGE);
        assertEq(tee.lastAmount(), 6_000_000);
        assertEq(tee.lastWalletId(), id);
    }

    function test_escrow_rejectsUnverifiedProof() public {
        MockFdcVerification fdc = new MockFdcVerification();
        fdc.setResult(false); // FDC says: not attested
        FdcEscrowRule rule = new FdcEscrowRule(address(accounts), address(fdc));
        bytes memory delivered = abi.encode(true);
        bytes32 id = _escrowWallet(rule, keccak256(delivered));

        vm.expectRevert(FdcEscrowRule.ProofNotVerified.selector);
        rule.release(id, _proof(delivered));
    }

    function test_escrow_rejectsWrongCondition() public {
        MockFdcVerification fdc = new MockFdcVerification();
        FdcEscrowRule rule = new FdcEscrowRule(address(accounts), address(fdc));
        bytes32 id = _escrowWallet(rule, keccak256(abi.encode(true)));

        // a verified proof, but of the wrong outcome (delivery == false) -> condition mismatch
        vm.expectRevert(FdcEscrowRule.ConditionMismatch.selector);
        rule.release(id, _proof(abi.encode(false)));
    }

    function test_escrow_enforcesPayeeAndCapAfterRelease() public {
        MockFdcVerification fdc = new MockFdcVerification();
        FdcEscrowRule rule = new FdcEscrowRule(address(accounts), address(fdc));
        bytes memory delivered = abi.encode(true);
        bytes32 id = _escrowWallet(rule, keccak256(delivered));
        rule.release(id, _proof(delivered));

        // released funds still can't be redirected to the attacker
        vm.expectRevert(abi.encodeWithSelector(KeylessRuleBase.Rejected.selector, "recipient is not the escrow payee"));
        accounts.pay{value: FEE}(id, ATTACKER, 1_000_000, bytes32("x"));

        // nor exceed the escrow cap across releases
        accounts.pay{value: FEE}(id, EXCHANGE, 10_000_000, bytes32("e1"));
        vm.expectRevert(abi.encodeWithSelector(KeylessRuleBase.Rejected.selector, "over escrow cap"));
        accounts.pay{value: FEE}(id, EXCHANGE, 1, bytes32("e2"));
    }

    function test_escrow_ownerCancelsAndOnlyOwnerConfigures() public {
        MockFdcVerification fdc = new MockFdcVerification();
        FdcEscrowRule rule = new FdcEscrowRule(address(accounts), address(fdc));
        bytes memory delivered = abi.encode(true);
        bytes32 id = _escrowWallet(rule, keccak256(delivered));

        // a stranger cannot reconfigure the escrow
        vm.prank(bob);
        vm.expectRevert(KeylessRuleBase.NotWalletOwner.selector);
        rule.configure(id, ATTACKER, 1, keccak256("x"));

        // owner cancels; even a valid proof can't revive it
        vm.prank(alice);
        rule.cancel(id);
        vm.expectRevert(abi.encodeWithSelector(KeylessRuleBase.Rejected.selector, "no active escrow"));
        rule.release(id, _proof(delivered));
    }
}

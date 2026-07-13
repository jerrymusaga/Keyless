// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {KeylessDemoPolicy} from "../src/policies/KeylessDemoPolicy.sol";
import {KeylessRedemptionPolicy} from "../src/policies/KeylessRedemptionPolicy.sol";
import {AuthorizedPayPolicy} from "../src/AuthorizedPayPolicy.sol";
import {IAssetManager, RedemptionRequestInfo} from "../src/interfaces/IAssetManager.sol";
import {IFlareTeeManager} from "../src/interfaces/IFlareTeeManager.sol";
import {MockFlareTeeManager, MockAssetManager} from "./Mocks.sol";

contract KeylessTest is Test {
    MockFlareTeeManager tee;
    MockAssetManager am;

    uint256 constant EXT_ID = 454; // our live extension on Coston2
    bytes32 constant WALLET_ID = bytes32("wallet-1");
    string constant XRPL_ACCOUNT = "rKEYLESSaccountXXXXXXXXXXXXXXXXXXXX";
    string constant REDEEMER = "rREDEEMERaddressYYYYYYYYYYYYYYYYYYY";
    string constant OPERATOR_WALLET = "rOPERATORgreedXXXXXXXXXXXXXXXXXXXXX";
    address constant CLAIMBACK = address(0xC1a1);

    uint256 constant FEE = 1000;

    address operator = makeAddr("operator");
    address anyone = makeAddr("anyone");

    function setUp() public {
        tee = new MockFlareTeeManager();
        am = new MockAssetManager();

        address[] memory machines = new address[](1);
        machines[0] = makeAddr("teeMachine");
        tee.setMachines(machines);

        vm.deal(operator, 1 ether);
        vm.deal(anyone, 1 ether);
        vm.deal(address(this), 1 ether);
    }

    // ---------------------------------------------------------------
    // Demo policy: real-money path + the adversary beat
    // ---------------------------------------------------------------

    function _deployDemo() internal returns (KeylessDemoPolicy p) {
        p = new KeylessDemoPolicy(
            IFlareTeeManager(address(tee)), EXT_ID, WALLET_ID, XRPL_ACCOUNT, CLAIMBACK
        );
        // Simulate Flare binding this policy as the extension's instructions sender.
        tee.setInstructionsSender(address(p));
    }

    function test_demo_paysAllowlistedRecipient() public {
        KeylessDemoPolicy p = _deployDemo();
        p.allowRecipient(REDEEMER);

        bytes32 id = p.pay{value: FEE}(REDEEMER, 1_000_000, bytes32("ref1"));

        assertEq(id, bytes32(uint256(1)));
        assertEq(tee.lastRecipient(), REDEEMER);
        assertEq(tee.lastAmount(), 1_000_000);
        assertEq(tee.lastWalletId(), WALLET_ID, "must instruct the right wallet");
        assertEq(tee.lastOpType(), p.OP_TYPE(), "must not use a system opType");
    }

    /// @notice THE DEMO BEAT: the operator holds every key on the box and still cannot pay themselves.
    ///         The instruction is never even sent — the enclave never sees a payment to sign.
    function test_demo_operatorCannotPaySelf() public {
        KeylessDemoPolicy p = _deployDemo();
        p.allowRecipient(REDEEMER); // only the legitimate destination is allowed

        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(AuthorizedPayPolicy.PolicyRejected.selector, "recipient not allowlisted")
        );
        p.pay{value: FEE}(OPERATOR_WALLET, 999_000_000, bytes32("steal"));

        assertEq(tee.instructionCount(), 0, "no instruction may reach the enclave");
    }

    /// @notice A payment must be handed to EXACTLY ONE machine. Each machine that receives a PAY
    ///         instruction independently signs and submits an XRPL transaction, so fanning out to
    ///         every active machine would pay the recipient once per machine — a silent double-spend
    ///         that scales with how decentralized the extension is.
    function test_demo_paymentGoesToExactlyOneMachine() public {
        address[] memory many = new address[](3);
        many[0] = makeAddr("tee1");
        many[1] = makeAddr("tee2");
        many[2] = makeAddr("tee3");
        tee.setMachines(many);

        KeylessDemoPolicy p = _deployDemo();
        p.allowRecipient(REDEEMER);
        p.pay{value: FEE}(REDEEMER, 1_000_000, bytes32("ref"));

        assertEq(tee.lastTeeIdCount(), 1, "payment must fan out to exactly one machine");
    }

    function test_demo_rejectsZeroAmount() public {
        KeylessDemoPolicy p = _deployDemo();
        p.allowRecipient(REDEEMER);
        vm.expectRevert(abi.encodeWithSelector(AuthorizedPayPolicy.PolicyRejected.selector, "zero amount"));
        p.pay{value: FEE}(REDEEMER, 0, bytes32("ref"));
    }

    function test_demo_onlyOwnerManagesAllowlist() public {
        KeylessDemoPolicy p = _deployDemo();
        vm.prank(anyone);
        vm.expectRevert(KeylessDemoPolicy.NotOwner.selector);
        p.allowRecipient(REDEEMER);
    }

    /// @notice Until Flare binds this contract as the instructions sender, the enclave ignores it.
    function test_demo_unboundPolicyCannotInstruct() public {
        KeylessDemoPolicy p = new KeylessDemoPolicy(
            IFlareTeeManager(address(tee)), EXT_ID, WALLET_ID, XRPL_ACCOUNT, CLAIMBACK
        );
        p.allowRecipient(REDEEMER);
        assertFalse(p.isBound());

        vm.expectRevert("OnlyInstructionsSender");
        p.pay{value: FEE}(REDEEMER, 1000, bytes32("ref"));
    }

    function test_demo_revertsWithoutFee() public {
        KeylessDemoPolicy p = _deployDemo();
        p.allowRecipient(REDEEMER);
        vm.expectRevert(abi.encodeWithSelector(AuthorizedPayPolicy.InsufficientFee.selector, FEE, 0));
        p.pay(REDEEMER, 1000, bytes32("ref"));
    }

    // ---------------------------------------------------------------
    // Redemption policy: the flagship
    // ---------------------------------------------------------------

    function _deployRedemption() internal returns (KeylessRedemptionPolicy p) {
        p = new KeylessRedemptionPolicy(
            IFlareTeeManager(address(tee)),
            EXT_ID,
            WALLET_ID,
            XRPL_ACCOUNT,
            CLAIMBACK,
            IAssetManager(address(am))
        );
        tee.setInstructionsSender(address(p));
    }

    function _sampleRedemption(uint256 id) internal view returns (RedemptionRequestInfo.Data memory r) {
        r.redemptionRequestId = uint64(id);
        r.status = RedemptionRequestInfo.Status.ACTIVE;
        r.redeemer = address(0xBEEF);
        r.paymentAddress = REDEEMER;
        r.paymentReference = bytes32("redref");
        r.valueUBA = 5_000_000;
        r.feeUBA = 100_000; // payout = 4_900_000
        r.lastUnderlyingBlock = 1000;
        r.lastUnderlyingTimestamp = uint64(block.timestamp + 900);
    }

    function test_redemption_paysExactProtocolAmount() public {
        KeylessRedemptionPolicy p = _deployRedemption();
        am.setRedemption(7, _sampleRedemption(7));

        vm.prank(anyone); // permissionless: params are forced from protocol state
        bytes32 id = p.payRedemption{value: FEE}(7);

        assertEq(id, bytes32(uint256(1)));
        assertEq(tee.lastRecipient(), REDEEMER, "recipient must be redeemer's address");
        assertEq(tee.lastAmount(), 4_900_000, "amount must be valueUBA - feeUBA");
        assertEq(tee.lastReference(), bytes32("redref"), "memo must be paymentReference");
    }

    /// @notice THE DOUBLE-PAY GUARD. The AssetManager only reverts once the payment is CONFIRMED,
    ///         which is minutes away. Until then the request is still ACTIVE — so without an
    ///         explicit guard, a permissionless payRedemption could drain the agent by re-authorizing
    ///         the same payout. Here the request is still perfectly ACTIVE and it still reverts.
    function test_redemption_cannotDoublePayWhileStillActive() public {
        KeylessRedemptionPolicy p = _deployRedemption();
        am.setRedemption(7, _sampleRedemption(7));

        p.payRedemption{value: FEE}(7);
        assertEq(tee.instructionCount(), 1);

        vm.prank(anyone);
        vm.expectRevert(abi.encodeWithSelector(KeylessRedemptionPolicy.RedemptionAlreadyPaid.selector, 7));
        p.payRedemption{value: FEE}(7);

        assertEq(tee.instructionCount(), 1, "enclave must not be told to pay twice");
    }

    /// @notice Belt and braces: once confirmed, the AssetManager read reverts on its own.
    function test_redemption_cannotReplayAfterConfirm() public {
        KeylessRedemptionPolicy p = _deployRedemption();
        am.setRedemption(8, _sampleRedemption(8));
        p.payRedemption{value: FEE}(8);

        am.confirmAndDelete(8); // real protocol deletes the request on confirmation
        vm.expectRevert(abi.encodeWithSelector(KeylessRedemptionPolicy.RedemptionAlreadyPaid.selector, 8));
        p.payRedemption{value: FEE}(8);
    }

    function test_redemption_rejectsDefaulted() public {
        KeylessRedemptionPolicy p = _deployRedemption();
        RedemptionRequestInfo.Data memory r = _sampleRedemption(9);
        r.status = RedemptionRequestInfo.Status.DEFAULTED;
        am.setRedemption(9, r);

        vm.expectRevert(abi.encodeWithSelector(KeylessRedemptionPolicy.RedemptionNotActive.selector, 9));
        p.payRedemption{value: FEE}(9);
    }

    /// @notice The flagship's adversary beat: there is no function that pays anyone but the redeemer.
    ///         The operator cannot supply a destination at all — payRedemption(uint256) is the entire
    ///         external surface, and every field is read from the AssetManager.
    function test_redemption_operatorCannotChooseDestination() public {
        KeylessRedemptionPolicy p = _deployRedemption();
        am.setRedemption(11, _sampleRedemption(11));

        // The operator's only lever is *which* redemption to pay. Not who gets paid.
        vm.prank(operator);
        p.payRedemption{value: FEE}(11);

        assertEq(tee.lastRecipient(), REDEEMER, "operator cannot redirect the payout");
        assertTrue(
            keccak256(bytes(tee.lastRecipient())) != keccak256(bytes(OPERATOR_WALLET)),
            "operator address is unreachable by construction"
        );
    }
}

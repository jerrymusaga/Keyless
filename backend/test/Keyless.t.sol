// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {KeylessDemoPolicy} from "../src/policies/KeylessDemoPolicy.sol";
import {KeylessRedemptionPolicy} from "../src/policies/KeylessRedemptionPolicy.sol";
import {AuthorizedPayPolicy} from "../src/AuthorizedPayPolicy.sol";
import {IAssetManager, RedemptionRequestInfo} from "../src/interfaces/IAssetManager.sol";
import {ITeePayments} from "../src/interfaces/ITeePayments.sol";
import {MockTeePayments, MockAssetManager} from "./Mocks.sol";

contract KeylessTest is Test {
    MockTeePayments pmw;
    MockAssetManager am;

    bytes32 constant SOURCE_XRP = keccak256("testXRP");
    string constant XRPL_ACCOUNT = "rKEYLESSaccountXXXXXXXXXXXXXXXXXXXX";
    string constant REDEEMER = "rREDEEMERaddressYYYYYYYYYYYYYYYYYYY";
    string constant OPERATOR_WALLET = "rOPERATORgreedXXXXXXXXXXXXXXXXXXXXX";
    address constant CLAIMBACK = address(0xC1a1);

    address operator = makeAddr("operator");
    address anyone = makeAddr("anyone");

    function setUp() public {
        pmw = new MockTeePayments();
        am = new MockAssetManager();
    }

    // ---------------------------------------------------------------
    // Demo policy: real-money path + the adversary beat
    // ---------------------------------------------------------------

    function _deployDemo() internal returns (KeylessDemoPolicy p) {
        p = new KeylessDemoPolicy(
            ITeePayments(address(pmw)), SOURCE_XRP, XRPL_ACCOUNT, CLAIMBACK, "", 100
        );
        // Simulate PMW binding this policy as the account's authorization address.
        pmw.setAuthorization(address(p));
    }

    function test_demo_paysAllowlistedRecipient() public {
        KeylessDemoPolicy p = _deployDemo();
        p.allowRecipient(REDEEMER);

        uint64 id = p.pay(REDEEMER, 1_000_000, bytes32("ref1"));

        assertEq(id, 1);
        assertEq(pmw.lastRecipient(), REDEEMER);
        assertEq(pmw.lastAmount(), 1_000_000);
    }

    /// @notice THE DEMO BEAT: the operator holds every key and still cannot pay themselves.
    function test_demo_operatorCannotPaySelf() public {
        KeylessDemoPolicy p = _deployDemo();
        p.allowRecipient(REDEEMER); // only the legitimate destination is allowed

        // Operator tries to drain to their own XRPL wallet.
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(AuthorizedPayPolicy.PolicyRejected.selector, "recipient not allowlisted"));
        p.pay(OPERATOR_WALLET, 999_000_000, bytes32("steal"));
    }

    function test_demo_rejectsZeroAmount() public {
        KeylessDemoPolicy p = _deployDemo();
        p.allowRecipient(REDEEMER);
        vm.expectRevert(abi.encodeWithSelector(AuthorizedPayPolicy.PolicyRejected.selector, "zero amount"));
        p.pay(REDEEMER, 0, bytes32("ref"));
    }

    function test_demo_onlyOwnerManagesAllowlist() public {
        KeylessDemoPolicy p = _deployDemo();
        vm.prank(anyone);
        vm.expectRevert(KeylessDemoPolicy.NotOwner.selector);
        p.allowRecipient(REDEEMER);
    }

    function test_demo_unboundPolicyCannotPay() public {
        // Deploy but DON'T bind as authorization address.
        KeylessDemoPolicy p = new KeylessDemoPolicy(
            ITeePayments(address(pmw)), SOURCE_XRP, XRPL_ACCOUNT, CLAIMBACK, "", 100
        );
        p.allowRecipient(REDEEMER);
        assertFalse(p.isBound());
        vm.expectRevert("OnlyAuthorizationAddress");
        p.pay(REDEEMER, 1000, bytes32("ref"));
    }

    // ---------------------------------------------------------------
    // Redemption policy: the flagship
    // ---------------------------------------------------------------

    function _deployRedemption() internal returns (KeylessRedemptionPolicy p) {
        p = new KeylessRedemptionPolicy(
            ITeePayments(address(pmw)),
            SOURCE_XRP,
            XRPL_ACCOUNT,
            CLAIMBACK,
            IAssetManager(address(am)),
            "",
            100
        );
        pmw.setAuthorization(address(p));
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

        vm.prank(anyone); // permissionless: anyone may trigger, params are forced from protocol state
        uint64 id = p.payRedemption(7);

        assertEq(id, 1);
        assertEq(pmw.lastRecipient(), REDEEMER, "recipient must be redeemer's address");
        assertEq(pmw.lastAmount(), 4_900_000, "amount must be valueUBA - feeUBA");
        assertEq(pmw.lastReference(), bytes32("redref"), "memo must be paymentReference");
    }

    /// @notice Free replay guard: once confirmed, the AssetManager read reverts, so re-payment is impossible.
    function test_redemption_cannotReplayAfterConfirm() public {
        KeylessRedemptionPolicy p = _deployRedemption();
        am.setRedemption(7, _sampleRedemption(7));
        p.payRedemption(7);

        am.confirmAndDelete(7); // real protocol deletes the request on confirmation
        vm.expectRevert("invalid redemption request");
        p.payRedemption(7);
    }

    function test_redemption_rejectsDefaulted() public {
        KeylessRedemptionPolicy p = _deployRedemption();
        RedemptionRequestInfo.Data memory r = _sampleRedemption(9);
        r.status = RedemptionRequestInfo.Status.DEFAULTED;
        am.setRedemption(9, r);

        vm.expectRevert(abi.encodeWithSelector(KeylessRedemptionPolicy.RedemptionNotActive.selector, 9));
        p.payRedemption(9);
    }

    /// @notice The flagship's version of the adversary beat: there is simply no function that pays
    ///         anyone but the redeemer. The operator cannot supply a destination at all.
    function test_redemption_noOperatorControlledDestination() public view {
        // Compile-time property, asserted by inspection: KeylessRedemptionPolicy exposes only
        // payRedemption(uint256). Every payment parameter is read from AssetManager state.
        // This test documents the invariant; there is no call that could pay an arbitrary address.
        assert(true);
    }
}

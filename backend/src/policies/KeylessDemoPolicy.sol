// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {AuthorizedPayPolicy} from "../AuthorizedPayPolicy.sol";
import {ITeePayments} from "../interfaces/ITeePayments.sol";
import {PMWTypes} from "../interfaces/PMWTypes.sol";

/// @title KeylessDemoPolicy
/// @notice A minimal policy you can drive END TO END TODAY — real XRP moving on XRPL testnet
///         through the same PMW pay() path as the flagship, with NO FAssets agent status required.
///
/// @dev Why this exists: KeylessRedemptionPolicy only goes live once you're whitelisted as an
///      agent (governance-gated). To show real money moving in the demo without waiting on that,
///      this policy permits payments only to an owner-curated allowlist of XRPL destinations.
///
///      This is what powers the "watch me try to cheat and fail" demo beat:
///        - Owner pre-approves a legitimate destination, pays it → succeeds, real XRP moves.
///        - Operator (holding every key) tries to pay their OWN address → _checkPolicy reverts,
///          because it isn't on the allowlist. The audience can read the four lines that make it
///          impossible.
///
///      The allowlist is a stand-in for "a policy"; the point being demonstrated is that the
///      account can ONLY do what the contract permits, regardless of who runs the machine.
contract KeylessDemoPolicy is AuthorizedPayPolicy {
    address public owner;

    /// @notice XRPL destination string => allowed.
    mapping(bytes32 => bool) public allowedRecipient;

    bytes internal xrpTokenId;
    uint256 public immutable maxFee;

    event RecipientAllowed(string recipient);
    event RecipientRemoved(string recipient);
    event OwnerChanged(address indexed newOwner);

    error NotOwner();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(
        ITeePayments _teePayments,
        bytes32 _sourceId,
        string memory _accountAddress,
        address _claimBackAddress,
        bytes memory _xrpTokenId,
        uint256 _maxFee
    ) AuthorizedPayPolicy(_teePayments, _sourceId, _accountAddress, _claimBackAddress) {
        owner = msg.sender;
        xrpTokenId = _xrpTokenId;
        maxFee = _maxFee;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        owner = newOwner;
        emit OwnerChanged(newOwner);
    }

    /// @notice Add an XRPL destination to the allowlist.
    function allowRecipient(string calldata recipient) external onlyOwner {
        allowedRecipient[keccak256(bytes(recipient))] = true;
        emit RecipientAllowed(recipient);
    }

    /// @notice Remove an XRPL destination from the allowlist.
    function removeRecipient(string calldata recipient) external onlyOwner {
        allowedRecipient[keccak256(bytes(recipient))] = false;
        emit RecipientRemoved(recipient);
    }

    /// @notice Pay an allowlisted destination. Anyone may call — the allowlist is the gate, not msg.sender.
    function pay(string calldata recipient, uint256 amount, bytes32 paymentReference)
        external
        returns (uint64 paymentId)
    {
        paymentId = _authorizedPay(recipient, xrpTokenId, amount, maxFee, paymentReference);
    }

    /// @notice Reissue a stalled demo payment with bumped fees (owner only).
    function reissue(
        uint64 paymentId,
        PMWTypes.PaymentInstruction[] calldata instructions,
        PMWTypes.ReissueFeeParams calldata feeParams
    ) external onlyOwner returns (bool finalized) {
        finalized = _reissue(paymentId, instructions, feeParams);
    }

    /// @notice The policy: only allowlisted recipients, non-zero amount. Four lines. Read them.
    function _checkPolicy(string memory recipient, uint256 amount, bytes32) internal view override {
        if (amount == 0) revert PolicyRejected("zero amount");
        if (!allowedRecipient[keccak256(bytes(recipient))]) revert PolicyRejected("recipient not allowlisted");
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {AuthorizedPayPolicy} from "../AuthorizedPayPolicy.sol";
import {IFlareTeeManager} from "../interfaces/IFlareTeeManager.sol";

/// @title KeylessDemoPolicy
/// @notice A minimal policy you can drive END TO END TODAY — real XRP moving on XRPL testnet, signed
///         inside the enclave, through the same instruction path as the flagship, with NO FAssets
///         agent status required.
///
/// @dev Why this exists: KeylessRedemptionPolicy only goes live once the enclave's XRPL account is
///      registered as an FAssets agent's underlying address, which is governance-gated. To show real
///      money moving without waiting on that, this policy permits payments only to an owner-curated
///      allowlist of XRPL destinations.
///
///      This is what powers the "watch me try to cheat and fail" demo beat:
///        - Owner allowlists a legitimate destination, pays it → the enclave signs, real XRP moves.
///        - Operator (holding every key on the box, root on the machine) tries to pay their OWN
///          address → _checkPolicy reverts. No instruction is ever sent, so the enclave never sees
///          a payment to sign. The audience can read the two lines that make it impossible.
///
///      Note there is no reissue()/retry entrypoint that takes caller-supplied payment details. Any
///      such function would be a hole straight through the policy — a way to hand the enclave a
///      destination that `_checkPolicy` never saw. Retries belong to the enclave, which re-derives
///      every field from the instruction this contract already authorized.
contract KeylessDemoPolicy is AuthorizedPayPolicy {
    address public owner;

    /// @notice keccak(XRPL destination string) => allowed.
    mapping(bytes32 => bool) public allowedRecipient;

    event RecipientAllowed(string recipient);
    event RecipientRemoved(string recipient);
    event OwnerChanged(address indexed newOwner);

    error NotOwner();
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(
        IFlareTeeManager _teeManager,
        uint256 _extensionId,
        bytes32 _walletId,
        string memory _xrplAccount,
        address _claimBackAddress
    ) AuthorizedPayPolicy(_teeManager, _extensionId, _walletId, _xrplAccount, _claimBackAddress) {
        owner = msg.sender;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
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

    /// @notice Pay an allowlisted destination. Anyone may call — the allowlist is the gate, not
    ///         msg.sender. Attach quotePayFee() to cover the TEE instruction fee.
    function pay(string calldata recipient, uint256 amount, bytes32 paymentReference)
        external
        payable
        returns (bytes32 instructionId)
    {
        instructionId = _authorizedPay(recipient, amount, paymentReference);
    }

    /// @notice The policy. Two lines. Read them — this is the whole security argument.
    function _checkPolicy(string memory recipient, uint256 amount, bytes32) internal view override {
        if (amount == 0) revert PolicyRejected("zero amount");
        if (!allowedRecipient[keccak256(bytes(recipient))]) {
            revert PolicyRejected("recipient not allowlisted");
        }
    }
}

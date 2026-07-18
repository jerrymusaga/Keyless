// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {KeylessRuleBase} from "./KeylessRuleBase.sol";

/// @title AllowlistRule
/// @notice The simplest rule: a wallet may only pay addresses its owner has allowlisted. Everything
///         else reverts.
///
/// @dev This is the "exchange-only" / "savings" template. Powers the headline protection: paste a
///      poisoned address, hand the key to a compromised app, or steal the key outright — it can still
///      only pay where the owner already said it could. The limit isn't in the key, it's here, and
///      whoever holds the key can't touch it.
contract AllowlistRule is KeylessRuleBase {
    /// @notice walletId => keccak(recipient) => allowed.
    mapping(bytes32 => mapping(bytes32 => bool)) public allowed;

    event RecipientAllowed(bytes32 indexed walletId, string recipient);
    event RecipientRemoved(bytes32 indexed walletId, string recipient);

    constructor(address _accounts) KeylessRuleBase(_accounts) {}

    function allow(bytes32 walletId, string calldata recipient) external onlyWalletOwner(walletId) {
        allowed[walletId][keccak256(bytes(recipient))] = true;
        emit RecipientAllowed(walletId, recipient);
    }

    function remove(bytes32 walletId, string calldata recipient) external onlyWalletOwner(walletId) {
        allowed[walletId][keccak256(bytes(recipient))] = false;
        emit RecipientRemoved(walletId, recipient);
    }

    /// @notice The rule check. Reverts if this payment is not permitted for the wallet.
    function authorize(bytes32 walletId, string calldata recipient, uint256 amount, bytes32)
        external
        view
        override
        onlyAccounts
    {
        if (amount == 0) revert Rejected("zero amount");
        if (!allowed[walletId][keccak256(bytes(recipient))]) revert Rejected("recipient not allowed");
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {KeylessRuleBase} from "./KeylessRuleBase.sol";

/// @title AllowlistRule
/// @custom:status RETIRED — superseded by ExchangeRule, which is this plus optional destination-tag
///         pinning and an optional per-payment cap. New accounts are never given this rule, and the
///         deploy script no longer deploys it. The source is kept because the deployed copy still
///         governs accounts created before the switch, and their funds depend on it. Do not delete.
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

    function allow(bytes32 walletId, string calldata recipient)
        external
        onlyWalletOwner(walletId)
        notLocked(walletId)
    {
        allowed[walletId][keccak256(bytes(recipient))] = true;
        emit RecipientAllowed(walletId, recipient);
    }

    /// @notice Allowlist several recipients in one transaction — set up an exchange/savings account with
    ///         all its deposit addresses at once instead of one tx each.
    function allowMany(bytes32 walletId, string[] calldata recipients)
        external
        onlyWalletOwner(walletId)
        notLocked(walletId)
    {
        for (uint256 i = 0; i < recipients.length; i++) {
            allowed[walletId][keccak256(bytes(recipients[i]))] = true;
            emit RecipientAllowed(walletId, recipients[i]);
        }
    }

    function remove(bytes32 walletId, string calldata recipient)
        external
        onlyWalletOwner(walletId)
        notLocked(walletId)
    {
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

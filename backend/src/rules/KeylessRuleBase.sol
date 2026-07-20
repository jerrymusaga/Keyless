// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {IKeylessRule, IKeylessAccounts} from "../interfaces/IKeylessRule.sol";

/// @title KeylessRuleBase
/// @notice Shared plumbing for spending rules: which account manager they serve, and the two access
///         gates every rule needs — only the manager may `authorize`, and only a wallet's owner may
///         configure that wallet's rule.
abstract contract KeylessRuleBase is IKeylessRule {
    /// @notice The KeylessAccounts manager this rule serves.
    IKeylessAccounts public immutable accounts;

    error NotAccounts();
    error NotWalletOwner();
    error Locked();
    error Rejected(string reason);

    constructor(address _accounts) {
        accounts = IKeylessAccounts(_accounts);
    }

    /// @dev `authorize` must only be callable by the manager, so rules that record state (rate limits)
    ///      can only advance on a real, manager-mediated payment — not by anyone poking the rule.
    modifier onlyAccounts() {
        if (msg.sender != address(accounts)) revert NotAccounts();
        _;
    }

    /// @dev Config setters are gated to the wallet's owner (as recorded by the manager).
    modifier onlyWalletOwner(bytes32 walletId) {
        if (msg.sender != accounts.ownerOf(walletId)) revert NotWalletOwner();
        _;
    }

    /// @dev Config setters must also refuse to change a locked wallet's rule — otherwise a stolen
    ///      control key could just widen the existing rule (e.g. allowlist the attacker) instead of
    ///      repointing it. `authorize` is deliberately NOT gated by this: a locked wallet must keep
    ///      spending under its frozen rule.
    modifier notLocked(bytes32 walletId) {
        if (accounts.isLocked(walletId)) revert Locked();
        _;
    }
}

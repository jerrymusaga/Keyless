// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {KeylessRuleBase} from "./KeylessRuleBase.sol";

/// @title ExchangeRule
/// @notice The "exchange / allowlist+" template. A wallet may only pay recipients its owner has
///         allowlisted — and, per recipient, may be pinned to an exact XRPL **destination tag** (how
///         centralized exchanges credit XRP deposits) and/or a **max amount per payment**. Everything
///         else reverts.
///
/// @dev Why the tag matters: a CEX deposit without the right destination tag is not credited. Pinning
///      `(recipient, tag)` means the payment both lands correctly AND can't be redirected — a stolen
///      control key can't send to the exchange under a *different* tag (someone else's account) or none.
///      Tags are optional per recipient, so plain addresses (a friend, your own wallet) work too.
///
///      The destination tag rides in the top 4 bytes of `paymentReference` (big-endian uint32); the
///      remaining bytes are a free-form memo. The enclave sets the XRPL `DestinationTag` from the same
///      4 bytes, so enforcing them here binds the on-chain policy to the tag actually signed.
contract ExchangeRule is KeylessRuleBase {
    struct Dest {
        bool allowed;
        bool requireTag; // if true, the payment's destination tag must equal `tag`
        uint32 tag; // the required XRPL destination tag
    }

    /// @notice walletId => keccak(recipient) => destination config.
    mapping(bytes32 => mapping(bytes32 => Dest)) public dest;
    /// @notice walletId => max drops per payment (0 = no per-tx limit).
    mapping(bytes32 => uint256) public maxPerTx;

    event RecipientAllowed(bytes32 indexed walletId, string recipient, bool requireTag, uint32 tag);
    event RecipientRemoved(bytes32 indexed walletId, string recipient);
    event MaxPerTxSet(bytes32 indexed walletId, uint256 maxDrops);

    constructor(address _accounts) KeylessRuleBase(_accounts) {}

    /// @notice Allow a recipient with NO destination tag (a plain address — a friend, your own wallet).
    function allow(bytes32 walletId, string calldata recipient)
        external
        onlyWalletOwner(walletId)
        notLocked(walletId)
    {
        dest[walletId][keccak256(bytes(recipient))] = Dest(true, false, 0);
        emit RecipientAllowed(walletId, recipient, false, 0);
    }

    /// @notice Allow a recipient that REQUIRES an exact destination tag (a CEX deposit slot).
    function allowWithTag(bytes32 walletId, string calldata recipient, uint32 tag)
        external
        onlyWalletOwner(walletId)
        notLocked(walletId)
    {
        dest[walletId][keccak256(bytes(recipient))] = Dest(true, true, tag);
        emit RecipientAllowed(walletId, recipient, true, tag);
    }

    function remove(bytes32 walletId, string calldata recipient)
        external
        onlyWalletOwner(walletId)
        notLocked(walletId)
    {
        delete dest[walletId][keccak256(bytes(recipient))];
        emit RecipientRemoved(walletId, recipient);
    }

    /// @notice Set an optional per-payment cap (in drops). 0 clears it (no limit).
    function setMaxPerTx(bytes32 walletId, uint256 maxDrops)
        external
        onlyWalletOwner(walletId)
        notLocked(walletId)
    {
        maxPerTx[walletId] = maxDrops;
        emit MaxPerTxSet(walletId, maxDrops);
    }

    /// @notice The rule check. Reverts if this payment is not permitted for the wallet.
    function authorize(bytes32 walletId, string calldata recipient, uint256 amount, bytes32 paymentReference)
        external
        view
        override
        onlyAccounts
    {
        if (amount == 0) revert Rejected("zero amount");
        Dest memory d = dest[walletId][keccak256(bytes(recipient))];
        if (!d.allowed) revert Rejected("recipient not allowed");
        if (d.requireTag) {
            uint32 tag = uint32(uint256(paymentReference) >> 224); // top 4 bytes
            if (tag != d.tag) revert Rejected("wrong destination tag");
        }
        uint256 cap = maxPerTx[walletId];
        if (cap != 0 && amount > cap) revert Rejected("over per-tx limit");
    }
}

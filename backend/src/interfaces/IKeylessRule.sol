// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @title IKeylessRule
/// @notice A pluggable spending rule for one Keyless account. The account manager
///         (`KeylessAccounts`) calls `authorize` before it lets a wallet spend; a rule that reverts
///         blocks the payment.
///
/// @dev This is the entire security surface of a Keyless wallet. Anyone can write a rule and a wallet
///      owner can point their wallet at it — but a rule governs ONLY its own walletId, so a bad or
///      malicious rule is self-harm, never someone else's funds. Read the rule, know exactly what the
///      wallet can and cannot do.
///
///      `authorize` is deliberately NOT `view`: some rules must record state (e.g. a rate limit
///      tracking how much was spent this period). It is called by the manager, before the manager
///      sends the XRPL instruction, and MUST revert if the payment is not permitted.
interface IKeylessRule {
    /// @param walletId  The account this payment is drawn from.
    /// @param recipient The XRPL destination address.
    /// @param amount    XRPL drops.
    /// @param paymentReference The payment reference (becomes the XRPL memo).
    function authorize(bytes32 walletId, string calldata recipient, uint256 amount, bytes32 paymentReference)
        external;
}

/// @title IKeylessAccounts
/// @notice The slice of the account manager a rule needs: who owns a wallet (so a rule's config setters
///         can be gated to that owner), and whether the wallet is locked (so those setters can refuse to
///         change a frozen rule).
interface IKeylessAccounts {
    function ownerOf(bytes32 walletId) external view returns (address);
    function isLocked(bytes32 walletId) external view returns (bool);
    function xrplAddressOf(bytes32 walletId) external view returns (string memory);
}

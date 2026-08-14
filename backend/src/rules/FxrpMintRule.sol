// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {KeylessRuleBase} from "./KeylessRuleBase.sol";

/// @title FxrpMintRule
/// @custom:status RETIRED — merged into FxrpRule, which does the whole round trip (mint → vault →
///         redeem home → approved cash-out) in one policy. Splitting mint from DeFi meant an account
///         could enter but never leave. New accounts are never given this rule, and the deploy script no
///         longer deploys it; the deployed copy still governs older accounts. Do not delete.
/// @notice The "safe FXRP mint" template. A wallet may make exactly one kind of payment: an XRP transfer
///         to the FAssets Core Vault carrying the direct-minting memo that credits FXRP to a Flare address
///         you chose. Nothing else. So the account becomes an undrainable on-ramp — even a stolen key can
///         only ever convert your XRP into FXRP that lands in *your* Flare wallet, never move it to a thief.
///
/// @dev FAssets direct minting (v1.3): sending XRP to the Core Vault with a 32-byte memo of the form
///      `DIRECT_MINTING(8) | zero(4) | recipient(20)` mints FXRP to `recipient` on Flare once an executor
///      relays the FDC proof (see docs/specs/DirectMinting.md). Keyless `pay(recipient, amount, ref)`
///      already writes `ref` as the XRPL memo, so this rule simply pins `(recipient == CoreVault)` and
///      `(ref == the mint memo for your address)`. The exact reference type is verified from FAssets source:
///      `PaymentReference.DIRECT_MINTING = 0x4642505266410018` (in the top 8 bytes).
contract FxrpMintRule is KeylessRuleBase {
    /// @notice FAssets `PaymentReference.DIRECT_MINTING` type prefix (top 8 bytes of the 32-byte memo).
    uint256 private constant DIRECT_MINTING_PREFIX = 0x4642505266410018;

    /// @notice The XRPL address FXRP mint deposits are paid to (Core Vault). Set at deploy; if FAssets
    ///         moves it, redeploy the rule (like any address change).
    string public coreVaultAddress;
    bytes32 private immutable coreVaultHash;

    /// @notice walletId => the Flare address that receives the minted FXRP.
    mapping(bytes32 => address) public recipientOf;

    event MintRecipientSet(bytes32 indexed walletId, address flareRecipient);

    constructor(address _accounts, string memory _coreVaultAddress) KeylessRuleBase(_accounts) {
        coreVaultAddress = _coreVaultAddress;
        coreVaultHash = keccak256(bytes(_coreVaultAddress));
    }

    /// @notice Set the Flare address that minted FXRP is credited to (e.g. your Keyless control key).
    function configure(bytes32 walletId, address flareRecipient)
        external
        onlyWalletOwner(walletId)
        notLocked(walletId)
    {
        if (flareRecipient == address(0)) revert Rejected("recipient is zero");
        recipientOf[walletId] = flareRecipient;
        emit MintRecipientSet(walletId, flareRecipient);
    }

    /// @notice The exact 32-byte FAssets direct-minting memo that credits FXRP to `flareRecipient`:
    ///         `0x4642505266410018 · 00000000 · <20-byte flareRecipient>`. This is what a Keyless mint
    ///         payment's `paymentReference` must equal. Exposed so the frontend builds the same value.
    function mintMemo(address flareRecipient) public pure returns (bytes32) {
        return bytes32((DIRECT_MINTING_PREFIX << 192) | uint256(uint160(flareRecipient)));
    }

    /// @notice The rule check. Reverts unless this is a valid FXRP mint to the configured Flare address.
    function authorize(bytes32 walletId, string calldata recipient, uint256 amount, bytes32 paymentReference)
        external
        view
        override
        onlyAccounts
    {
        if (amount == 0) revert Rejected("zero amount");
        address flareRecipient = recipientOf[walletId];
        if (flareRecipient == address(0)) revert Rejected("no mint recipient set");
        if (keccak256(bytes(recipient)) != coreVaultHash) revert Rejected("must pay the FXRP core vault");
        if (paymentReference != mintMemo(flareRecipient)) revert Rejected("wrong mint memo");
    }
}

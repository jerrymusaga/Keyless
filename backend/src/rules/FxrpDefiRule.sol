// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {KeylessRuleBase} from "./KeylessRuleBase.sol";

/// @title FxrpDefiRule
/// @custom:status RETIRED — merged into FxrpRule, which does the whole round trip (mint → vault →
///         redeem home → approved cash-out) in one policy. New accounts are never given this rule, and
///         the deploy script no longer deploys it; the deployed copy still governs older accounts.
///         Do not delete.
/// @notice The "FXRP in Flare DeFi, undrainable" template. Once you hold FXRP, this account can put it to
///         work in Flare Smart Accounts — deposit into yield vaults, withdraw, and redeem back to XRP — but
///         it can NEVER transfer FXRP out to another address. Even a stolen key can only stake your FXRP or
///         bring it home to your XRPL account; it can't send it to a thief.
///
/// @dev Flare Smart Accounts (FSA) give every XRPL address a Flare account it alone controls, driven by
///      XRPL Payments whose 32-byte reference encodes an instruction (verified from flare-smart-accounts
///      `PaymentReferenceParser`: byte0 = instruction id, byte1 = wallet id, bytes2-11 = uint80 value,
///      bytes14-15 = uint16 vault id, bytes12-31 = address for a transfer). Keyless `pay(recipient, amount,
///      ref)` writes `ref` as the XRPL memo, so this rule pins `recipient == the FSA provider wallet` and
///      gates byte0: it BLOCKS `0x01` (transfer FXRP out — the only drain path) and allows the "use existing
///      FXRP" set — `0x02` redeem-home, `0x11/12/13` Firelight vault ops, `0x21/22/23` Upshift vault ops.
///      Minting (`0x00/0x10/0x20`) is out of scope here (it pays a dynamic agent, not the FSA wallet) — see
///      FxrpMintRule. A conservative cap on the XRPL trigger amount is defense-in-depth; the action's own
///      value rides in the reference, not the XRPL amount.
contract FxrpDefiRule is KeylessRuleBase {
    /// @notice FSA XRPL provider wallet — every FSA instruction is an XRPL payment here, carrying the
    ///         instruction in its reference. Updatable by the deployer if FSA rotates it.
    string public fsaProviderWallet;
    bytes32 private fsaProviderHash;

    /// @notice Cap on the XRPL trigger payment (drops); 0 = uncapped. The FSA action's value is in the
    ///         reference, so a trigger only needs dust — the cap bounds any misuse of the trigger itself.
    uint256 public immutable maxTriggerAmount;

    address public immutable owner;

    event FsaProviderWalletSet(string wallet);

    constructor(address _accounts, string memory _fsaProviderWallet, uint256 _maxTriggerAmount)
        KeylessRuleBase(_accounts)
    {
        fsaProviderWallet = _fsaProviderWallet;
        fsaProviderHash = keccak256(bytes(_fsaProviderWallet));
        maxTriggerAmount = _maxTriggerAmount;
        owner = msg.sender;
    }

    function setFsaProviderWallet(string calldata _wallet) external {
        require(msg.sender == owner, "only owner");
        fsaProviderWallet = _wallet;
        fsaProviderHash = keccak256(bytes(_wallet));
        emit FsaProviderWalletSet(_wallet);
    }

    // --- reference builders (mirror flare-smart-accounts PaymentReferenceParser) --------------------------

    /// @notice Reference to redeem `lots` of FXRP back to XRP on your XRPL account (instruction `0x02`).
    function redeemHomeRef(uint80 lots) public pure returns (bytes32) {
        return bytes32((uint256(0x02) << 248) | (uint256(lots) << 160));
    }

    /// @notice Reference for a vault op: instruction `id` (e.g. `0x11` Firelight deposit) on `vaultId`,
    ///         with `value` (assets/shares in drops). byte0=id, bytes2-11=value, bytes14-15=vaultId.
    function vaultRef(uint8 id, uint16 vaultId, uint80 value) public pure returns (bytes32) {
        return bytes32((uint256(id) << 248) | (uint256(value) << 160) | (uint256(vaultId) << 128));
    }

    /// @notice The rule check. Reverts unless this is a permitted FSA instruction to the FSA provider wallet.
    function authorize(bytes32, string calldata recipient, uint256 amount, bytes32 paymentReference)
        external
        view
        override
        onlyAccounts
    {
        if (keccak256(bytes(recipient)) != fsaProviderHash) revert Rejected("must pay your FSA account");
        if (maxTriggerAmount != 0 && amount > maxTriggerAmount) revert Rejected("trigger amount too large");

        uint8 id = uint8(uint256(paymentReference) >> 248); // byte 0 = instruction id
        if (id == 0x01) revert Rejected("FXRP transfer-out is not allowed"); // the only drain path
        bool safe =
            id == 0x02 || // redeem FXRP -> XRP (home)
            (id >= 0x11 && id <= 0x13) || // Firelight vault: deposit / redeem / claim
            (id >= 0x21 && id <= 0x23); // Upshift vault: deposit / requestRedeem / claim
        if (!safe) revert Rejected("instruction not permitted");
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {KeylessRuleBase} from "./KeylessRuleBase.sol";

interface IFlareSmartAccounts {
    function getPersonalAccount(string calldata xrplOwner) external view returns (address);
}

/// @title FxrpRule
/// @notice The unified "FXRP, undrainable" template — the whole XRP↔Flare round-trip in one policy. The
///         account can (1) mint FXRP, but ONLY into its own Flare Smart Account, and (2) use that FXRP in
///         Flare DeFi — deposit into yield vaults, withdraw, and redeem back to XRP — but it can NEVER send
///         FXRP to any other address. Even a stolen key can only move value into your own account or bring
///         it home; it can't send it to a thief.
///
/// @dev Three payment shapes are permitted, keyed by the XRPL recipient:
///      - **Core Vault** (FAssets direct minting): the memo must credit THIS account's own FSA personal
///        account, computed on-chain as `getPersonalAccount(xrplAddressOf(walletId))`. It is NOT
///        configurable, so a stolen control key can't repoint the mint to a thief.
///      - **FSA provider wallet** (Flare Smart Accounts): the instruction id (byte 0 of the 32-byte
///        reference) must be in the safe set — redeem-home + vault ops — never `0x01` (transfer FXRP out).
///      - **An approved payee**: XRP brought home can be paid to an address the owner allowlisted. Without
///        this the account was a one-way street — a tester put it exactly right: "I can't ever sell, spend
///        or transfer my FXRP, stXRP or XRP because they can't leave an account with this policy." Value
///        that can enter and never leave is a trap, not a guarantee. Note what is NOT relaxed: FXRP itself
///        still cannot be transferred to anyone (instruction 0x01 stays refused). The way out is to redeem
///        home to XRP first, which is a step the rule can see, and only then pay an approved address.
///
///      Direct-mint completion needs an executor + FDC proof (see enclave/deploy/executor); FSA
///      instructions are completed by Flare's own live executor. Encodings verified from FAssets source
///      (`PaymentReference.DIRECT_MINTING = 0x4642505266410018`) and flare-smart-accounts
///      (`PaymentReferenceParser`). Supersedes FxrpMintRule + FxrpDefiRule.
contract FxrpRule is KeylessRuleBase {
    uint256 private constant DIRECT_MINTING_PREFIX = 0x4642505266410018;

    /// @notice XRPL address FXRP mint deposits are paid to (FAssets Core Vault).
    string public coreVaultAddress;
    bytes32 private immutable coreVaultHash;

    /// @notice FSA XRPL provider wallet — every FSA instruction is a payment here, carrying the reference.
    string public fsaProviderWallet;
    bytes32 private fsaProviderHash;

    /// @notice The Flare Smart Accounts diamond, used to compute each account's own personal account.
    IFlareSmartAccounts public immutable fsa;

    /// @notice Cap on the XRPL trigger payment for a DeFi instruction (drops); 0 = uncapped. Minting is
    ///         uncapped — a larger mint just credits more FXRP to your own account.
    uint256 public immutable maxTriggerAmount;

    address public immutable owner;

    /// @notice walletId => keccak(recipient) => may this account pay it. Non-enumerable, like every other
    ///         rule's recipient storage; the events carry the address for the UI to replay.
    mapping(bytes32 => mapping(bytes32 => bool)) public allowedPayee;

    event FsaProviderWalletSet(string wallet);
    event PayeeAllowed(bytes32 indexed walletId, string recipient);
    event PayeeRemoved(bytes32 indexed walletId, string recipient);

    constructor(
        address _accounts,
        string memory _coreVaultAddress,
        string memory _fsaProviderWallet,
        address _fsa,
        uint256 _maxTriggerAmount
    ) KeylessRuleBase(_accounts) {
        coreVaultAddress = _coreVaultAddress;
        coreVaultHash = keccak256(bytes(_coreVaultAddress));
        fsaProviderWallet = _fsaProviderWallet;
        fsaProviderHash = keccak256(bytes(_fsaProviderWallet));
        fsa = IFlareSmartAccounts(_fsa);
        maxTriggerAmount = _maxTriggerAmount;
        owner = msg.sender;
    }

    function setFsaProviderWallet(string calldata _wallet) external {
        require(msg.sender == owner, "only owner");
        fsaProviderWallet = _wallet;
        fsaProviderHash = keccak256(bytes(_wallet));
        emit FsaProviderWalletSet(_wallet);
    }

    /// @notice This account's own FSA personal account on Flare, derived from its enclave XRPL deposit
    ///         address. This is the ONLY address a mint may credit — so mints can't be repointed.
    function personalAccountOf(bytes32 walletId) public view returns (address) {
        string memory xrpl = accounts.xrplAddressOf(walletId);
        require(bytes(xrpl).length != 0, "xrpl address not provisioned yet");
        return fsa.getPersonalAccount(xrpl);
    }

    /// @notice The exact direct-minting memo that credits FXRP to `flareRecipient`
    ///         (`0x4642505266410018 · 00000000 · <20-byte flareRecipient>`).
    function mintMemo(address flareRecipient) public pure returns (bytes32) {
        return bytes32((DIRECT_MINTING_PREFIX << 192) | uint256(uint160(flareRecipient)));
    }

    // --- FSA reference builders (mirror flare-smart-accounts PaymentReferenceParser) --------------------

    function redeemHomeRef(uint80 lots) public pure returns (bytes32) {
        return bytes32((uint256(0x02) << 248) | (uint256(lots) << 160));
    }

    function vaultRef(uint8 id, uint16 vaultId, uint80 value) public pure returns (bytes32) {
        return bytes32((uint256(id) << 248) | (uint256(value) << 160) | (uint256(vaultId) << 128));
    }

    /// @notice The rule check. Permits exactly two shapes: mint-to-your-own-FSA, or a safe FSA DeFi
    ///         instruction. Everything else — most importantly transferring FXRP out — reverts.
    /// @notice Let this account pay an XRPL address — the cash-out path for XRP redeemed home.
    /// @dev Same posture as every other rule: an unlocked account trusts its control key, and `lock()`
    ///      freezes the list for good. A stolen key can add a payee here exactly as it could on the
    ///      Exchange policy, and locking is the answer in both cases.
    function allowPayee(bytes32 walletId, string calldata recipient)
        external
        onlyWalletOwner(walletId)
        notLocked(walletId)
    {
        if (bytes(recipient).length == 0) revert Rejected("recipient is empty");
        allowedPayee[walletId][keccak256(bytes(recipient))] = true;
        emit PayeeAllowed(walletId, recipient);
    }

    /// @notice Stop this account from paying an address.
    function removePayee(bytes32 walletId, string calldata recipient)
        external
        onlyWalletOwner(walletId)
        notLocked(walletId)
    {
        delete allowedPayee[walletId][keccak256(bytes(recipient))];
        emit PayeeRemoved(walletId, recipient);
    }

    function authorize(bytes32 walletId, string calldata recipient, uint256 amount, bytes32 paymentReference)
        external
        view
        override
        onlyAccounts
    {
        if (amount == 0) revert Rejected("zero amount");
        bytes32 rHash = keccak256(bytes(recipient));

        // MINT: only to this account's own FSA personal account (computed on-chain, not configurable).
        if (rHash == coreVaultHash) {
            if (paymentReference != mintMemo(personalAccountOf(walletId))) revert Rejected("must mint to your FSA account");
            return;
        }

        // DEFI: a Flare Smart Account instruction — gate byte 0, block the transfer-out drain vector.
        if (rHash == fsaProviderHash) {
            if (maxTriggerAmount != 0 && amount > maxTriggerAmount) revert Rejected("trigger amount too large");
            uint8 id = uint8(uint256(paymentReference) >> 248);
            if (id == 0x01) revert Rejected("FXRP transfer-out is not allowed");
            bool safe =
                id == 0x02 || // redeem FXRP -> XRP (home)
                (id >= 0x11 && id <= 0x13) || // Firelight vault: deposit / redeem / claim
                (id >= 0x21 && id <= 0x23); // Upshift vault: deposit / requestRedeem / claim
            if (!safe) revert Rejected("instruction not permitted");
            return;
        }

        // CASH OUT: an address the owner approved. This is what stops the policy being one-way — FXRP
        // redeemed back to XRP can now reach an exchange or a wallet you named, and nothing else.
        if (allowedPayee[walletId][rHash]) return;

        revert Rejected("recipient not allowed");
    }
}

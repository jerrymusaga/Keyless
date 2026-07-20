// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {IFlareTeeManager} from "./interfaces/IFlareTeeManager.sol";
import {IKeylessRule} from "./interfaces/IKeylessRule.sol";

/// @title KeylessAccounts
/// @author Keyless
/// @notice The multi-tenant heart of Keyless: one contract that gives many people a programmable XRP
///         account. It is the FCE extension's single `instructionsSender`, so the TEE machines that
///         hold the keys obey THIS contract and nothing else.
///
/// @dev How it works, end to end:
///        1. `createWallet(salt)` mints a walletId for you and tells the enclave to generate a fresh
///           XRPL key for it (the key is born in the TEE and never leaves — see the enclave).
///        2. `setRule(walletId, rule)` points your wallet at a spending rule (a contract implementing
///           IKeylessRule). The rule is the wallet's entire security surface, and anyone can read it.
///        3. `pay(walletId, ...)` runs your wallet's rule; if it doesn't revert, the enclave signs and
///           submits the XRPL payment.
///
///      The key never touches this contract, the operator, or the caller. A wallet can only ever pay
///      what its rule permits — so you can hand the account to software (an AI agent, a bot, a
///      merchant's pull-payment) that can spend within the rules but can never drain it.
///
///      `pay` is permissionless: the RULE is the gate, not msg.sender. A rule that wants to restrict
///      who can spend enforces that itself.
contract KeylessAccounts {
    /// @notice Flare's TEE manager diamond (Coston2: 0x004224fa1BF1Acd3D233f011FB03b8dd5fA5d41F).
    IFlareTeeManager public immutable teeManager;

    /// @notice Our FCE extension. Its machines obey this contract and nothing else.
    uint256 public immutable extensionId;

    /// @notice Where unspent instruction fees are refunded.
    address public immutable claimBackAddress;

    /// @notice The only address allowed to report a wallet's enclave-generated XRPL address back
    ///         on-chain. This is the enclave's relayer key: after INIT the enclave produces the
    ///         r-address (as the instruction result / GET /state), and the relayer writes it here so a
    ///         UI can read a wallet's deposit address straight from the chain, with no enclave-API
    ///         dependency. The reporter can only *record* an address for an existing wallet — it has no
    ///         power over keys, rules, or funds.
    address public immutable enclaveReporter;

    /// @notice Keyless's operation family. Deliberately NOT a system opType.
    bytes32 public constant OP_TYPE = bytes32("KEYLESS_XRP");
    /// @notice Generate a wallet's XRPL key in-enclave.
    bytes32 public constant OP_INIT = bytes32("INIT");
    /// @notice Sign + submit one XRPL payment. NOT "PAY" — that collides with Flare's reserved op.Pay
    ///         and the tee-proxy would silently drop the instruction (it switches on opCommand alone).
    bytes32 public constant OP_PAY = bytes32("XRPSEND");

    /// @notice Payload for OP_PAY; the enclave decodes this exact struct.
    struct XrplPayment {
        bytes32 walletId;
        string recipient;
        uint256 amount; // XRPL drops
        bytes32 paymentReference; // becomes the XRPL memo
    }

    /// @notice walletId => owner (the address that may configure the wallet).
    mapping(bytes32 => address) public ownerOf;
    /// @notice walletId => its spending rule (IKeylessRule). Zero until set.
    mapping(bytes32 => address) public ruleOf;
    /// @notice walletId => the enclave-generated XRPL r-address (its deposit address). Empty until the
    ///         enclave reporter records it, shortly after createWallet.
    mapping(bytes32 => string) public xrplAddressOf;
    /// @notice walletId => whether its rule is locked. A locked wallet's rule can never be repointed or
    ///         reconfigured — not even by the owner. One-way and permanent by design: if the owner could
    ///         unlock it, so could a stolen control key, which is the exact thing lock defends against.
    mapping(bytes32 => bool) public locked;

    uint256 private _lock;

    event WalletCreated(bytes32 indexed walletId, address indexed owner, bytes32 initInstructionId);
    event RuleSet(bytes32 indexed walletId, address indexed rule);
    event RuleLocked(bytes32 indexed walletId, address indexed rule);
    event XrplAddressReported(bytes32 indexed walletId, string xrplAddress);
    event PaymentAuthorized(
        bytes32 indexed walletId, bytes32 indexed instructionId, string recipient, uint256 amount
    );

    error NotWalletOwner();
    error NotReporter();
    error UnknownWallet();
    error WalletExists();
    error NoRule();
    error NoTeeMachines();
    error InsufficientFee(uint256 required, uint256 provided);
    error Reentrancy();
    error Locked();

    constructor(IFlareTeeManager _teeManager, uint256 _extensionId, address _claimBack, address _reporter) {
        teeManager = _teeManager;
        extensionId = _extensionId;
        claimBackAddress = _claimBack == address(0) ? msg.sender : _claimBack;
        enclaveReporter = _reporter == address(0) ? msg.sender : _reporter;
    }

    modifier nonReentrant() {
        if (_lock == 1) revert Reentrancy();
        _lock = 1;
        _;
        _lock = 0;
    }

    modifier onlyWalletOwner(bytes32 walletId) {
        if (msg.sender != ownerOf[walletId]) revert NotWalletOwner();
        _;
    }

    // --- views ---------------------------------------------------------------

    /// @notice True once Flare has registered THIS contract as the extension's instructions sender.
    function isBound() external view returns (bool) {
        return teeManager.getTeeExtensionInstructionsSender(extensionId) == address(this);
    }

    /// @notice Deterministic, owner-scoped walletId — lets a UI compute the id before creating it.
    function walletIdFor(address owner, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode("KEYLESS_WALLET", owner, salt));
    }

    /// @notice Fee a caller must attach for an op across the current machine set.
    function quoteFee(bytes32 opCommand) external view returns (uint256) {
        return teeManager.calculateFeeByTeeIds(
            OP_TYPE, opCommand, teeManager.getActiveTeeMachines(extensionId)
        );
    }

    // --- account lifecycle ---------------------------------------------------

    /// @notice Create a programmable XRP account. The enclave generates its key; you learn the
    ///         r-address from the INIT result / the enclave's /state. Attach quoteFee(OP_INIT).
    function createWallet(bytes32 salt) external payable nonReentrant returns (bytes32 walletId) {
        walletId = walletIdFor(msg.sender, salt);
        if (ownerOf[walletId] != address(0)) revert WalletExists();
        ownerOf[walletId] = msg.sender;
        bytes32 iid = _send(OP_INIT, abi.encode(walletId));
        emit WalletCreated(walletId, msg.sender, iid);
    }

    /// @notice True if the wallet's rule is locked (frozen forever).
    function isLocked(bytes32 walletId) external view returns (bool) {
        return locked[walletId];
    }

    /// @notice Point a wallet at a spending rule (the wallet's entire security surface).
    function setRule(bytes32 walletId, address rule) external onlyWalletOwner(walletId) {
        if (locked[walletId]) revert Locked();
        ruleOf[walletId] = rule;
        emit RuleSet(walletId, rule);
    }

    /// @notice Permanently freeze this wallet's rule and its configuration. After this, neither the rule
    ///         pointer nor the rule's own settings (allowlist entries, caps, …) can ever change — the
    ///         rule modules check `isLocked` in their config setters too. One-way: there is no unlock.
    ///
    /// @dev This is what makes "can't be drained" hold even against a stolen control key: on a locked
    ///      wallet, an attacker with the owner key cannot repoint the rule or widen it, so the account
    ///      can only ever keep doing exactly what it already does. Best for savings / exchange-only
    ///      wallets you don't need to edit; leave flexible wallets (agents) unlocked.
    function lockRule(bytes32 walletId) external onlyWalletOwner(walletId) {
        if (ruleOf[walletId] == address(0)) revert NoRule(); // locking a ruleless wallet would brick it
        locked[walletId] = true;
        emit RuleLocked(walletId, ruleOf[walletId]);
    }

    /// @notice Record a wallet's enclave-generated XRPL address. Callable ONLY by the enclave reporter,
    ///         and only for a wallet that exists. Idempotent: the first report wins and cannot be
    ///         overwritten, mirroring the enclave's own per-walletId key idempotency (see processInit),
    ///         so a later call can never repoint a funded wallet's deposit address.
    function reportXrplAddress(bytes32 walletId, string calldata xrplAddress) external {
        if (msg.sender != enclaveReporter) revert NotReporter();
        if (ownerOf[walletId] == address(0)) revert UnknownWallet();
        if (bytes(xrplAddressOf[walletId]).length != 0) return; // already recorded; no-op
        xrplAddressOf[walletId] = xrplAddress;
        emit XrplAddressReported(walletId, xrplAddress);
    }

    /// @notice Spend from a wallet. Runs the wallet's rule first; the enclave signs only if it passes.
    ///         Permissionless by design — the rule is the gate. Attach quoteFee(OP_PAY).
    function pay(bytes32 walletId, string calldata recipient, uint256 amount, bytes32 paymentReference)
        external
        payable
        nonReentrant
        returns (bytes32 instructionId)
    {
        address rule = ruleOf[walletId];
        if (rule == address(0)) revert NoRule();

        // The rule may revert (payment not allowed) and may record state (e.g. rate counters). This
        // external call happens BEFORE we send the instruction; nonReentrant guards the callback.
        IKeylessRule(rule).authorize(walletId, recipient, amount, paymentReference);

        instructionId = _send(OP_PAY, abi.encode(XrplPayment(walletId, recipient, amount, paymentReference)));
        emit PaymentAuthorized(walletId, instructionId, recipient, amount);
    }

    // --- the only path to the enclave ---------------------------------------

    function _send(bytes32 opCommand, bytes memory message) internal returns (bytes32) {
        // Exactly one machine: each machine that receives an instruction acts on it independently, so
        // fanning out would duplicate the payment.
        address[] memory machines = teeManager.getRandomTeeIds(extensionId, 1);
        if (machines.length == 0) revert NoTeeMachines();

        uint256 fee = teeManager.calculateFeeByTeeIds(OP_TYPE, opCommand, machines);
        if (msg.value < fee) revert InsufficientFee(fee, msg.value);

        IFlareTeeManager.TeeInstructionParams memory params = IFlareTeeManager.TeeInstructionParams({
            opType: OP_TYPE,
            opCommand: opCommand,
            message: message,
            cosigners: new address[](0),
            cosignersThreshold: 0,
            claimBackAddress: claimBackAddress
        });

        return teeManager.sendInstructions{value: msg.value}(machines, params);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {ITeeExtensionRegistry} from "./interfaces/ITeeExtensionRegistry.sol";
import {ITeeMachineRegistry} from "./interfaces/ITeeMachineRegistry.sol";
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
///
///      TEE wiring (per the fce-sign scaffold): the registry split into an extension registry (send +
///      id discovery) and a machine registry (machine selection). The extension id is NOT a constructor
///      arg — it is assigned by the registry on registration and discovered once via `setExtensionId()`.
contract KeylessAccounts {
    /// @notice Flare's TEE extension registry — the only path from this contract to the enclave.
    ITeeExtensionRegistry public immutable extensionRegistry;
    /// @notice Flare's TEE machine registry — picks the machine that will act on an instruction.
    ITeeMachineRegistry public immutable machineRegistry;

    /// @notice Where unspent instruction fees are refunded.
    address public immutable claimBackAddress;

    /// @notice The only address allowed to report a wallet's enclave-generated XRPL address back
    ///         on-chain. This is the enclave's relayer key: after INIT the enclave produces the
    ///         r-address (as the instruction result / GET /state), and the relayer writes it here so a
    ///         UI can read a wallet's deposit address straight from the chain, with no enclave-API
    ///         dependency. The reporter can only *record* an address for an existing wallet — it has no
    ///         power over keys, rules, or funds.
    address public immutable enclaveReporter;

    /// @notice Public extension ids start here; the registry reserves ids below this for system
    ///         extensions. (Mirrors the scaffold's FIRST_PUBLIC_EXTENSION_ID.)
    uint256 private constant FIRST_PUBLIC_EXTENSION_ID = 0x10000; // 65536

    /// @notice This contract's extension id, discovered once via `setExtensionId()`. Zero until set.
    uint256 private _extensionId;

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

    /// @notice How many accounts have ever been created. A cheap O(1) counter so a UI can show network
    ///         stats without scanning logs (the public RPC caps getLogs at 30 blocks).
    uint256 public walletCount;

    /// @notice How many accounts currently have a rule set (rule != 0). Tracked on the rule transition
    ///         in setRule, so "active" = configured and able to spend.
    uint256 public activeCount;
    /// @notice walletId => whether its rule is locked. A locked wallet's rule can never be repointed or
    ///         reconfigured — not even by the owner. One-way and permanent by design: if the owner could
    ///         unlock it, so could a stolen control key, which is the exact thing lock defends against.
    mapping(bytes32 => bool) public locked;

    uint256 private _lock;

    event ExtensionIdSet(uint256 indexed extensionId);
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
    error Reentrancy();
    error Locked();
    error ExtensionIdAlreadySet();
    error ExtensionIdNotSet();
    error ExtensionIdNotFound();

    constructor(
        ITeeExtensionRegistry _extensionRegistry,
        ITeeMachineRegistry _machineRegistry,
        address _claimBack,
        address _reporter
    ) {
        require(address(_extensionRegistry) != address(0), "extensionRegistry is zero");
        require(address(_machineRegistry) != address(0), "machineRegistry is zero");
        extensionRegistry = _extensionRegistry;
        machineRegistry = _machineRegistry;
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

    // --- extension id discovery ---------------------------------------------

    /// @notice Find and cache this contract's extension id — the one the registry bound to this address
    ///         as its instructions sender. Call once, after the extension is registered. Idempotent
    ///         guard: can only be set a single time.
    function setExtensionId() external {
        if (_extensionId != 0) revert ExtensionIdAlreadySet();
        uint256 c = extensionRegistry.nextPublicExtensionId();
        for (uint256 i = FIRST_PUBLIC_EXTENSION_ID; i < c; ++i) {
            if (extensionRegistry.getTeeExtensionInstructionsSender(i) == address(this)) {
                _extensionId = i;
                emit ExtensionIdSet(i);
                return;
            }
        }
        revert ExtensionIdNotFound();
    }

    /// @notice This contract's extension id (0 until `setExtensionId()` has run).
    function extensionId() external view returns (uint256) {
        return _extensionId;
    }

    function _getExtensionId() internal view returns (uint256) {
        if (_extensionId == 0) revert ExtensionIdNotSet();
        return _extensionId;
    }

    // --- views ---------------------------------------------------------------

    /// @notice True once the registry has bound THIS contract as the extension's instructions sender.
    function isBound() external view returns (bool) {
        if (_extensionId == 0) return false;
        return extensionRegistry.getTeeExtensionInstructionsSender(_extensionId) == address(this);
    }

    /// @notice Deterministic, owner-scoped walletId — lets a UI compute the id before creating it.
    function walletIdFor(address owner, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode("KEYLESS_WALLET", owner, salt));
    }

    /// @notice True if the wallet's rule is locked (frozen forever).
    function isLocked(bytes32 walletId) external view returns (bool) {
        return locked[walletId];
    }

    // --- account lifecycle ---------------------------------------------------

    /// @notice Create a programmable XRP account. The enclave generates its key; you learn the
    ///         r-address from the INIT result / the enclave's /state. Attach the instruction fee as
    ///         value; any excess is refunded to `claimBackAddress`.
    function createWallet(bytes32 salt) external payable nonReentrant returns (bytes32 walletId) {
        walletId = walletIdFor(msg.sender, salt);
        if (ownerOf[walletId] != address(0)) revert WalletExists();
        ownerOf[walletId] = msg.sender;
        unchecked {
            ++walletCount;
        }
        bytes32 iid = _send(OP_INIT, abi.encode(walletId));
        emit WalletCreated(walletId, msg.sender, iid);
    }

    /// @notice Point a wallet at a spending rule (the wallet's entire security surface).
    function setRule(bytes32 walletId, address rule) external onlyWalletOwner(walletId) {
        if (locked[walletId]) revert Locked();
        address prev = ruleOf[walletId];
        // Keep activeCount = number of wallets with a non-zero rule, updated only on the transition.
        if (prev == address(0) && rule != address(0)) {
            unchecked {
                ++activeCount;
            }
        } else if (prev != address(0) && rule == address(0)) {
            unchecked {
                --activeCount;
            }
        }
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
    ///         Permissionless by design — the rule is the gate. Attach the instruction fee as value.
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
        address[] memory machines = machineRegistry.getRandomTeeIds(_getExtensionId(), 1);
        if (machines.length == 0) revert NoTeeMachines();

        ITeeExtensionRegistry.TeeInstructionParams memory params = ITeeExtensionRegistry.TeeInstructionParams({
            opType: OP_TYPE,
            opCommand: opCommand,
            message: message,
            cosigners: new address[](0),
            cosignersThreshold: 0,
            claimBackAddress: claimBackAddress
        });

        // Forward the attached value as the instruction fee; the registry validates it and refunds any
        // excess to claimBackAddress. (The scaffold dropped on-chain fee quoting.)
        return extensionRegistry.sendInstructions{value: msg.value}(machines, params);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @title IFlareTeeManager
/// @notice The surface of Flare's Confidential Compute (FCE) manager that Keyless drives.
/// @dev FlareTeeManager is a DIAMOND at 0x004224fa1BF1Acd3D233f011FB03b8dd5fA5d41F (Coston2).
///      Every function below is reached through that one address, though they live on different
///      facets (ExtensionManager, OwnerAllowlist, WalletProjectManager, WalletManager, Machine-
///      Manager, Instructions). Signatures copied from the verified facet ABIs.
///
///      Why this interface and not ITeePayments: `TeePayments.addPMWMultisigAccount` — the only way
///      to bind a policy contract as a PMW account's authorization address — requires the wallet's
///      project to sit on extension id 0, the SYSTEM extension, owned by Flare governance. A third
///      party can never satisfy it. Running our OWN extension is permissionless, so that is the path.
interface IFlareTeeManager {
    /// @notice One instruction sent to our TEE machines.
    /// @param opType    Operation family. MUST NOT be a system opType (those are reserved for
    ///                  extension 0), so Keyless defines its own.
    /// @param opCommand The specific command within the opType.
    /// @param message   Opaque payload. WE define this format, because we also write the enclave
    ///                  that reads it. Keyless encodes an XrplPayment here.
    /// @param cosigners Addresses that must co-sign the TEE response, if the wallet requires it.
    /// @param cosignersThreshold How many of them are required.
    /// @param claimBackAddress Where unspent instruction fees are returned.
    struct TeeInstructionParams {
        bytes32 opType;
        bytes32 opCommand;
        bytes message;
        address[] cosigners;
        uint64 cosignersThreshold;
        address claimBackAddress;
    }

    // --- Instructions -----------------------------------------------------

    /// @notice Instruct this extension's TEE machines. THE HEART OF KEYLESS.
    /// @dev Access control (InstructionsFacet), for a non-system caller:
    ///        require(msg.sender == ExtensionManager.getExtensionInstructionsSender(extensionId));
    ///      The policy contract is that sender. So the enclave holding the XRPL key takes orders
    ///      from the policy and from nothing else — not from the operator, not from us.
    function sendInstructions(address[] calldata _teeIds, TeeInstructionParams calldata _instructionParams)
        external
        payable
        returns (bytes32 _instructionId);

    /// @notice Fee that must be attached to sendInstructions for this op across these machines.
    function calculateFeeByTeeIds(bytes32 _opType, bytes32 _opCommand, address[] calldata _teeIds)
        external
        view
        returns (uint256);

    // --- ExtensionManager -------------------------------------------------

    /// @notice Register a new TEE extension. PERMISSIONLESS — msg.sender becomes the extension owner.
    /// @dev The extension id is assigned as `extensionsCounter++`. Extension 0 is the system extension.
    /// @param _teeExtensionStateVerifier Contract that verifies attested responses from our TEE machines.
    /// @param _teeExtensionInstructionsSender The ONLY address allowed to send this extension's TEE
    ///        machines instructions. In Keyless this is the policy contract. Must be non-zero.
    function register(address _teeExtensionStateVerifier, address _teeExtensionInstructionsSender)
        external
        returns (uint256 _extensionId);

    /// @notice Rebind the extension's verifier / instructions sender (owner only).
    /// @dev Used to point the extension at the policy contract once it is deployed.
    function setExtensionContracts(
        uint256 _extensionId,
        address _teeExtensionStateVerifier,
        address _teeExtensionInstructionsSender
    ) external;

    /// @notice Declare the key types this extension's wallets may use (e.g. XRP).
    function addSupportedKeyTypes(uint256 _extensionId, bytes32[] calldata _keyTypes) external;

    /// @notice Register a TEE image: its code hash and the platforms it may run on.
    /// @dev THE TRUST ANCHOR. A machine may only join this extension if it attests to a code hash
    ///      registered here. This is what replaces "trust the operator" with "read the code hash".
    function addTeeVersion(
        uint256 _extensionId,
        string calldata _version,
        bytes32 _codeHash,
        bytes32[] calldata _platforms,
        bytes32 _governanceHash
    ) external;

    function getExtensionOwner(uint256 _extensionId) external view returns (address);
    function getSupportedKeyTypes(uint256 _extensionId) external view returns (bytes32[] memory);
    function getSupportedCodeHashes(uint256 _extensionId) external view returns (bytes32[] memory);
    function getTeeExtensionInstructionsSender(uint256 _extensionId) external view returns (address);
    function isCodeHashPlatformSupported(uint256 _extensionId, bytes32 _codeHash, bytes32 _platform)
        external
        view
        returns (bool);
    function getSystemSupportedKeyTypes() external view returns (bytes32[] memory);
    function getSystemSupportedPlatforms() external view returns (bytes32[] memory);
    function getSystemSupportedSigningAlgos(bytes32 _keyType) external view returns (bytes32[] memory);

    // --- OwnerAllowlist ---------------------------------------------------
    // Both are `checkOnlyExtensionOwner` — on OUR extension we allowlist ourselves.

    /// @notice Allow addresses to register TEE machines under this extension.
    function addAllowedTeeMachineOwners(uint256 _extensionId, address[] calldata _owners) external;

    /// @notice Allow addresses to create wallet projects under this extension.
    function addAllowedTeeWalletProjectOwners(uint256 _extensionId, address[] calldata _owners) external;

    function isAllowedTeeMachineOwner(uint256 _extensionId, address _owner) external view returns (bool);
    function isAllowedTeeWalletProjectOwner(uint256 _extensionId, address _owner)
        external
        view
        returns (bool);

    // --- WalletProjectManager / WalletManager -----------------------------

    /// @notice Create a wallet project under an extension. Caller must be an allowed project owner.
    function createProject(uint256 _extensionId, bytes32 _keyType, bytes32 _signingAlgo)
        external
        returns (bytes32 _projectId);

    /// @notice Create a wallet in a project. TEE machines generate the key inside the enclave.
    function createWallet(bytes32 _projectId) external;

    function getProjectWalletIds(bytes32 _projectId) external view returns (bytes32[] memory);
    function getWalletStatus(bytes32 _walletId) external view returns (uint8);
    function getExtensionId(bytes32 _projectId) external view returns (uint256);

    // --- MachineManager ---------------------------------------------------

    /// @notice Active TEE machines belonging to an extension. Empty until a machine reaches PRODUCTION.
    function getActiveTeeMachines(uint256 _extensionId) external view returns (address[] memory);

    /// @notice Pick `_count` random active machines from an extension.
    /// @dev Payments MUST go to exactly one machine. Each machine that receives a PAY instruction
    ///      independently signs AND submits an XRPL transaction — instructing N machines would emit
    ///      N duplicate payments. (Flare's own reference extension uses getRandomTeeIds(id, 1) for
    ///      its SIGN command for the same reason.)
    function getRandomTeeIds(uint256 _extensionId, uint256 _count)
        external
        view
        returns (address[] memory);
}

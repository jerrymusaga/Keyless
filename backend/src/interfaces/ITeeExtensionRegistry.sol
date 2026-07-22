// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @title ITeeExtensionRegistry
/// @notice The runtime slice of Flare's TEE extension registry that a Confidential-Compute extension
///         drives: send instructions to its machines, discover its assigned extension id, and read who
///         the registry has bound as an extension's instructions sender.
/// @dev Minimal by design — mirrors the updated `fce-sign` scaffold. Registration/governance calls
///      (register, addTeeVersion, …) are performed off-chain via generated bindings, not from here.
///      Extension ids are assigned by the registry; public ids start at 0x10000 (see FIRST_PUBLIC_EXTENSION_ID).
interface ITeeExtensionRegistry {
    /// @notice One instruction sent to an extension's TEE machines.
    struct TeeInstructionParams {
        bytes32 opType;
        bytes32 opCommand;
        bytes message;
        address[] cosigners;
        uint64 cosignersThreshold;
        address claimBackAddress;
    }

    /// @notice Instruct this extension's machines. Only callable by the extension's registered
    ///         instructions sender. Attach the instruction fee as value; any excess returns to
    ///         `claimBackAddress`.
    function sendInstructions(address[] calldata _teeIds, TeeInstructionParams calldata _instructionParams)
        external
        payable
        returns (bytes32 _instructionId);

    /// @notice One past the highest assigned extension id — the upper bound for id discovery.
    function nextPublicExtensionId() external view returns (uint256);

    /// @notice The address the registry has bound as `_extensionId`'s sole instructions sender.
    function getTeeExtensionInstructionsSender(uint256 _extensionId) external view returns (address);
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @title ITeeMachineRegistry
/// @notice The runtime slice of Flare's TEE machine registry an extension needs: pick machines to
///         instruct. Mirrors the updated `fce-sign` scaffold.
interface ITeeMachineRegistry {
    /// @notice Pick `_count` random active machines of an extension.
    /// @dev Payments MUST go to exactly one machine — each machine that receives an instruction acts on
    ///      it independently, so fanning out would duplicate the XRPL payment.
    function getRandomTeeIds(uint256 _extensionId, uint256 _count) external view returns (address[] memory);
}

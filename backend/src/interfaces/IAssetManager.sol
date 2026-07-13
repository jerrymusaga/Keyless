// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @title RedemptionRequestInfo
/// @notice Struct returned by IAssetManager.redemptionRequestInfo(). Copied verbatim from
///         flare-labs-ltd/fassets @ contracts/userInterfaces/data/RedemptionRequestInfo.sol
///         so field order / types match the deployed AssetManager ABI exactly.
library RedemptionRequestInfo {
    enum Status {
        ACTIVE,
        DEFAULTED
    }

    struct Data {
        uint64 redemptionRequestId;
        Status status;
        address agentVault;
        address redeemer;
        // The XRPL address the agent must pay.
        string paymentAddress;
        // Reference that MUST be present in the agent's redemption payment (→ XRPL memo).
        bytes32 paymentReference;
        // FAsset amount the redeemer burned. Payment amount is valueUBA - feeUBA.
        uint128 valueUBA;
        uint128 feeUBA;
        uint16 poolFeeShareBIPS;
        uint64 firstUnderlyingBlock;
        // Redemption defaults only after BOTH lastUnderlyingBlock AND lastUnderlyingTimestamp pass.
        uint64 lastUnderlyingBlock;
        uint64 lastUnderlyingTimestamp;
        uint64 timestamp;
        bool poolSelfClose;
        bool transferToCoreVault;
        address executor;
        uint256 executorFeeNatWei;
        uint64 rejectionTimestamp;
        uint64 takeOverTimestamp;
    }
}

/// @title IAssetManager (minimal)
/// @notice Only the surface Keyless needs from the FAssets AssetManager.
/// @dev `redemptionRequestInfo` reverts once a redemption is confirmed (the request is deleted),
///      which Keyless relies on as a FREE replay guard: a policy that requires status == ACTIVE
///      cannot re-pay an already-settled redemption because this call will revert first.
interface IAssetManager {
    /// @notice Data about an ongoing redemption request. Reverts once confirmed.
    function redemptionRequestInfo(uint256 _redemptionRequestId)
        external
        view
        returns (RedemptionRequestInfo.Data memory);
}

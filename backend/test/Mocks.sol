// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {ITeePayments} from "../src/interfaces/ITeePayments.sol";
import {PMWTypes} from "../src/interfaces/PMWTypes.sol";
import {IAssetManager, RedemptionRequestInfo} from "../src/interfaces/IAssetManager.sol";

/// @notice Mock PMW payments contract. Records the last pay() so tests can assert what was authorized.
contract MockTeePayments is ITeePayments {
    uint64 public nextId = 1;
    address public boundAuthorization;

    // last-call capture
    string public lastRecipient;
    uint256 public lastAmount;
    bytes32 public lastReference;
    uint64 public lastPaymentId;

    /// @notice Simulate PMW having registered `who` as the account's authorization address.
    function setAuthorization(address who) external {
        boundAuthorization = who;
    }

    function pay(
        PMWTypes.Account calldata,
        PMWTypes.PaymentInstruction calldata _instruction,
        address
    ) external override returns (uint64 _paymentId) {
        // PMW enforces OnlyAuthorizationAddress; mirror that here.
        require(msg.sender == boundAuthorization, "OnlyAuthorizationAddress");
        lastRecipient = _instruction.recipientAddress;
        lastAmount = _instruction.amount;
        lastReference = _instruction.paymentReference;
        _paymentId = nextId++;
        lastPaymentId = _paymentId;
    }

    function reissue(
        PMWTypes.Account calldata,
        uint64,
        PMWTypes.PaymentInstruction[] calldata,
        PMWTypes.ReissueFeeParams calldata,
        address
    ) external view override returns (bool) {
        require(msg.sender == boundAuthorization, "OnlyAuthorizationAddress");
        return true;
    }

    function getAuthorizationAddress(PMWTypes.Account calldata)
        external
        view
        override
        returns (address)
    {
        return boundAuthorization;
    }

    function getInitialNonce(PMWTypes.Account calldata) external pure override returns (uint64) {
        return 0;
    }

    function getNextPaymentId(PMWTypes.Account calldata) external view override returns (uint64) {
        return nextId;
    }

    function getPaymentFee(PMWTypes.Account calldata, bytes32) external pure override returns (uint256) {
        return 0;
    }

    function getPaymentHash(PMWTypes.Account calldata, uint64 _paymentId)
        external
        pure
        override
        returns (bytes32)
    {
        return keccak256(abi.encode(_paymentId));
    }
}

/// @notice Mock FAssets AssetManager. Lets tests set a redemption and simulate confirm-deletion.
contract MockAssetManager is IAssetManager {
    mapping(uint256 => RedemptionRequestInfo.Data) internal requests;
    mapping(uint256 => bool) internal exists;

    function setRedemption(uint256 id, RedemptionRequestInfo.Data calldata data) external {
        requests[id] = data;
        exists[id] = true;
    }

    /// @notice Simulate confirmation: the real AssetManager deletes the request, so the view reverts.
    function confirmAndDelete(uint256 id) external {
        delete requests[id];
        exists[id] = false;
    }

    function redemptionRequestInfo(uint256 id)
        external
        view
        override
        returns (RedemptionRequestInfo.Data memory)
    {
        require(exists[id], "invalid redemption request"); // mirrors real revert-on-confirm
        return requests[id];
    }
}

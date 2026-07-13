// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {IFlareTeeManager} from "../src/interfaces/IFlareTeeManager.sol";
import {AuthorizedPayPolicy} from "../src/AuthorizedPayPolicy.sol";
import {IAssetManager, RedemptionRequestInfo} from "../src/interfaces/IAssetManager.sol";

/// @notice Mock of Flare's TEE manager diamond. Records the last instruction so tests can assert
///         exactly what the enclave would have been told to sign.
contract MockFlareTeeManager {
    uint256 public constant FEE = 1000;

    address public boundInstructionsSender;
    address[] internal machines;
    uint256 public nextId = 1;

    // last-instruction capture, decoded from the message payload
    string public lastRecipient;
    uint256 public lastAmount;
    bytes32 public lastReference;
    bytes32 public lastWalletId;
    bytes32 public lastOpType;
    uint256 public lastFeePaid;
    uint256 public instructionCount;

    /// @notice Simulate Flare having registered `who` as the extension's instructions sender.
    function setInstructionsSender(address who) external {
        boundInstructionsSender = who;
    }

    /// @notice Simulate TEE machines joining the extension.
    function setMachines(address[] calldata m) external {
        machines = m;
    }

    function sendInstructions(
        address[] calldata _teeIds,
        IFlareTeeManager.TeeInstructionParams calldata _params
    ) external payable returns (bytes32) {
        // Flare's InstructionsFacet enforces this; mirror it so tests feel the real gate.
        require(msg.sender == boundInstructionsSender, "OnlyInstructionsSender");
        require(_teeIds.length > 0, "NoTeeMachinesSpecified");
        require(msg.value >= FEE, "fee");

        AuthorizedPayPolicy.XrplPayment memory p =
            abi.decode(_params.message, (AuthorizedPayPolicy.XrplPayment));

        lastWalletId = p.walletId;
        lastRecipient = p.recipient;
        lastAmount = p.amount;
        lastReference = p.paymentReference;
        lastOpType = _params.opType;
        lastFeePaid = msg.value;
        instructionCount++;

        return bytes32(nextId++);
    }

    function calculateFeeByTeeIds(bytes32, bytes32, address[] calldata) external pure returns (uint256) {
        return FEE;
    }

    function getActiveTeeMachines(uint256) external view returns (address[] memory) {
        return machines;
    }

    function getTeeExtensionInstructionsSender(uint256) external view returns (address) {
        return boundInstructionsSender;
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

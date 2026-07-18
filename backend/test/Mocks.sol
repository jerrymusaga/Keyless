// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {IFlareTeeManager} from "../src/interfaces/IFlareTeeManager.sol";
import {KeylessAccounts} from "../src/KeylessAccounts.sol";

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
    bytes32 public lastOpCommand;
    uint256 public lastFeePaid;
    uint256 public instructionCount;
    /// @dev How many machines the last instruction fanned out to. Must be 1 for payments.
    uint256 public lastTeeIdCount;

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

        lastOpType = _params.opType;
        lastOpCommand = _params.opCommand;
        lastFeePaid = msg.value;
        lastTeeIdCount = _teeIds.length;
        instructionCount++;

        if (_params.opCommand == bytes32("INIT")) {
            // INIT message is abi.encode(bytes32 walletId).
            lastWalletId = abi.decode(_params.message, (bytes32));
            lastRecipient = "";
            lastAmount = 0;
            lastReference = bytes32(0);
        } else {
            // XRPSEND message is abi.encode(XrplPayment).
            KeylessAccounts.XrplPayment memory p =
                abi.decode(_params.message, (KeylessAccounts.XrplPayment));
            lastWalletId = p.walletId;
            lastRecipient = p.recipient;
            lastAmount = p.amount;
            lastReference = p.paymentReference;
        }

        return bytes32(nextId++);
    }

    function calculateFeeByTeeIds(bytes32, bytes32, address[] calldata) external pure returns (uint256) {
        return FEE;
    }

    function getActiveTeeMachines(uint256) external view returns (address[] memory) {
        return machines;
    }

    /// @dev Payments go to exactly one machine; mirror that so tests catch a fan-out regression.
    function getRandomTeeIds(uint256, uint256 _count) external view returns (address[] memory) {
        uint256 n = _count < machines.length ? _count : machines.length;
        address[] memory picked = new address[](n);
        for (uint256 i = 0; i < n; i++) picked[i] = machines[i];
        return picked;
    }

    function getTeeExtensionInstructionsSender(uint256) external view returns (address) {
        return boundInstructionsSender;
    }
}

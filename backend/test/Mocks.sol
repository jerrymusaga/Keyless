// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {ITeeExtensionRegistry} from "../src/interfaces/ITeeExtensionRegistry.sol";
import {ITeeMachineRegistry} from "../src/interfaces/ITeeMachineRegistry.sol";
import {IWeb2Json} from "../src/interfaces/IFdc.sol";
import {KeylessAccounts} from "../src/KeylessAccounts.sol";

/// @notice Mock of Flare's TEE registries (one contract playing both roles, as the diamond does).
///         Supports extension-id discovery (bindExtension → nextPublicExtensionId / instructionsSender)
///         and records the last instruction so tests can assert exactly what the enclave was told to sign.
contract MockTeeRegistry is ITeeExtensionRegistry, ITeeMachineRegistry {
    uint256 public constant FEE = 1000;
    uint256 private constant FIRST_PUBLIC_EXTENSION_ID = 0x10000;

    mapping(uint256 => address) public senderOf; // extensionId => instructions sender
    mapping(address => bool) public isSender;
    uint256 public next = FIRST_PUBLIC_EXTENSION_ID; // one past the highest bound id
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

    /// @notice Simulate the registry assigning `id` to `who` as its sole instructions sender.
    function bindExtension(uint256 id, address who) external {
        senderOf[id] = who;
        isSender[who] = true;
        if (id >= next) next = id + 1;
    }

    /// @notice Simulate TEE machines joining.
    function setMachines(address[] calldata m) external {
        machines = m;
    }

    // --- ITeeExtensionRegistry ------------------------------------------------

    function sendInstructions(address[] calldata _teeIds, TeeInstructionParams calldata _params)
        external
        payable
        returns (bytes32)
    {
        require(isSender[msg.sender], "OnlyInstructionsSender"); // mirror the registry's gate
        require(_teeIds.length > 0, "NoTeeMachinesSpecified");

        lastOpType = _params.opType;
        lastOpCommand = _params.opCommand;
        lastFeePaid = msg.value;
        lastTeeIdCount = _teeIds.length;
        instructionCount++;

        if (_params.opCommand == bytes32("INIT")) {
            lastWalletId = abi.decode(_params.message, (bytes32));
            lastRecipient = "";
            lastAmount = 0;
            lastReference = bytes32(0);
        } else {
            KeylessAccounts.XrplPayment memory p = abi.decode(_params.message, (KeylessAccounts.XrplPayment));
            lastWalletId = p.walletId;
            lastRecipient = p.recipient;
            lastAmount = p.amount;
            lastReference = p.paymentReference;
        }
        return bytes32(nextId++);
    }

    function nextPublicExtensionId() external view returns (uint256) {
        return next;
    }

    function getTeeExtensionInstructionsSender(uint256 _extensionId) external view returns (address) {
        return senderOf[_extensionId];
    }

    // --- ITeeMachineRegistry --------------------------------------------------

    /// @dev Payments go to exactly one machine; mirror that so tests catch a fan-out regression.
    function getRandomTeeIds(uint256, uint256 _count) external view returns (address[] memory) {
        uint256 n = _count < machines.length ? _count : machines.length;
        address[] memory picked = new address[](n);
        for (uint256 i = 0; i < n; i++) picked[i] = machines[i];
        return picked;
    }
}

/// @notice Mock of Flare's FdcVerification. `verifyJsonApi` returns whatever the test sets — standing
///         in for the real Merkle-root check so escrow tests can drive both the proven and unproven
///         paths without a live FDC round.
contract MockFdcVerification {
    bool public result = true;

    function setResult(bool r) external {
        result = r;
    }

    function verifyJsonApi(IWeb2Json.Proof calldata) external view returns (bool) {
        return result;
    }
}

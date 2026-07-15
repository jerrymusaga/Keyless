// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Script, console2} from "forge-std/Script.sol";
import {IFlareTeeManager} from "../src/interfaces/IFlareTeeManager.sol";

/// @notice One-time: tell the enclave to generate its own XRPL key (KEYLESS_XRP / INIT).
/// @dev Sent by the extension's current instructionsSender (the deployer, pre-BindPolicy). INIT
///      carries no input and moves no funds — it just makes the enclave create a key it alone holds
///      and return the r-address. After this, we deploy the policy (with that r-address) and bind it
///      so that from then on only the policy can instruct the enclave.
contract SendInit is Script {
    address constant FLARE_TEE_MANAGER = 0x004224fa1BF1Acd3D233f011FB03b8dd5fA5d41F;
    bytes32 constant OP_TYPE = bytes32("KEYLESS_XRP");
    bytes32 constant OP_INIT = bytes32("INIT");

    function run() external {
        IFlareTeeManager tee = IFlareTeeManager(FLARE_TEE_MANAGER);
        uint256 extensionId = vm.envUint("EXTENSION_ID_DEC"); // 454

        address[] memory machines = tee.getActiveTeeMachines(extensionId);
        require(machines.length > 0, "no active TEE machines");
        console2.log("target machine:", machines[0]);

        uint256 fee = tee.calculateFeeByTeeIds(OP_TYPE, OP_INIT, machines);
        console2.log("instruction fee (wei):", fee);

        IFlareTeeManager.TeeInstructionParams memory params = IFlareTeeManager.TeeInstructionParams({
            opType: OP_TYPE,
            opCommand: OP_INIT,
            message: "",
            cosigners: new address[](0),
            cosignersThreshold: 0,
            claimBackAddress: msg.sender
        });

        vm.startBroadcast();
        bytes32 instructionId = tee.sendInstructions{value: fee}(machines, params);
        vm.stopBroadcast();

        console2.log("INIT sent. instructionId:");
        console2.logBytes32(instructionId);
        console2.log("Now query the enclave /state for its XRPL address.");
    }
}

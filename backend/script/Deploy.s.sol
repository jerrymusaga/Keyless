// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Script, console2} from "forge-std/Script.sol";
import {KeylessDemoPolicy} from "../src/policies/KeylessDemoPolicy.sol";
import {KeylessRedemptionPolicy} from "../src/policies/KeylessRedemptionPolicy.sol";
import {IFlareTeeManager} from "../src/interfaces/IFlareTeeManager.sol";
import {IAssetManager} from "../src/interfaces/IAssetManager.sol";

/// @dev Deploy order for the whole system:
///   1. BootstrapExtension.s.sol   → EXTENSION_ID  (done: 454 on Coston2)
///   2. run a TEE machine on the registered code hash → register it → toProduction()
///   3. CreateWallet.s.sol         → WALLET_ID (the enclave generates the XRPL key)
///   4. Deploy.s.sol (this file)   → the policy
///   5. BootstrapExtension.s.sol:BindPolicy → the policy becomes the extension's instructions
///      sender, and from that moment it is the only thing the enclave will obey.
abstract contract KeylessDeploy is Script {
    address constant FLARE_TEE_MANAGER = 0x004224fa1BF1Acd3D233f011FB03b8dd5fA5d41F;

    function _common()
        internal
        view
        returns (IFlareTeeManager tee, uint256 extensionId, bytes32 walletId, string memory xrplAccount, address claimBack)
    {
        tee = IFlareTeeManager(FLARE_TEE_MANAGER);
        extensionId = vm.envUint("EXTENSION_ID");
        walletId = vm.envBytes32("WALLET_ID");
        xrplAccount = vm.envString("XRPL_ACCOUNT");
        claimBack = vm.envOr("CLAIM_BACK", msg.sender);
    }
}

/// @notice Deploys the demo policy — the one that moves real XRP today, no FAssets status needed.
contract DeployDemo is KeylessDeploy {
    function run() external {
        (
            IFlareTeeManager tee,
            uint256 extensionId,
            bytes32 walletId,
            string memory xrplAccount,
            address claimBack
        ) = _common();

        vm.startBroadcast();
        KeylessDemoPolicy policy =
            new KeylessDemoPolicy(tee, extensionId, walletId, xrplAccount, claimBack);
        vm.stopBroadcast();

        console2.log("KeylessDemoPolicy:", address(policy));
        console2.log("Next: KEYLESS_POLICY=%s then run BindPolicy", vm.toString(address(policy)));
    }
}

/// @notice Deploys the flagship redemption policy.
contract DeployRedemption is KeylessDeploy {
    function run() external {
        (
            IFlareTeeManager tee,
            uint256 extensionId,
            bytes32 walletId,
            string memory xrplAccount,
            address claimBack
        ) = _common();
        address assetManager = vm.envAddress("ASSET_MANAGER_FXRP");

        vm.startBroadcast();
        KeylessRedemptionPolicy policy = new KeylessRedemptionPolicy(
            tee, extensionId, walletId, xrplAccount, claimBack, IAssetManager(assetManager)
        );
        vm.stopBroadcast();

        console2.log("KeylessRedemptionPolicy:", address(policy));
        console2.log("This is the flagship. It becomes a LIVE trustless agent once:");
        console2.log(" 1. it is bound as the extension's instructions sender (BindPolicy)");
        console2.log(" 2. its XRPL account is a whitelisted FAssets agent underlying address");
    }
}

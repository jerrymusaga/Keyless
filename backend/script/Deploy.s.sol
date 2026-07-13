// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Script, console2} from "forge-std/Script.sol";
import {KeylessDemoPolicy} from "../src/policies/KeylessDemoPolicy.sol";
import {KeylessRedemptionPolicy} from "../src/policies/KeylessRedemptionPolicy.sol";
import {ITeePayments} from "../src/interfaces/ITeePayments.sol";
import {IAssetManager} from "../src/interfaces/IAssetManager.sol";

/// @notice Deploys the Keyless demo policy to Coston2.
/// @dev Usage:
///   forge script script/Deploy.s.sol:DeployDemo \
///     --rpc-url $COSTON2_RPC --broadcast --private-key $PK
///
/// Required env / addresses (see docs/addresses.json — VERIFY LIVE before deploying):
///   TEE_PAYMENTS_FXRP  0xD02384dcbA8bBb42E4E8b417b8542410AE0CF484
///   SOURCE_ID          read from TeePaymentsRegistry.getRegisteredSourceIds() (testXRP)
///   XRPL_ACCOUNT       the XRPL account this policy will control (from your PMW wallet)
contract DeployDemo is Script {
    function run() external {
        address teePayments = vm.envAddress("TEE_PAYMENTS_FXRP");
        bytes32 sourceId = vm.envBytes32("SOURCE_ID");
        string memory xrplAccount = vm.envString("XRPL_ACCOUNT");
        address claimBack = vm.envAddress("CLAIM_BACK");
        uint256 maxFee = vm.envOr("MAX_FEE", uint256(1_000_000));

        vm.startBroadcast();
        KeylessDemoPolicy policy = new KeylessDemoPolicy(
            ITeePayments(teePayments), sourceId, xrplAccount, claimBack, "", maxFee
        );
        vm.stopBroadcast();

        console2.log("KeylessDemoPolicy deployed at:", address(policy));
        console2.log("Next: bind this address as the PMW account authorization address");
        console2.log("      (TeePayments.addPMWMultisigAccount) - see docs/OPEN_ITEMS.md #2");
    }
}

/// @notice Deploys the flagship redemption policy to Coston2.
contract DeployRedemption is Script {
    function run() external {
        address teePayments = vm.envAddress("TEE_PAYMENTS_FXRP");
        bytes32 sourceId = vm.envBytes32("SOURCE_ID");
        string memory xrplAccount = vm.envString("XRPL_ACCOUNT");
        address claimBack = vm.envAddress("CLAIM_BACK");
        address assetManager = vm.envAddress("ASSET_MANAGER_FXRP");
        uint256 maxFee = vm.envOr("MAX_FEE", uint256(1_000_000));

        vm.startBroadcast();
        KeylessRedemptionPolicy policy = new KeylessRedemptionPolicy(
            ITeePayments(teePayments),
            sourceId,
            xrplAccount,
            claimBack,
            IAssetManager(assetManager),
            "",
            maxFee
        );
        vm.stopBroadcast();

        console2.log("KeylessRedemptionPolicy deployed at:", address(policy));
        console2.log("This is the flagship. It is inert until:");
        console2.log(" 1. the controlled XRPL account is a whitelisted FAssets agent (OPEN_ITEMS #3)");
        console2.log(" 2. this contract is bound as the PMW authorization address (OPEN_ITEMS #2)");
    }
}

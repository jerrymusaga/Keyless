// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @title PMWTypes
/// @notice Shared structs used by Flare's Protocol Managed Wallet (PMW) TeePayments contract.
/// @dev Field layout mirrors the deployed `TeePayments` ABI on Coston2 exactly. Do not reorder.
library PMWTypes {
    /// @notice Identifies a specific PMW-managed account on an external chain.
    /// @param sourceId       The registered source id (e.g. testXRP). Read the live value from
    ///                       TeePaymentsRegistry.getRegisteredSourceIds().
    /// @param accountAddress The external-chain (XRPL) account address, as a string.
    struct Account {
        bytes32 sourceId;
        string accountAddress;
    }

    /// @notice A single payment the authorization address asks PMW to execute.
    /// @param recipientAddress   Destination on the external chain (XRPL r-address).
    /// @param tokenId            Token identifier on the external chain (empty for native XRP).
    /// @param amount             Amount in the external chain's base units.
    /// @param maxFee             Maximum external-chain fee PMW may spend for this payment.
    /// @param paymentReference   Reference bytes placed in the payment (XRPL memo). For FAssets
    ///                           redemptions this MUST equal the request's paymentReference.
    struct PaymentInstruction {
        string recipientAddress;
        bytes tokenId;
        uint256 amount;
        uint256 maxFee;
        bytes32 paymentReference;
    }

    /// @notice Fee params for reissuing a stalled payment with bumped fees.
    struct ReissueFeeParams {
        uint256[] maxFeePerPayment;
        int16[][] factorsBIPSPerPayment;
        uint16[] delaysSeconds;
    }
}

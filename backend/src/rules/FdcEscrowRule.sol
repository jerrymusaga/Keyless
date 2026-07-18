// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {KeylessRuleBase} from "./KeylessRuleBase.sol";
import {IWeb2Json, IFdcVerification} from "../interfaces/IFdc.sol";

/// @title FdcEscrowRule
/// @notice Pay a fixed recipient, up to a cap — but only after a real-world condition has been proven
///         on-chain by Flare's Data Connector (FDC). Until an FDC-attested Web2 API response matching
///         the escrowed condition is verified, the wallet cannot pay at all.
///
/// @dev The "pay the supplier when delivery is proven" template, and the integration-quality play: one
///      payment composes three Flare surfaces — FCC (the enclave holding the XRPL key), FDC (the
///      attestation of the release condition), and XRPL (native settlement). XRPL escrow releases on a
///      timeout or a hash preimage; it cannot condition on anything happening in the world. Here the
///      release condition is an attestation of a Web2 API (a courier's "delivered", an oracle's
///      settlement flag): funds stay locked until Flare's validators have attested it and anyone
///      submits the proof. The enclave never changes — this is one contract.
contract FdcEscrowRule is KeylessRuleBase {
    /// @notice Flare's FdcVerification. The only thing that can flip an escrow to released.
    IFdcVerification public immutable fdc;

    struct Escrow {
        bytes32 recipient; // keccak(recipient) the escrow may pay
        uint256 maxAmount; // drops, total across releases
        bytes32 conditionHash; // keccak(expected abiEncodedData) that means "condition satisfied"
        uint256 spent; // drops already paid out
        bool released; // condition proven via FDC
        bool active;
    }

    /// @notice walletId => its escrow.
    mapping(bytes32 => Escrow) public escrowOf;

    event EscrowConfigured(bytes32 indexed walletId, string recipient, uint256 maxAmount, bytes32 conditionHash);
    event EscrowReleased(bytes32 indexed walletId, uint64 votingRound);
    event EscrowCancelled(bytes32 indexed walletId);

    error AlreadyReleased();
    error ProofNotVerified();
    error ConditionMismatch();

    constructor(address _accounts, address _fdc) KeylessRuleBase(_accounts) {
        fdc = IFdcVerification(_fdc);
    }

    /// @notice Set up the escrow: who the wallet may pay, the total cap, and the condition — committed
    ///         as the hash of the exact attested data that means "satisfied".
    function configure(bytes32 walletId, string calldata recipient, uint256 maxAmount, bytes32 conditionHash)
        external
        onlyWalletOwner(walletId)
    {
        if (maxAmount == 0) revert Rejected("zero cap");
        if (conditionHash == bytes32(0)) revert Rejected("no condition");
        escrowOf[walletId] = Escrow({
            recipient: keccak256(bytes(recipient)),
            maxAmount: maxAmount,
            conditionHash: conditionHash,
            spent: 0,
            released: false,
            active: true
        });
        emit EscrowConfigured(walletId, recipient, maxAmount, conditionHash);
    }

    /// @notice Prove the condition. Verifies the attestation against Flare's Merkle root for its voting
    ///         round, and that the attested data is exactly the escrowed condition. Anyone may submit —
    ///         the proof is what's trusted, not the sender.
    function release(bytes32 walletId, IWeb2Json.Proof calldata proof) external {
        Escrow storage e = escrowOf[walletId];
        if (!e.active) revert Rejected("no active escrow");
        if (e.released) revert AlreadyReleased();
        if (!fdc.verifyJsonApi(proof)) revert ProofNotVerified();
        if (keccak256(proof.data.responseBody.abiEncodedData) != e.conditionHash) revert ConditionMismatch();
        e.released = true;
        emit EscrowReleased(walletId, proof.data.votingRound);
    }

    /// @notice Cancel the escrow at any time. The wallet can pay nothing further under this rule.
    function cancel(bytes32 walletId) external onlyWalletOwner(walletId) {
        escrowOf[walletId].active = false;
        emit EscrowCancelled(walletId);
    }

    /// @notice The rule check. Reverts unless the condition has been proven and this payment is to the
    ///         escrowed recipient, within the cap.
    function authorize(bytes32 walletId, string calldata recipient, uint256 amount, bytes32)
        external
        override
        onlyAccounts
    {
        if (amount == 0) revert Rejected("zero amount");
        Escrow storage e = escrowOf[walletId];
        if (!e.active) revert Rejected("no active escrow");
        if (!e.released) revert Rejected("condition not proven");
        if (keccak256(bytes(recipient)) != e.recipient) revert Rejected("recipient is not the escrow payee");
        if (e.spent + amount > e.maxAmount) revert Rejected("over escrow cap");
        e.spent += amount;
    }
}

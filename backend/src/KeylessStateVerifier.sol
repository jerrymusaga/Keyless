// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @title KeylessStateVerifier  (SKELETON — finish when FCC guides expose the verifier interface)
/// @notice The on-chain contract that receives and verifies the ATTESTED responses of our TEE machines,
///         and writes the verified result to KeylessAccounts. It is the answer to the #1 confidential-
///         compute question — "what is verified on-chain?" — replacing the trusted `enclaveReporter`
///         relayer with a contract that only accepts a result the TEE actually attested to.
///
/// @dev Registered as the extension's `_teeExtensionStateVerifier` (see IFlareTeeManager.register /
///      setExtensionContracts). Today `KEYLESS_VERIFIER = address(0)` and a trusted relayer writes the
///      r-address; this contract makes that trustless.
///
///      WHAT IS KNOWN (filled in below):
///        - The result we care about: the INIT ActionResult = the enclave-generated XRPL r-address for a
///          walletId (the enclave returns abiEncodeString(address); see enclave processInit).
///        - The write path: this contract is set as KeylessAccounts.enclaveReporter, so after verifying
///          it calls `reportXrplAddress(walletId, addr)` — reusing the existing, idempotent writeback.
///        - Access control shape: only Flare's TEE manager / attestation-delivery path may call the
///          entry point.
///
///      WHAT IS UNKNOWN (the TODOs — fill from the updated FCC guides the moment they land):
///        1. The EXACT entry-point signature the tee-proxy / manager calls on the verifier, and its args
///           (the attestation blob, the machine identity, the instructionId, the result payload).
///        2. HOW to verify the attestation on-chain (the machine's signature over the result vs the
///           registered code hash / governance hash — likely a call back into the manager or a supplied
///           proof).
///        3. How the result correlates to a walletId (via the INIT instructionId → WalletCreated event,
///           or the manager passes the walletId through).
contract KeylessStateVerifier {
    /// @notice KeylessAccounts — this verifier is set as its `enclaveReporter`, so it may write addresses.
    IKeylessWriteback public immutable accounts;
    /// @notice Flare's TEE manager diamond (Coston2: 0x004224fa1BF1Acd3D233f011FB03b8dd5fA5d41F). The
    ///         only address allowed to deliver attested results here. TODO: confirm this is the caller.
    address public immutable teeManager;

    /// @notice extension whose machines this verifier serves.
    uint256 public immutable extensionId;

    event XrplAddressVerified(bytes32 indexed walletId, string xrplAddress);

    error NotTeeManager();
    error AttestationInvalid();
    error UnexpectedResult();

    constructor(address _accounts, address _teeManager, uint256 _extensionId) {
        accounts = IKeylessWriteback(_accounts);
        teeManager = _teeManager;
        extensionId = _extensionId;
    }

    modifier onlyTeeManager() {
        if (msg.sender != teeManager) revert NotTeeManager(); // TODO: confirm the delivery caller
        _;
    }

    // ---------------------------------------------------------------------------------------------
    // ENTRY POINT — the shape Flare's attestation delivery calls. SIGNATURE IS A PLACEHOLDER.
    // TODO(guides): replace with the exact function name + args the tee-proxy/manager invokes.
    // ---------------------------------------------------------------------------------------------

    /// @param walletId       The account the INIT result belongs to. TODO: confirm how it's supplied.
    /// @param resultPayload  The enclave's attested ActionResult (for INIT: abi.encode(string r-address)).
    /// @param attestation    The proof/signature that the TEE actually produced `resultPayload`.
    function receiveAttestedInit(bytes32 walletId, bytes calldata resultPayload, bytes calldata attestation)
        external
        onlyTeeManager
    {
        // 1. VERIFY the attestation on-chain. TODO(guides): the real check — e.g. recover the machine's
        //    signature over keccak(resultPayload) and confirm the machine attests the registered code
        //    hash / governance hash for `extensionId` (likely via a manager view). Until then, we refuse.
        if (!_verify(resultPayload, attestation)) revert AttestationInvalid();

        // 2. DECODE the INIT result — the enclave returns the r-address as an ABI-encoded string.
        string memory xrplAddress = abi.decode(resultPayload, (string));
        if (bytes(xrplAddress).length == 0) revert UnexpectedResult();

        // 3. WRITE via the existing idempotent path (this contract is the enclaveReporter).
        accounts.reportXrplAddress(walletId, xrplAddress);
        emit XrplAddressVerified(walletId, xrplAddress);
    }

    /// @dev Placeholder. Returns false so nothing is trusted until the real verification is implemented.
    /// TODO(guides): implement per the FCC attestation model (machine signature vs registered code hash).
    function _verify(bytes calldata, /*resultPayload*/ bytes calldata /*attestation*/ )
        internal
        pure
        returns (bool)
    {
        return false; // fail-closed until the real check lands
    }
}

/// @dev Minimal slice of KeylessAccounts this verifier needs. This verifier is its `enclaveReporter`.
interface IKeylessWriteback {
    function reportXrplAddress(bytes32 walletId, string calldata xrplAddress) external;
}

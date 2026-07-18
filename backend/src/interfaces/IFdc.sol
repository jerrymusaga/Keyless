// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @title IWeb2Json
/// @notice The Web2Json (a.k.a. JsonApi) attestation type of Flare's Data Connector (FDC): an
///         attested, Merkle-proven response from a Web2 HTTP API. These structs mirror Flare's real
///         `IWeb2Json` on Coston2 exactly, so a proof produced by the FDC verifies against the
///         canonical `FdcVerification` contract with no adaptation.
/// @dev We declare them here rather than pull in flare-periphery so the repo stays a two-lib Foundry
///      project (forge-std only). If Flare revises the type, this file is what moves — nothing else.
interface IWeb2Json {
    struct RequestBody {
        string url;
        string httpMethod;
        string headers;
        string queryParams;
        string body;
        string postProcessJq;
        string abiSignature;
    }

    struct ResponseBody {
        /// @dev The API response, post-processed by the attestation's jq and ABI-encoded per
        ///      `abiSignature`. This is the payload a consumer decodes and trusts.
        bytes abiEncodedData;
    }

    struct Response {
        bytes32 attestationType;
        bytes32 sourceId;
        uint64 votingRound;
        uint64 lowestUsedTimestamp;
        RequestBody requestBody;
        ResponseBody responseBody;
    }

    struct Proof {
        bytes32[] merkleProof;
        Response data;
    }
}

/// @title IFdcVerification
/// @notice The slice of Flare's `FdcVerification` a consumer needs: verify a Web2Json proof against the
///         FDC Merkle root for its voting round.
/// @dev Coston2: `0x906507E0B64bcD494Db73bd0459d1C667e14B933`. Returns true only if the proof's data
///      was attested by Flare's validator set for that round — i.e. the world really said this.
interface IFdcVerification {
    function verifyJsonApi(IWeb2Json.Proof calldata _proof) external view returns (bool _proved);
}

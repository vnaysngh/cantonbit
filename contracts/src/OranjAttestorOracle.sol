// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Ownable } from "openzeppelin/access/Ownable.sol";

import { BaseInputOracle } from "oif-contracts/src/oracles/BaseInputOracle.sol";

/**
 * @title OranjAttestorOracle
 * @notice Trusted-attestor input oracle for the WBTC(Base) → CBTC(Canton) swap.
 *
 * @dev This is the ONLY custom Solidity in the swap. It reuses OIF's audited
 * `BaseInputOracle` for the read side (`isProven` / `efficientRequireProven`
 * are inherited unchanged), and adds a single write path: `attest()`.
 *
 * In the standard OIF flow a cross-chain messaging layer (Wormhole / Hyperlane
 * / Polymer) writes the `_attestations` slot when it receives a verified proof
 * that the output was filled on the remote chain. Canton is not EVM and has no
 * such messaging oracle, so here a TRUSTED OFF-CHAIN AGENT plays that role:
 * after it confirms the CBTC delivery is final on Canton, it calls `attest()`.
 *
 * The escrow's release path is:
 *   InputSettlerEscrow.finalise()
 *     -> InputSettlerBase._validateFills(...)
 *       -> IInputOracle(order.inputOracle).efficientRequireProven(proofSeries)
 * where each proof tuple is (output.chainId, output.oracle, output.settler,
 * payloadHash) and `_isProven` reads
 *   _attestations[chainId][remoteOracle][application][dataHash].
 * So, positionally:  remoteOracle <- output.oracle ,  application <- output.settler.
 * `attest()` writes exactly that slot.
 *
 * ──────────────────────────── SECURITY ────────────────────────────
 * The attestor key is TREASURY-GRADE. Anyone able to call `attest()` can mark
 * an arbitrary fill as proven and thereby cause `finalise()` to release the
 * locked WBTC — with or without a real Canton delivery. There is no on-chain
 * check that the CBTC actually moved; that trust is entirely off-chain. Guard
 * the attestor key like a hot treasury wallet: dedicated signer, server-only,
 * never logged. This is an explicit, accepted property of a single-solver
 * custodial v1 — it is NOT trustless.
 */
contract OranjAttestorOracle is BaseInputOracle, Ownable {
    /// @notice The address allowed to attest fills. Separate from `owner` so the
    /// owner (admin) and the hot attestor key can be different principals.
    address public attestor;

    /// @dev Emitted when the attestor is rotated.
    event AttestorUpdated(address indexed previous, address indexed current);

    error NotAttestor();
    error ZeroAttestor();

    constructor(address initialOwner, address initialAttestor) Ownable(initialOwner) {
        if (initialAttestor == address(0)) revert ZeroAttestor();
        attestor = initialAttestor;
        emit AttestorUpdated(address(0), initialAttestor);
    }

    modifier onlyAttestor() {
        _onlyAttestor();
        _;
    }

    /// @dev Extracted from the modifier to keep bytecode small at each use site.
    function _onlyAttestor() internal view {
        if (msg.sender != attestor) revert NotAttestor();
    }

    /**
     * @notice Rotate the attestor key. Admin-only.
     * @param newAttestor The new attestor address (non-zero).
     */
    function setAttestor(address newAttestor) external onlyOwner {
        if (newAttestor == address(0)) revert ZeroAttestor();
        emit AttestorUpdated(attestor, newAttestor);
        attestor = newAttestor;
    }

    /**
     * @notice Attest that an output described by `dataHash` was filled on
     * `remoteChainId`, so that the escrow's `efficientRequireProven` passes.
     * @dev Mirrors the write performed by WormholeOracle.receiveMessage, but
     * gated by the trusted attestor key instead of a verified VAA.
     *
     * The four arguments MUST match the proof tuple the InputSettler builds:
     *   remoteChainId  == output.chainId
     *   remoteOracle   == output.oracle      (this oracle's identifier, by convention)
     *   application    == output.settler     (the destination "settler" identifier)
     *   dataHash       == keccak256(MandateOutputEncodingLib.encodeFillDescription(...))
     * A mismatch in any field means `finalise()` reverts `NotProven`.
     *
     * Idempotent: re-attesting an already-proven slot is a harmless no-op write.
     *
     * @param remoteChainId Chain id of the fill (the id assigned to Canton).
     * @param remoteOracle  Oracle identifier for the output (== output.oracle).
     * @param application   Application/settler identifier (== output.settler).
     * @param dataHash      keccak256 of the fill description payload.
     */
    function attest(
        uint256 remoteChainId,
        bytes32 remoteOracle,
        bytes32 application,
        bytes32 dataHash
    ) external onlyAttestor {
        _attestations[remoteChainId][remoteOracle][application][dataHash] = true;
        emit OutputProven(remoteChainId, remoteOracle, application, dataHash);
    }

    /**
     * @notice Batch version of `attest` for multi-output orders or backfills.
     * @dev All arrays must be the same length.
     */
    function attestBatch(
        uint256[] calldata remoteChainIds,
        bytes32[] calldata remoteOracles,
        bytes32[] calldata applications,
        bytes32[] calldata dataHashes
    ) external onlyAttestor {
        uint256 n = remoteChainIds.length;
        require(
            remoteOracles.length == n && applications.length == n && dataHashes.length == n,
            "length mismatch"
        );
        for (uint256 i; i < n; ++i) {
            _attestations[remoteChainIds[i]][remoteOracles[i]][applications[i]][dataHashes[i]] = true;
            emit OutputProven(remoteChainIds[i], remoteOracles[i], applications[i], dataHashes[i]);
        }
    }
}

/**
 * Order construction — turns a swap request into the on-chain StandardOrder +
 * MandateOutput, and derives the proof identifiers so that what the user signs
 * and what the agent later attests are guaranteed to be the same tuple.
 *
 * Consistency invariants enforced here:
 *   - order.inputOracle === output.oracle === our oracle  (escrow staticcalls
 *     inputOracle; proof tuple is keyed by output.oracle — they must match).
 *   - output.chainId / output.settler come from config and are reused verbatim
 *     at attest time.
 *   - the fill timestamp used in the payloadHash is the SAME value passed to
 *     attest() (caller supplies the Canton ledger record-time; see Task 7).
 */

import { keccak256, pad, stringToHex, type Address, type Hex } from "viem";

import type { SwapNetworkConfig } from "./config.js";
import { oracleId } from "./config.js";
import {
  fillDescriptionHash,
  orderId as computeOrderId,
  type MandateOutput,
  type StandardOrder
} from "./encoding.js";

/** A request to swap WBTC (on the origin chain) for CBTC (on Canton). */
export interface SwapRequest {
  /** The user's EVM address (locks WBTC, signs the order). */
  user: Address;
  /** Amount of WBTC to lock, in token base units (8dp). */
  wbtcAmount: bigint;
  /** Amount of CBTC to deliver, in its base units. */
  cbtcAmount: bigint;
  /**
   * The user's FULL Canton destination party id (e.g. "cbtc-user-...::1220...").
   * A party id is ~100 chars and does NOT fit in bytes32, so the order commits
   * to keccak256(party) in MandateOutput.recipient. The solver is given this
   * preimage off-chain and MUST deliver to the party whose hash matches — any
   * other party produces a payloadHash that won't satisfy the signed order.
   */
  cantonParty: string;
  /** CBTC instrument identifier as bytes32 (opaque on the EVM side). */
  cbtcToken: Hex; // bytes32
  /** Unique per-user nonce for this order. */
  nonce: bigint;
}

/** Bind a full Canton party id into a bytes32 recipient commitment. */
export function cantonPartyToRecipient(cantonParty: string): Hex {
  return keccak256(stringToHex(cantonParty));
}

/**
 * SECURITY-CRITICAL: verify that an off-chain-supplied Canton party is the
 * genuine preimage of the on-chain recipient commitment. The Open event only
 * carries keccak256(party); the solver gets the full party from a side channel
 * (the user's swap request) and MUST check it here before delivering — else it
 * could be tricked into sending CBTC to an attacker's party. Returns true only
 * if keccak256(party) exactly equals the order's committed recipient hash.
 */
export function verifyCantonParty(
  cantonParty: string,
  committedRecipient: Hex
): boolean {
  return (
    cantonPartyToRecipient(cantonParty).toLowerCase() ===
    committedRecipient.toLowerCase()
  );
}

/** Everything needed to act on an order, kept together so build & attest agree. */
export interface BuiltOrder {
  order: StandardOrder;
  /** The single output (we only ever build one). */
  output: MandateOutput;
  /** orderId as the escrow will compute it (keyed by the escrow address). */
  orderId: Hex;
  /** The full Canton party the solver must deliver to (preimage of recipient). */
  cantonParty: string;
  /** keccak256(cantonParty) — equals output.recipient; the on-chain commitment. */
  cantonRecipientHash: Hex;
  /** Identifiers reused at attest time — the proof tuple minus the dataHash. */
  attestTuple: {
    remoteChainId: bigint; // == output.chainId
    remoteOracle: Hex; // == output.oracle (our oracle id)
    application: Hex; // == output.settler
  };
}

/**
 * Build the StandardOrder + MandateOutput for a swap request.
 *
 * @param nowSeconds Current unix time (seconds) — caller supplies it so this is
 *   pure/testable. fillDeadline = now + cfg.fillDeadlineSeconds, etc.
 */
export function buildOrder(
  cfg: SwapNetworkConfig,
  req: SwapRequest,
  nowSeconds: number
): BuiltOrder {
  const ourOracleId = oracleId(cfg);

  const output: MandateOutput = {
    oracle: ourOracleId, // MUST equal order.inputOracle (as id)
    settler: cfg.cantonSettlerId,
    chainId: cfg.cantonChainId,
    token: req.cbtcToken,
    amount: req.cbtcAmount,
    recipient: cantonPartyToRecipient(req.cantonParty), // keccak256(party)
    callbackData: "0x",
    context: "0x"
  };

  const fillDeadline = nowSeconds + cfg.fillDeadlineSeconds;
  const expires = nowSeconds + cfg.expiresSeconds;
  if (!(fillDeadline < expires)) {
    throw new Error(
      "config invariant violated: fillDeadline must be < expires"
    );
  }

  const order: StandardOrder = {
    user: req.user,
    nonce: req.nonce,
    originChainId: BigInt(cfg.originChainId),
    expires,
    fillDeadline,
    inputOracle: cfg.oracle, // escrow staticcalls THIS oracle
    inputs: [[addressToUint(cfg.wbtc), req.wbtcAmount]],
    outputs: [output]
  };

  const orderId = computeOrderId(order, cfg.escrow);

  return {
    order,
    output,
    orderId,
    cantonParty: req.cantonParty,
    cantonRecipientHash: output.recipient,
    attestTuple: {
      remoteChainId: cfg.cantonChainId,
      remoteOracle: ourOracleId,
      application: cfg.cantonSettlerId
    }
  };
}

/**
 * Compute the dataHash (payloadHash) for a built order given the solver and the
 * authoritative fill timestamp. This is exactly what gets attested AND what the
 * escrow's _validateFills recomputes — keep `fillTimestamp` identical in both.
 *
 * @param solver The solver's identifier (its EVM address as bytes32).
 * @param fillTimestamp The Canton ledger record-time of the CBTC delivery,
 *   truncated to a uint32 (seconds). MUST be <= order.fillDeadline.
 */
export function proofDataHash(
  built: BuiltOrder,
  solver: Hex, // bytes32 solver id
  fillTimestamp: number
): Hex {
  if (fillTimestamp > built.order.fillDeadline) {
    throw new Error(
      `fill timestamp ${fillTimestamp} is after fillDeadline ${built.order.fillDeadline}`
    );
  }
  return fillDescriptionHash(
    solver,
    built.orderId,
    fillTimestamp,
    built.output
  );
}

/** Address (20 bytes) → uint256 for the inputs[] encoding. */
function addressToUint(addr: Address): bigint {
  return BigInt(addr);
}

/** Left-pad an EVM address to a bytes32 identifier (solver/recipient ids). */
export function toIdentifier(addr: Address): Hex {
  return pad(addr, { size: 32 });
}

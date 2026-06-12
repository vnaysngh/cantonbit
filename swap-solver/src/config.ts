/**
 * Swap configuration — the per-network constants and identifiers that make a
 * swap well-formed and internally consistent.
 *
 * The single most important invariant this module enforces:
 *   order.inputOracle  ==  output.oracle  ==  our OranjAttestorOracle
 * The escrow staticcalls `order.inputOracle`, while the proof tuple is keyed by
 * `output.oracle`. If they diverge, the escrow asks one oracle but the
 * attestation lives in another, and `finalise()` reverts `NotProven` forever.
 *
 * All identifiers here are CONSTANTS chosen by us (Canton is not EVM, so there
 * is no real on-chain settler to point at). They only need to be (a) stable and
 * (b) identical between order-construction and attestation.
 */

import { getAddress, pad, type Address, type Hex } from "viem";

export type NetworkName = "devnet" | "testnet" | "mainnet";

/** Per-network swap configuration. */
export interface SwapNetworkConfig {
  readonly network: NetworkName;

  /** EVM origin chain where WBTC is locked (Base / Base Sepolia / local). */
  readonly originChainId: number;
  /** Deployed InputSettlerEscrow address on the origin chain. */
  readonly escrow: Address;
  /** Deployed OranjAttestorOracle address on the origin chain. */
  readonly oracle: Address;
  /** WBTC token address on the origin chain. */
  readonly wbtc: Address;

  /**
   * Synthetic chainId assigned to Canton for the MandateOutput. It must not
   * collide with any real EVM chainId. We use a high fixed base + per-network
   * offset. This value is mixed into the payloadHash + the attest tuple.
   */
  readonly cantonChainId: bigint;

  /**
   * `output.settler` identifier — the "application" slot in the proof tuple.
   * A fixed sentinel representing the Canton CBTC settlement. Chosen by us.
   */
  readonly cantonSettlerId: Hex; // bytes32

  /** Default order time windows (seconds). fillDeadline < expires. */
  readonly fillDeadlineSeconds: number;
  readonly expiresSeconds: number;
}

/**
 * Canton chainId base. EVM chainIds in use are all well below this; 1e15 leaves
 * no realistic collision. Per-network offset keeps devnet/testnet/mainnet
 * distinct so a proof minted for one network can never satisfy another.
 */
const CANTON_CHAIN_BASE = 1_000_000_000_000_000n; // 1e15
const CANTON_CHAIN_OFFSET: Record<NetworkName, bigint> = {
  devnet: 1n,
  testnet: 2n,
  mainnet: 3n
};

/** A fixed, human-recognizable sentinel for the Canton CBTC settler id. */
const CANTON_SETTLER_SENTINEL: Hex = pad("0xcB7c5e771e", { size: 32 });

/**
 * Build a network config. Addresses come from deployment (env/CLI); the rest
 * are derived deterministically so order-build and attest always agree.
 */
export function makeNetworkConfig(params: {
  network: NetworkName;
  originChainId: number;
  escrow: Address;
  oracle: Address;
  wbtc: Address;
  fillDeadlineSeconds?: number;
  expiresSeconds?: number;
}): SwapNetworkConfig {
  // Normalize all EVM addresses to checksummed form. viem's encodePacked
  // enforces a consistent checksum, so passing a mixed-case address downstream
  // would throw — we validate + canonicalize once here, at the boundary.
  return {
    network: params.network,
    originChainId: params.originChainId,
    escrow: getAddress(params.escrow),
    oracle: getAddress(params.oracle),
    wbtc: getAddress(params.wbtc),
    cantonChainId: CANTON_CHAIN_BASE + CANTON_CHAIN_OFFSET[params.network],
    cantonSettlerId: CANTON_SETTLER_SENTINEL,
    // Order time windows. CRITICAL INVARIANT: fillDeadline must give the solver
    // COMFORTABLY MORE time than its own delivery margin
    // (DELIVERY_MARGIN_SECONDS in index.ts), or every order is born already too
    // close to its deadline to ever be delivered (the bug that stalled live
    // swaps: 10m fill window vs 30m delivery margin → unfillable). Budget:
    //   deliver CBTC (secs) + accept (secs–mins) + attest + finalise (~1–2m).
    // So: 30m to fill (margin is 10m → 20m of real slack), 45m to expiry (when
    // the user's refund unlocks + the watch loop auto-refunds). fillDeadline MUST
    // be < expires. Overridable via env/CLI. Keep fill > 3× the delivery margin.
    fillDeadlineSeconds: params.fillDeadlineSeconds ?? 30 * 60,
    expiresSeconds: params.expiresSeconds ?? 45 * 60
  };
}

/** The bytes32 identifier of our oracle (== output.oracle == order.inputOracle). */
export function oracleId(cfg: SwapNetworkConfig): Hex {
  return pad(cfg.oracle, { size: 32 });
}

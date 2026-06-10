/**
 * HTLC watchtower (T11) — completes a swap from the PUBLIC preimage reveal even
 * if the main solver process is down.
 *
 * Once the preimage is revealed anywhere (a Claimed event on either chain, or the
 * Canton claim), it is public forever. Anyone — the solver, a backup process, or
 * a third party running this open-source watchtower — can use it to claim the
 * still-open leg. This is what makes "the solver crashes after the reveal" a
 * self-healing case instead of a stuck swap.
 *
 * The watchtower is STATELESS per check: given a swap's hashLock + the EVM
 * HTLCEscrow, it (1) finds a revealed preimage, (2) if the solver's WBTC lock is
 * still open, claims it. Run it on a loop (index.ts) or as a standalone process.
 *
 * It holds NO secrets and needs NO trust: it can only ever submit a preimage that
 * already hashes to the committed hashLock. It cannot steal — it can only finish.
 */

import { createPublicClient, http, type Address, type Hex } from "viem";

import { HtlcSettler, readRevealedPreimage } from "./htlc-settle.js";

export interface WatchedSwap {
  /** The committed hashlock (bytes32). */
  hashLock: Hex;
  /** Block to start scanning Claimed events from (the lock block, or earlier). */
  fromBlock: bigint;
}

export type WatchOutcome =
  | { kind: "completed"; txHash: Hex }
  | { kind: "noRevealYet" }
  | { kind: "alreadyDone" }
  | { kind: "error"; reason: string };

/**
 * Try to complete one watched swap: find the revealed preimage on-chain, and if
 * the solver's WBTC lock is still open, claim it.
 *
 * `settler` must be configured with the SOLVER account (the receiver of the WBTC
 * lock) so claim() pays the solver.
 */
export async function completeFromReveal(
  pub: ReturnType<typeof createPublicClient>,
  settler: HtlcSettler,
  htlcEscrow: Address,
  swap: WatchedSwap,
): Promise<WatchOutcome> {
  let preImage: Hex | null;
  try {
    preImage = await readRevealedPreimage(pub, htlcEscrow, swap.hashLock, swap.fromBlock);
  } catch (e) {
    return { kind: "error", reason: `reveal read failed: ${e instanceof Error ? e.message : e}` };
  }
  if (!preImage) return { kind: "noRevealYet" };

  const out = await settler.claimWithPreimage(preImage, swap.hashLock);
  switch (out.kind) {
    case "claimed":
      return { kind: "completed", txHash: out.txHash };
    case "alreadyClaimed":
      return { kind: "alreadyDone" };
    default:
      return { kind: "error", reason: `claim from reveal failed: ${out.kind} ${"reason" in out ? out.reason : ""}` };
  }
}

/** Convenience: build a public client + settler-less reveal reader for a chain. */
export function makePublicClient(rpcUrl: string) {
  return createPublicClient({ transport: http(rpcUrl) });
}

/**
 * HTLC Canton leg (T8) — the SOLVER's Canton-side responsibilities for an
 * EVM→Canton swap (user pays WBTC on EVM, receives cBTC on Canton).
 *
 * cBTC has NO on-ledger hashlock (T1, proven). So this leg is the Cancore-
 * equivalent TRUST-MINIMIZED design: the solver locks/holds cBTC and only
 * DELIVERS it once the EVM leg is safely locked under the agreed hashLock. The
 * binding to the secret happens on the EVM leg (a real HTLC); on Canton the
 * solver's delivery is gated by the orchestrator + the staggered timelocks.
 *
 * Honest trust statement:
 *   - EVM leg: fully trustless (HTLCEscrow, secret reveal releases WBTC).
 *   - Canton cBTC leg: trust-minimized — the solver delivers cBTC; the user is
 *     protected by the EVM HTLC (their WBTC only releases on the secret) and by
 *     the Canton-side timeout-refund (Allocation withdraw). The cBTC hash is
 *     enforced by THIS orchestrator, not the cBTC ledger (which can't).
 *
 * Flow position (Cancore's 8 steps):
 *   step 4  Counter HTLC   — lockCbtc(): solver locks cBTC under the swap (refundable)
 *   step 5  Accept Counter — user's Loop Preapproval auto-accepts the delivery
 *   step 6  Claim Counter  — user receives cBTC; reveals the secret (drives EVM claim)
 *   step R  Refund         — refundCbtc(): solver reclaims after solverTimelock
 *
 * This module orchestrates lock → deliver → refund using the existing
 * CantonClient (allocate / createOffer / withdrawAllocation). It does NOT touch
 * the secret on Canton (the cBTC leg can't enforce it); the secret lives on the
 * EVM leg + the user's reveal (T9).
 */

import { keccak256 } from "viem";

import { CantonClient, type HoldingLite } from "./canton.js";

export interface CantonLegParams {
  /** The user's full Canton party (cBTC receiver). */
  receiverParty: string;
  /** cBTC amount to deliver, as a BTC decimal string (the registry speaks BTC). */
  amountBtc: string;
  /** Swap id — used as the settlement id + the dedup command id, so a repeat
   *  lock/deliver of the SAME swap is rejected at the ledger level. */
  swapId: string;
  /** Canton-side timelock (unix seconds): after this, the solver may refund and
   *  the swap is dead on the Canton side. = the shorter leg (solverTimelock). */
  solverTimelock: number;
}

export type CantonLegResult =
  | { kind: "released"; updateId: string; offerContractId: string; autoAccepted: boolean }
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; reason: string };

/**
 * STEP 6 — release the cBTC to the user, ONLY ON the revealed preimage.
 *
 * This is the orchestrator-enforced hash gate (cBTC has no on-ledger hashlock —
 * T1). It is EXACTLY Cancore's design: the cBTC is held by the solver/platform;
 * the user "claims" it by revealing the preimage; the orchestrator verifies
 * keccak256(preimage)==hashLock and only THEN delivers the cBTC (via the standard
 * TransferInstruction, auto-accepted by the user's Loop Preapproval).
 *
 * Caller (the orchestrator, T9/T10) MUST:
 *   1. have already confirmed the user's WBTC is locked on EVM under hashLock
 *      (step 3) — never release cBTC before the EVM leg is locked.
 *   2. verify the preimage against the committed hashLock BEFORE calling this
 *      (use verifySecret from htlc-order). This function assumes that check ran.
 * Once the preimage is revealed (on EVM, or supplied by the user), the solver
 * also claims the WBTC on EVM with it (step 7) — so the swap nets out.
 *
 * Non-steal-able ordering (why nobody is robbed):
 *   - User can't get cBTC without revealing (we only release on a valid preimage).
 *   - The moment the preimage is revealed, the solver claims the WBTC (step 7).
 *   - If the user never reveals: cBTC is never released (solver keeps it) AND the
 *     user's WBTC refunds after the EVM timelock. Both whole.
 *
 * Deterministic command id keyed by the swap → the ledger rejects a duplicate
 * release of the same swap.
 */
export async function releaseCbtcOnReveal(
  canton: CantonClient,
  p: CantonLegParams,
  reveal: { preimageHex: string; hashLock: string },
): Promise<CantonLegResult> {
  // HARD GATE: never release without a preimage that matches the committed hash.
  // (Belt-and-suspenders — the orchestrator should also check, but enforce here
  // so a buggy caller can't deliver cBTC unconditionally.)
  if (!preimageMatches(reveal.preimageHex, reveal.hashLock)) {
    return { kind: "failed", reason: "preimage does not match hashLock — refusing to release cBTC" };
  }
  let holdings: HoldingLite[];
  try {
    holdings = await canton.getHoldings(canton.solverParty);
  } catch (e) {
    return { kind: "skipped", reason: `holdings read failed (transient): ${errMsg(e)}` };
  }
  try {
    const { updateId, offerContractId, autoAccepted } = await canton.createOffer({
      receiverParty: p.receiverParty,
      amountBtc: p.amountBtc,
      inputHoldings: holdings,
      commandId: `htlc-release-${p.swapId}`,
    });
    return { kind: "released", updateId, offerContractId, autoAccepted };
  } catch (e) {
    return { kind: "failed", reason: `release (createOffer) failed: ${errMsg(e)}` };
  }
}

/**
 * STEP R (Canton side) — the solver's "refund" is simply NOT releasing: if the
 * user never reveals the preimage before the timelock, the solver keeps its cBTC
 * float (nothing was locked away from it — releaseCbtcOnReveal only ever runs on
 * a valid reveal). The user is made whole by refunding their WBTC on the EVM leg
 * after the EVM timelock (T11). So there is no Canton refund tx to send here —
 * this is a no-op by design, documented so the orchestrator doesn't look for one.
 *
 * (If a future variant locks the cBTC via Allocation up front, the refund would
 * be Allocation_Withdraw — sender-only — but the current Cancore-equivalent model
 * holds the cBTC in the solver's float and gates release on the reveal, so the
 * solver's downside is just an unconsummated swap, not a stranded lock.)
 */

/** keccak256 of the hex-string preimage (Daml-compatible) == hashLock?
 *  Mirrors verifySecret but takes the canton preimage form (hex string, no 0x)
 *  and compares to the committed bytes32 hashLock. */
function preimageMatches(preimageHex: string, hashLock: string): boolean {
  // The canton preimage is the lowercase hex of the raw secret bytes. EVM/Daml
  // both yield H = keccak256(rawBytes). Recompute from the hex here.
  const clean = preimageHex.startsWith("0x") ? preimageHex.slice(2) : preimageHex;
  if (clean.length % 2 !== 0) return false;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  const h = keccak256(bytes).toLowerCase();
  const want = (hashLock.startsWith("0x") ? hashLock : "0x" + hashLock).toLowerCase();
  return h === want;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

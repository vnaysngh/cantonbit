/**
 * App-native HTLC swap service (B-FE4) for the Next.js API routes.
 *
 * Uses the app's OWN lib/ Canton functions (createTransfer, getHoldings) — no
 * cross-package import into swap-solver (which has its own dependency tree). The
 * order-lifecycle logic mirrors swap-solver/src/htlc-swap-service.ts but releases
 * cBTC via the app's createTransfer.
 *
 * Cancore-aligned reveal-gated flow (NOT a plain transfer): the cBTC is released
 * ONLY when the user submits the correct preimage at claim-counter; the backend
 * verifies keccak256(preimage)==hashLock (orchestrator gate, since cBTC has no
 * on-ledger hashlock — T1), then delivers and stores the preimage for the EVM claim.
 */
import { keccak_256 } from "@noble/hashes/sha3";

import { getHoldings } from "./canton";
import { NETWORK } from "./constants";
import { allocate, createHtlcLock, prepareClaimCommand, claimAsReceiver, refundHtlcLock } from "./htlc-onledger";
import { SupabaseSwapStore, type SwapStore } from "./htlc-order-store";
import type { SwapOrder, SwapStatus, SwapDirection } from "./htlc-types";

export type { SwapOrder, SwapStatus, SwapDirection };

function toHexLower(bytes: Uint8Array): string {
  return "0x" + Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function preimageMatches(preimageHex: string, hashLock: string): boolean {
  const clean = preimageHex.startsWith("0x") ? preimageHex.slice(2) : preimageHex;
  if (clean.length % 2 !== 0) return false;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  const got = toHexLower(keccak_256(bytes)); // keccak256 of the RAW bytes (EVM-compatible)
  const want = (hashLock.startsWith("0x") ? hashLock : "0x" + hashLock).toLowerCase();
  return got === want;
}

class HtlcService {
  constructor(private store: SwapStore) {}

  async createOrder(o: Omit<SwapOrder, "status" | "createdAt">): Promise<SwapOrder> {
    const order: SwapOrder = { ...o, status: "open", createdAt: Math.floor(Date.now() / 1000) };
    await this.store.put(order);
    return order;
  }
  async getOrder(id: string) { return this.store.get(id); }
  /** Orders the solver should act on (not terminal). */
  async activeOrders(): Promise<SwapOrder[]> { return this.store.active(); }

  async accept(id: string) {
    const o = await this.must(id);
    if (o.status !== "open") throw new Error(`order not open (${o.status})`);
    o.status = "accepted"; await this.store.put(o); return o;
  }

  /** CANCEL — the maker cancels before any HTLC locks (Cancore: no on-chain
   *  activity). Only valid while open/accepted (before main_locked). */
  async cancel(id: string): Promise<SwapOrder> {
    const o = await this.must(id);
    if (o.status !== "open" && o.status !== "accepted") {
      throw new Error(`cannot cancel — already in progress (status ${o.status})`);
    }
    o.status = "cancelled"; await this.store.put(o); return o;
  }

  async recordMainLock(id: string, mainLockTx: string) {
    const o = await this.must(id);
    if (o.status !== "accepted") throw new Error(`order not accepted (${o.status})`);
    o.status = "main_locked"; o.mainLockTx = mainLockTx; await this.store.put(o); return o;
  }
  /** STEP 4 — ON-LEDGER lock: allocate the solver's cBTC + wrap it in HtlcLock.
   *  cBTC is genuinely locked on-ledger (Allocation), the hashLock recorded in our
   *  DAR, BEFORE the user reveals. Solver is sender+executor (pre-delegation). */
  async lockCounter(id: string) {
    const o = await this.must(id);
    // IDEMPOTENT: if already locked, return — never re-allocate (double-spend guard).
    if (o.status === "counter_locked" && o.allocationCid && o.htlcCid) return o;
    // If we already allocated but the HtlcLock create failed, DON'T allocate again —
    // reuse the existing allocation so a retry doesn't double-spend the solver's cBTC.
    if (o.allocationCid && !o.htlcCid) {
      const hashLockHex0 = o.hashLock.startsWith("0x") ? o.hashLock.slice(2) : o.hashLock;
      const { htlcCid, htlcBlob } = await createHtlcLock({
        solverParty: o.solverCantonParty, receiverParty: o.userCantonParty,
        allocationCid: o.allocationCid, hashLock: hashLockHex0,
        unlockTime: new Date(o.solverTimelock * 1000 - 60_000),
      });
      o.htlcCid = htlcCid; o.htlcBlob = htlcBlob; o.status = "counter_locked"; await this.store.put(o); return o;
    }
    if (o.status !== "main_locked") throw new Error(`main not locked (${o.status})`);

    const holdings = await getHoldings(o.solverCantonParty);
    const inputHoldingCids = holdings.map((h) => h.contractId);
    const now = Date.now();
    // settleBefore = the Canton timelock; HtlcLock unlockTime must be <= settleBefore.
    const settleBeforeMs = o.solverTimelock * 1000;
    const settleBefore = new Date(settleBeforeMs);
    // allocateBefore MUST be <= settleBefore (Allocation template precondition).
    // Use min(now+10min, settleBefore-30s) so short timelocks don't violate it.
    const allocateBefore = new Date(Math.min(now + 10 * 60 * 1000, settleBeforeMs - 30_000));
    const unlockTime = new Date(settleBeforeMs - 60_000); // settleBefore - 1min

    const { allocationCid } = await allocate({
      solverParty: o.solverCantonParty,
      receiverParty: o.userCantonParty,
      amountBtc: o.cbtcAmount,
      inputHoldings: holdings,
      inputHoldingCids,
      settlementId: `htlc-${o.id.slice(0, 18)}-${now}`,
      settleBefore,
      allocateBefore,
    });
    // PERSIST the allocation immediately so a retry after a createHtlcLock failure
    // reuses it instead of allocating again (double-spend guard).
    o.allocationCid = allocationCid; await this.store.put(o);
    const hashLockHex = o.hashLock.startsWith("0x") ? o.hashLock.slice(2) : o.hashLock;
    const { htlcCid, htlcBlob } = await createHtlcLock({
      solverParty: o.solverCantonParty,
      receiverParty: o.userCantonParty,
      allocationCid,
      hashLock: hashLockHex,
      unlockTime,
    });

    o.allocationCid = allocationCid;
    o.htlcCid = htlcCid;
    o.htlcBlob = htlcBlob;
    o.status = "counter_locked"; await this.store.put(o); return o;
  }

  /** STEP 6a — PREPARE the user's Claim command. The Claim is controller=receiver,
   *  so the USER submits it from their Loop wallet (backend CANNOT). Returns the
   *  command + disclosed contracts for the browser's provider.submitTransaction. */
  async prepareClaim(id: string, preimageHex: string): Promise<{ command: unknown; disclosedContracts: unknown[]; synchronizerId: string }> {
    const o = await this.must(id);
    if (o.status !== "counter_locked") throw new Error(`counter not locked (${o.status})`);
    if (!o.htlcCid || !o.allocationCid) throw new Error("on-ledger HtlcLock not present");
    // Backend pre-check so a bad preimage fails fast. The AUTHORITATIVE gate is the
    // ledger's keccak check inside HtlcLock.Claim.
    if (!preimageMatches(preimageHex, o.hashLock)) throw new Error("invalid preimage");
    return prepareClaimCommand({ htlcCid: o.htlcCid, htlcBlob: o.htlcBlob, allocationCid: o.allocationCid, solverParty: o.solverCantonParty, preimageHex });
  }

  /** STEP 6 (PARTICIPANT-MANAGED) — the BACKEND claims the cBTC AS the hosted
   *  receiver (it has CanActAs over the party). The user supplies the preimage at
   *  claim time (secret stays client-side until then). Exercises HtlcLock.Claim on
   *  the ledger → keccak gate → Allocation_ExecuteTransfer → cBTC to the user, and
   *  the preimage is now public (the daemon reads it to claim the WBTC). */
  async claimCounterAsBackend(id: string, preimageHex: string): Promise<{ order: SwapOrder; updateId: string }> {
    const o = await this.must(id);
    if (o.status !== "counter_locked") throw new Error(`counter not locked (${o.status})`);
    if (!o.htlcCid || !o.allocationCid) throw new Error("on-ledger HtlcLock not present");
    if (!preimageMatches(preimageHex, o.hashLock)) throw new Error("invalid preimage");

    const { updateId } = await claimAsReceiver({
      receiverParty: o.userCantonParty,
      solverParty: o.solverCantonParty,
      htlcCid: o.htlcCid,
      htlcBlob: o.htlcBlob,
      allocationCid: o.allocationCid,
      preimageHex,
    });

    o.revealedPreimage = ("0x" + (preimageHex.startsWith("0x") ? preimageHex.slice(2) : preimageHex)) as `0x${string}`;
    o.counterClaimUpdateId = updateId;
    o.status = "counter_claimed"; await this.store.put(o);
    return { order: o, updateId };
  }

  /** STEP 6b — record that the USER's Loop wallet submitted the Claim (cBTC released,
   *  preimage now public on-ledger). The frontend calls this with the updateId after
   *  provider.submitTransaction succeeds. Stores the preimage for the solver's EVM claim. */
  async recordCounterClaimed(id: string, preimageHex: string, updateId: string): Promise<SwapOrder> {
    const o = await this.must(id);
    if (o.status !== "counter_locked" && o.status !== "counter_claimed") {
      throw new Error(`unexpected status ${o.status}`);
    }
    o.revealedPreimage = ("0x" + (preimageHex.startsWith("0x") ? preimageHex.slice(2) : preimageHex)) as `0x${string}`;
    o.counterClaimUpdateId = updateId;
    o.status = "counter_claimed"; await this.store.put(o);
    return o;
  }

  async recordMainClaim(id: string, mainClaimTx: string) {
    const o = await this.must(id);
    if (o.status !== "counter_claimed") throw new Error(`counter not claimed (${o.status})`);
    o.status = "main_claimed"; o.mainClaimTx = mainClaimTx; await this.store.put(o); return o;
  }
  async getRevealedPreimage(id: string) { return (await this.must(id)).revealedPreimage; }

  /** REFUND (cBTC) — after the Canton timelock, the solver withdraws the locked
   *  cBTC via HtlcLock.Refund → Allocation_Withdraw (controller=locker=solver, so
   *  the backend signs it). Only valid once solverTimelock has passed (the ledger
   *  also enforces this: "HTLC: too early"). Returns the cBTC to the solver. */
  async refundCounter(id: string): Promise<{ order: SwapOrder; updateId: string }> {
    const o = await this.must(id);
    if (o.status !== "counter_locked") throw new Error(`nothing to refund (status ${o.status})`);
    if (!o.htlcCid || !o.allocationCid) throw new Error("on-ledger HtlcLock not present");
    const now = Math.floor(Date.now() / 1000);
    if (now < o.solverTimelock) {
      throw new Error(`too early — refund allowed after ${new Date(o.solverTimelock * 1000).toISOString()}`);
    }
    const { updateId } = await refundHtlcLock({
      solverParty: o.solverCantonParty, htlcCid: o.htlcCid, allocationCid: o.allocationCid,
    });
    o.status = "refunded"; await this.store.put(o);
    return { order: o, updateId };
  }

  /** Record that the user retook (refunded) their WBTC on EVM after the timelock. */
  async recordMainRetake(id: string, retakeTx: string): Promise<SwapOrder> {
    const o = await this.must(id);
    o.status = "refunded"; o.mainClaimTx = retakeTx; await this.store.put(o); return o;
  }

  /** Swaps that are counter_locked AND past their Canton timelock — candidates for
   *  the auto-refund sweep (the daemon refunds these to free the solver's cBTC). */
  async refundableOrders(): Promise<SwapOrder[]> {
    const now = Math.floor(Date.now() / 1000);
    return (await this.store.byStatus("counter_locked")).filter((o) => now >= o.solverTimelock);
  }

  private async must(id: string): Promise<SwapOrder> {
    const o = await this.store.get(id);
    if (!o) throw new Error("swap not found");
    return o;
  }
}

let _svc: HtlcService | undefined;
export function htlcService(): HtlcService {
  if (!_svc) {
    // touch NETWORK so a misconfig fails loudly at first use
    if (!NETWORK?.decentralizedPartyId) throw new Error("NETWORK not configured");
    _svc = new HtlcService(new SupabaseSwapStore());
  }
  return _svc;
}

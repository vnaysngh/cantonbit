/**
 * App-native HTLC swap service (B-FE4) for the Next.js API routes.
 *
 * Uses the app's OWN lib/ Canton functions (createTransfer, getHoldings) — no
 * cross-package import into swap-solver (which has its own dependency tree). The
 * order-lifecycle logic mirrors swap-solver/src/htlc-swap-service.ts but releases
 * CBTC via the app's createTransfer.
 *
 * Cancore-aligned reveal-gated flow (NOT a plain transfer): the CBTC is released
 * ONLY when the user submits the correct preimage at claim-counter; the backend
 * verifies keccak256(preimage)==hashLock (orchestrator gate, since CBTC has no
 * on-ledger hashlock — T1), then delivers and stores the preimage for the EVM claim.
 */
import { keccak_256 } from "@noble/hashes/sha3";

import { getHoldings } from "./canton";
import { alert } from "./alert";
import { SWAP_CHAIN, HTLC_ESCROW_ADDRESS } from "./swap-evm";
import {
  createTransfer,
  findOfferFromSender,
  prepareAcceptCommand,
  prepareTransferCommand,
  listPendingOffers,
  acceptTransfer
} from "./transfer";
import { NETWORK } from "./constants";
import { toBaseUnitsFloor } from "./amount-units";
import {
  isNetworkFeeEnabled,
  measureAndLogSolverCounterLockTraffic,
  networkFeeReceiverParty,
  revalidateHtlcNetworkFee
} from "./canton-network-fee";
import {
  recordNetworkFeeCollected
} from "./network-fee-ledger";
import { isEvmTxHash, reverseZeroLockReconcileOutcome } from "./htlc-order-logic";
import {
  allocate,
  createHtlcLock,
  claimAsReceiver,
  refundHtlcLock
} from "./htlc-onledger";
import { SupabaseSwapStore, type SwapStore } from "./htlc-order-store";
import { resolveCreateOrder } from "./htlc-order-logic";
import {
  assertEvmLockSafeForReveal,
  EVM_CLAIM_MARGIN_SECONDS
} from "./htlc-evm-lock-guard";
import {
  evmTxBlockHex,
  assertEvmTransactionFinalized,
  evmBlockAtOrBeforeUnixTime,
  hasEvmClaimedForHashLock,
  isReverseEvmCounterLockReady,
  readErc20Balance,
  readEvmLockMapping,
  verifyForwardRetakeTx,
  verifyReverseClaimTx,
  verifyReverseCounterLockTx
} from "./htlc-evm-counter-lock";
import type { SwapOrder, SwapStatus, SwapDirection } from "./htlc-types";
import { fetchTransactionTreeByCommandId } from "./canton-command-recovery";
import { recoverHtlcCounterDeliveryFromEvents } from "./htlc-counter-delivery-recovery";
import {
  recoverExactAllocationFromEvents,
  recoverExactHtlcLockFromEvents
} from "./htlc-ledger-recovery";
import { matchesInstrument } from "./canton-assets";
import { assertHtlcSettlementQuoteFresh } from "./htlc-quote";

export type { SwapOrder, SwapStatus, SwapDirection };

function isUniqueConstraintViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if ((err as { code?: string }).code === "23505") return true;
  const message = (err as { message?: string }).message ?? "";
  return message.includes("duplicate key") || message.includes("unique constraint");
}

function toHexLower(bytes: Uint8Array): string {
  return (
    "0x" +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}

const HTLC_ESCROW_ADDR = HTLC_ESCROW_ADDRESS;
/** Re-export for daemon alignment — defined in htlc-evm-lock-guard. */
export { EVM_CLAIM_MARGIN_SECONDS };
/** Loop-seller custody: if the WBTC counter-lock hasn't happened within this grace,
 *  the sweep returns the custody early (no point holding the user's funds). */
const LOOP_CUSTODY_GRACE_SECONDS = 30 * 60;
/** Accepted orders that never produce a main lock must not reserve float forever. */
const ACCEPTED_DRAFT_TTL_SECONDS = 30 * 60;
/** Reverse pre-lock reservation TTL: no durable custody/Allocation evidence => release. */
const REVERSE_PRELOCK_RESERVATION_TTL_SECONDS = Number(
  process.env.HTLC_REVERSE_PRELOCK_RESERVATION_TTL_SECONDS ?? 30 * 60
);

/** Marker when Loop transfer auto-settled via solver TransferPreapproval (no pending offer). */
const LOOP_PREAPPROVAL_SETTLED = "transfer-preapproval-settled";

function cbtcAmountsMatch(a: string, b: string): boolean {
  try {
    return toBaseUnitsFloor(a, 8) === toBaseUnitsFloor(b, 8);
  } catch {
    return false;
  }
}

function isSafeReversePrelockReleaseCause(cause: unknown): boolean {
  const msg = cause instanceof Error ? cause.message : String(cause);
  return /transfer offer not visible|no input holdings|insufficient|not found|not visible|missing|expired/i.test(
    msg
  );
}

/** Loop sellers: transfer may auto-accept on the solver (preapproval) — custody is a Holding, not an offer. */
async function detectLoopSellerCustodyHolding(
  solverParty: string,
  amountBtc: string,
  baselineCids: Set<string>,
  reservedCids: Set<string>
): Promise<string | null> {
  const holdings = await getHoldings(solverParty);
  const matches = holdings
    .filter(
      (h) =>
        cbtcAmountsMatch(h.payload.amount, amountBtc) &&
        !baselineCids.has(h.contractId) &&
        !reservedCids.has(h.contractId)
    )
    .sort((a, b) => a.contractId.localeCompare(b.contractId));
  if (matches.length > 1) {
    throw new Error(
      "ambiguous Loop custody deposit — multiple exact new holdings match this order"
    );
  }
  if (matches.length === 1) return matches[0].contractId;
  return null;
}

/** Raw read of the escrow's lock for a hashLock: { unlockTime, amount, receiver }. */
async function readEvmLock(
  hashLockRaw: string
): Promise<{
  unlockTime: number;
  amount: bigint;
  tokenAddress: string;
  receiver: string;
}> {
  const hashLock = (
    hashLockRaw.startsWith("0x") ? hashLockRaw.slice(2) : hashLockRaw
  ).toLowerCase();
  const selector = toHexLower(
    keccak_256(new TextEncoder().encode("locks(bytes32)"))
  ).slice(2, 10);
  const res = await fetch(SWAP_CHAIN.rpcUrls[0], {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [
        { to: HTLC_ESCROW_ADDR, data: `0x${selector}${hashLock}` },
        "latest"
      ]
    }),
    cache: "no-store"
  });
  if (!res.ok) throw new Error(`EVM lock check failed (rpc ${res.status})`);
  const { result, error } = (await res.json()) as {
    result?: string;
    error?: { message?: string };
  };
  if (error || !result || result.length < 2 + 5 * 64)
    throw new Error(
      `EVM lock check failed: ${error?.message ?? "bad rpc result"}`
    );
  const word = (i: number) => result.slice(2 + i * 64, 2 + (i + 1) * 64);
  return {
    unlockTime: parseInt(word(0), 16),
    amount: BigInt(`0x${word(1)}`),
    tokenAddress: `0x${word(2).slice(24)}`.toLowerCase(),
    receiver: `0x${word(4).slice(24)}`.toLowerCase()
  };
}

/**
 * SERVER-SIDE EVM LOCK CHECK (solver-robbery guard): before we release CBTC on
 * reveal (Loop claim-counter OR managed claim-managed), verify on-chain that the
 * user's WBTC is REALLY locked in the HTLC escrow under this order's hashLock —
 * right amount, claimable by OUR solver, with enough time left for the daemon to
 * claim after the reveal. Without this, a late reveal near userTimelock lets the
 * user collect CBTC and still retake WBTC after the solver runs out of time.
 */
async function verifyEvmLock(o: SwapOrder): Promise<void> {
  if (!o.wbtcAmount || !o.solverEvmAddress) {
    throw new Error("EVM leg fields missing on order");
  }
  if (o.mainLockTx) {
    await waitForEvmTransactionFinality(o.mainLockTx);
  }
  const expectedWbtc = SWAP_CHAIN.wbtc?.trim().toLowerCase();
  if (!expectedWbtc) {
    throw new Error("WBTC address not configured — cannot verify EVM lock");
  }
  const { unlockTime, amount, tokenAddress, receiver } = await readEvmLock(o.hashLock);
  assertEvmLockSafeForReveal(
    { unlockTime, amount, tokenAddress, receiver },
    {
      wbtcAmount: o.wbtcAmount,
      solverEvmAddress: o.solverEvmAddress,
      expectedWbtcAddress: expectedWbtc
    }
  );
}

async function waitForEvmTransactionFinality(txHash: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      await assertEvmTransactionFinalized(txHash);
      return;
    } catch (e) {
      lastError = e;
      if (
        !(e instanceof Error) ||
        (!e.message.includes("awaiting finality") &&
          !e.message.includes("not mined yet"))
      ) {
        throw e;
      }
      if (attempt < 11) {
        await new Promise((resolve) => setTimeout(resolve, 2500));
      }
    }
  }
  throw lastError;
}

/** Reverse refund guard: refuse if user claimed WBTC on EVM (even when counterLockTx missing). */
async function assertEvmCounterNotClaimed(o: SwapOrder): Promise<void> {
  if (o.direction !== "canton-to-evm") return;
  if (
    o.status === "main_claimed" ||
    (o.status === "counter_claimed" && o.revealedPreimage)
  ) {
    throw new Error("counter already claimed — swap must settle, not refund");
  }
  try {
    const lock = await readEvmLock(o.hashLock);
    if (lock.amount > 0n) {
      throw new Error(
        "EVM counter is still locked — settlement or solver retake must complete before Canton refund"
      );
    }
    const fromBlockHex = o.counterLockTx
      ? await evmTxBlockHex(o.counterLockTx)
      : o.createdAt
        ? await evmBlockAtOrBeforeUnixTime(o.createdAt - 10 * 60)
        : undefined;
    const claimed = await hasEvmClaimedForHashLock(o.hashLock, {
      fromBlockHex
    });
    if (claimed) {
      throw new Error(
        "EVM counter lock claimed — user may have WBTC; refusing Canton refund"
      );
    }
  } catch (e) {
    if (
      e instanceof Error &&
      (e.message.includes("refusing Canton refund") ||
        e.message.includes("swap must settle, not refund") ||
        e.message.includes("EVM counter is still locked"))
    ) {
      throw e;
    }
    throw new Error(
      `EVM lock check failed — refusing refund: ${e instanceof Error ? e.message : e}`
    );
  }
}

function preimageMatches(preimageHex: string, hashLock: string): boolean {
  const clean = preimageHex.startsWith("0x")
    ? preimageHex.slice(2)
    : preimageHex;
  if (clean.length % 2 !== 0) return false;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  const got = toHexLower(keccak_256(bytes)); // keccak256 of the RAW bytes (EVM-compatible)
  const want = (
    hashLock.startsWith("0x") ? hashLock : "0x" + hashLock
  ).toLowerCase();
  return got === want;
}

class HtlcService {
  constructor(private store: SwapStore) {}

  private async flushNetworkFeeAccounting(
    o: SwapOrder,
    estimate?: {
      feeUsd?: number;
      trafficBytes?: number;
      networkFeeSource?: string;
    }
  ): Promise<void> {
    if (
      !o.networkFeeAccountingPending ||
      !o.networkFeeSettlementUpdateId ||
      !o.networkFeeCc
    ) {
      return;
    }
    try {
      await recordNetworkFeeCollected({
        orderId: o.id,
        orderKind: "htlc",
        userParty: o.userCantonParty,
        feeCc: o.networkFeeCc,
        feeUsd: estimate?.feeUsd,
        trafficBytes: estimate?.trafficBytes,
        networkFeeSource: estimate?.networkFeeSource ?? "reconciled",
        receiverParty: networkFeeReceiverParty(),
        settlementUpdateId: o.networkFeeSettlementUpdateId
      });
      const fresh = await this.must(o.id);
      fresh.networkFeeAccountingPending = false;
      await this.store.putIfStatus(fresh, fresh.status);
    } catch (e) {
      console.warn(
        `[htlc] fee accounting deferred ${o.id.slice(0, 12)}:`,
        e instanceof Error ? e.message : e
      );
    }
  }

  async createOrder(
    o: Omit<SwapOrder, "status" | "createdAt">
  ): Promise<SwapOrder> {
    // No-overwrite + idempotent (audit 2026-06-12) — see resolveCreateOrder.
    const existing = await this.store.get(o.id);
    const { order, isNew } = resolveCreateOrder(
      existing,
      o,
      Math.floor(Date.now() / 1000)
    );
    if (!isNew) return order;
    try {
      await this.store.insert(order);
      return order;
    } catch (e) {
      if (!isUniqueConstraintViolation(e)) throw e;
      const winner = await this.store.get(o.id);
      return resolveCreateOrder(
        winner,
        o,
        Math.floor(Date.now() / 1000)
      ).order;
    }
  }
  async getOrder(id: string) {
    const o = await this.store.get(id);
    if (!o) return undefined;
    return this.reconcilePhantomEvmCounterLock(o);
  }
  /** Orders the solver should act on (not terminal). No on-chain reconcile here —
   *  the daemon polls every few seconds; reconcile runs on getOrder() for UI reads. */
  async activeOrders(): Promise<SwapOrder[]> {
    const all = await this.store.active();
    const actionable = new Set([
      "main_locked",
      "counter_locking",
      "counter_locked",
      "counter_claimed"
    ]);
    return all.filter(
      (o) =>
        (o.direction === "evm-to-canton" || o.direction === "canton-to-evm") &&
        actionable.has(o.status) &&
        !o.id.startsWith("smoke-")
    );
  }

  /** Sync reverse order state with Base Sepolia — fix phantom locks AND recover after user claim. */
  async reconcilePhantomEvmCounterLock(o: SwapOrder): Promise<SwapOrder> {
    if (o.direction !== "canton-to-evm") return o;
    if (
      o.status === "main_claimed" ||
      o.status === "refunded" ||
      o.status === "cancelled" ||
      o.status === "failed"
    ) {
      return o;
    }

    // Waiting for solver WBTC lock — no EVM reconcile yet (keep getOrder fast for polls).
    if (
      o.status === "main_locked" ||
      o.status === "accepted" ||
      o.status === "open"
    ) {
      return o;
    }

    if (o.status === "counter_claimed") return o;

    if (o.status !== "counter_locked") return o;
    if (!o.wbtcAmount || !o.userEvmAddress) return o;

    // C-02: a zero lock amount means the user Claimed OR the solver Retook. We may
    // ONLY advance to counter_claimed on a confirmed Claim, and we must NEVER roll
    // back to main_locked unless we have CONCLUSIVE evidence the lock is gone AND was
    // not claimed — otherwise a swallowed RPC/scan error after a real claim would
    // roll back, the daemon would re-lock the hash, and the solver double-funds.
    // Any error reading the lock / scanning for Claimed is FAIL-CLOSED: keep the
    // order in counter_locked (no rollback) and retry on the next poll.
    let lockAmount: bigint;
    try {
      lockAmount = (await readEvmLockMapping(o.hashLock)).amount;
    } catch (e) {
      console.warn(
        `[htlc] reconcile ${o.id.slice(0, 12)} lock read failed — keeping counter_locked: ${e instanceof Error ? e.message : e}`
      );
      return o; // fail-closed: do not rollback on an RPC error
    }

    if (lockAmount === 0n) {
      // Lock cleared on-chain. Determine WHY before mutating state. A scan error here
      // throws and is fail-closed (we do NOT assume "not claimed").
      let claimed: boolean;
      try {
        const fromBlockHex = o.counterLockTx
          ? await evmTxBlockHex(o.counterLockTx)
          : undefined;
        claimed = await hasEvmClaimedForHashLock(o.hashLock, { fromBlockHex });
      } catch (e) {
        console.warn(
          `[htlc] reconcile ${o.id.slice(0, 12)} Claimed scan failed — keeping counter_locked: ${e instanceof Error ? e.message : e}`
        );
        return o; // fail-closed: never rollback when we cannot confirm claim status
      }
      if (reverseZeroLockReconcileOutcome(claimed) === "counter_claimed") {
        o.status = "counter_claimed";
        return (await this.store.putIfStatus(o, "counter_locked"))
          ? o
          : this.must(o.id);
      }
      // Lock gone, conclusively NOT claimed → solver retook (or lock never landed).
      // Safe to roll back to main_locked so the swap can re-lock or refund.
      console.warn(
        `[htlc] phantom counter_locked ${o.id.slice(0, 12)} — lock cleared, no Claim (tx ${o.counterLockTx?.slice(0, 12) ?? "none"})`
      );
      void alert("warn", "HTLC phantom EVM counter-lock cleared", {
        order: o.id.slice(0, 18),
        counterLockTx: o.counterLockTx?.slice(0, 18) ?? "",
        reason: "lock cleared without Claim (retake or never landed)"
      });
      o.status = "main_locked";
      o.counterLockTx = undefined;
      o.evmFloatReserved = false;
      return (await this.store.putIfStatus(o, "counter_locked"))
        ? o
        : this.must(o.id);
    }

    // Lock amount > 0 → still locked. Confirm it matches what we expect; if not, it's
    // a genuine phantom (wrong/short lock) and may be rolled back.
    const probe = await isReverseEvmCounterLockReady({
      hashLock: o.hashLock,
      wbtcAmount: o.wbtcAmount,
      userEvmAddress: o.userEvmAddress
    });
    if (probe.ready) return o;
    // Fail-closed: transient RPC errors must not roll back a valid counter_lock.
    if (probe.reason.includes("Could not read WBTC lock status")) {
      console.warn(
        `[htlc] reconcile ${o.id.slice(0, 12)} EVM probe failed — keeping counter_locked: ${probe.reason}`
      );
      return o;
    }
    console.warn(
      `[htlc] phantom counter_locked ${o.id.slice(0, 12)} — ${probe.reason} (tx ${o.counterLockTx?.slice(0, 12) ?? "none"})`
    );
    void alert("warn", "HTLC phantom EVM counter-lock cleared", {
      order: o.id.slice(0, 18),
      counterLockTx: o.counterLockTx?.slice(0, 18) ?? "",
      reason: probe.reason
    });
    o.status = "main_locked";
    o.counterLockTx = undefined;
    o.evmFloatReserved = false;
    return (await this.store.putIfStatus(o, "counter_locked"))
      ? o
      : this.must(o.id);
  }
  /** Order history for one user party (newest first). */
  async historyForParty(party: string): Promise<SwapOrder[]> {
    return this.store.byParty(party);
  }

  async accept(id: string) {
    const o = await this.must(id);
    if (o.status !== "open") throw new Error(`order not open (${o.status})`);
    // SOLVENCY GATE (M1): refuse BEFORE the user locks anything if the solver can't
    // fill its leg. Forward (evm→canton): the solver must have the CBTC float.
    // Reverse (canton→evm): WBTC is reserved atomically before the user's Canton
    // lock/custody transfer begins, because EVM balance alone is not a reservation.
    if (o.direction === "evm-to-canton") {
      const holdings = await getHoldings(o.solverCantonParty);
      const floatSats = holdings.reduce(
        (s, h) =>
          s + toBaseUnitsFloor(h.payload.amount ?? "0", 8),
        0n
      );
      // The database serializes this decision per solver party and atomically changes
      // open -> accepted. Only committed in-flight orders reserve float; abandoned
      // open drafts do not consume inventory.
      const reservation = await this.store.acceptWithFloatReservation(
        o.id,
        o.solverCantonParty,
        floatSats
      );
      if (!reservation.accepted) {
        if (reservation.status === "accepted") return this.must(id);
        const availableSats =
          floatSats > reservation.reservedSats
            ? floatSats - reservation.reservedSats
            : 0n;
        if (reservation.reason !== "insufficient_float") {
          throw new Error(
            `order not accepted (${reservation.status ?? reservation.reason ?? "unknown"})`
          );
        }
        void alert("error", "Solver CBTC float too low — order rejected", {
          order: o.id.slice(0, 18),
          have: Number(floatSats) / 1e8,
          reserved: Number(reservation.reservedSats) / 1e8,
          available: Number(availableSats) / 1e8,
          need: o.cbtcAmount
        });
        throw new Error(
          `solver CBTC float too low (available ${Number(availableSats) / 1e8} of ${Number(floatSats) / 1e8}, need ${o.cbtcAmount}) — order rejected before you lock`
        );
      }
      return this.must(id);
    }
    o.status = "accepted";
    if (o.direction === "canton-to-evm" && o.counterMode === "loop") {
      const baseline = await getHoldings(o.solverCantonParty);
      o.solverCustodyBaselineCids = baseline.map((h) => h.contractId);
    }
    if (!(await this.store.putIfStatus(o, "open"))) {
      const fresh = await this.must(id);
      if (fresh.status === "accepted") return fresh;
      throw new Error(`order not open (${fresh.status})`);
    }
    return this.must(id);
  }

  /** CANCEL — the maker cancels before any HTLC locks (Cancore: no on-chain
   *  activity). Only valid while open/accepted (before main_locked). */
  async cancel(id: string): Promise<SwapOrder> {
    const o = await this.must(id);
    if (o.status !== "open" && o.status !== "accepted") {
      throw new Error(
        `cannot cancel — already in progress (status ${o.status})`
      );
    }
    const previous = o.status;
    o.status = "cancelled";
    if (!(await this.store.putIfStatus(o, previous))) {
      const fresh = await this.must(id);
      if (fresh.status === "cancelled") return fresh;
      throw new Error(
        `cannot cancel — already in progress (status ${fresh.status})`
      );
    }
    return o;
  }

  async recordMainLock(id: string, mainLockTx: string) {
    const o = await this.must(id);
    if (!isEvmTxHash(mainLockTx)) {
      throw new Error("invalid EVM main lock transaction hash");
    }
    // Idempotent recovery: if the first request committed but its response was
    // lost, the browser must be able to retry the same hash safely.
    if (o.mainLockTx) {
      if (o.mainLockTx.toLowerCase() !== mainLockTx.toLowerCase()) {
        throw new Error("main lock already recorded with a different transaction");
      }
      return o;
    }
    if (o.status !== "accepted" && o.status !== "main_locking") {
      throw new Error(`order not accepted (${o.status})`);
    }
    if (o.direction !== "evm-to-canton") {
      throw new Error("EVM main lock is only valid for forward swaps");
    }
    if (o.status === "accepted") {
      o.status = "main_locking";
      if (!(await this.store.putIfStatus(o, "accepted"))) {
        const fresh = await this.must(id);
        if (!fresh.mainLockTx && fresh.status === "main_locking") {
          return fresh;
        }
        if (
          fresh.mainLockTx?.toLowerCase() === mainLockTx.toLowerCase()
        ) {
          return fresh;
        }
        throw new Error(`order not accepted (${fresh.status})`);
      }
    }
    try {
      // A receipt timeout only means the transaction may still land. Do not advance
      // the order until the escrow mapping itself proves the exact expected lock.
      await waitForEvmTransactionFinality(mainLockTx);
      await verifyEvmLock(o);
    } catch (e) {
      const rollback = { ...o, status: "accepted" as const };
      await this.store.putIfStatus(rollback, "main_locking").catch(() => {});
      throw e;
    }
    o.status = "main_locked";
    o.mainLockTx = mainLockTx;
    if (!(await this.store.putIfStatus(o, "main_locking"))) {
      return this.must(id);
    }
    return o;
  }

  /** Claim the stage before any solver counter-lock write can begin. */
  async beginCounterLock(
    id: string,
    evmFloatUnits?: bigint
  ): Promise<SwapOrder> {
    const o = await this.must(id);
    if (o.status === "counter_locking" || o.status === "counter_locked") return o;
    if (o.status !== "main_locked") {
      throw new Error(`main not locked (${o.status})`);
    }
    if (o.direction === "canton-to-evm") {
      // Do NOT re-price after the user's Canton leg is already locked. Quote
      // freshness is enforced before lock/custody starts; after that point the
      // solver must either fulfill the committed minOut or let the protocol refund
      // path handle expiry. Re-checking here strands users in main_locked when the
      // market moves after their CBTC is already escrowed.
      if (evmFloatUnits == null || evmFloatUnits < 0n) {
        throw new Error("current solver WBTC balance required");
      }
      const reservation = await this.store.reserveReverseEvmFloat(
        id,
        evmFloatUnits
      );
      if (!reservation.reserved) {
        const available =
          evmFloatUnits > reservation.reservedUnits
            ? evmFloatUnits - reservation.reservedUnits
            : 0n;
        throw new Error(
          `solver WBTC float reserved by other swaps (need ${reservation.needUnits}, available ${available})`
        );
      }
      return this.must(id);
    }
    o.status = "counter_locking";
    if (!(await this.store.putIfStatus(o, "main_locked"))) {
      return this.must(id);
    }
    return o;
  }

  private async reserveReverseFloatBeforeMainLock(
    order: SwapOrder
  ): Promise<SwapOrder> {
    if (order.direction !== "canton-to-evm") return order;
    if (order.status === "main_locking" && order.evmFloatReserved) return order;
    if (order.status !== "accepted") {
      throw new Error(`order not accepted (${order.status})`);
    }
    const wbtc = SWAP_CHAIN.wbtc?.trim();
    const solver = order.solverEvmAddress?.trim();
    if (!wbtc || !solver) {
      throw new Error("canonical solver WBTC inventory is not configured");
    }
    const balance = await readErc20Balance(wbtc, solver);
    const reservation =
      await this.store.reserveReverseEvmFloatBeforeMainLock(order.id, balance);
    if (!reservation.reserved) {
      const available =
        balance > reservation.reservedUnits
          ? balance - reservation.reservedUnits
          : 0n;
      throw new Error(
        `solver WBTC float reserved by other swaps (need ${reservation.needUnits}, available ${available})`
      );
    }
    return this.must(order.id);
  }

  private async createOrRecoverReverseMainHtlc(params: {
    order: SwapOrder;
    allocationCid: string;
    networkFeeCc?: string;
  }): Promise<{
    htlcCid: string;
    htlcBlob: string;
    updateId: string;
    networkFeeCollected?: boolean;
  }> {
    const { order: o, allocationCid, networkFeeCc } = params;
    const hashLock = o.hashLock.replace(/^0x/, "");
    const unlockTime = new Date(o.userTimelock * 1000 - 60_000);
    const commandId = `htlc-lock-main-${o.id}`;
    try {
      return await createHtlcLock({
        solverParty: o.solverCantonParty,
        receiverParty: o.solverCantonParty,
        lockerParty: o.userCantonParty,
        allocationCid,
        amountBtc: o.cbtcAmount!,
        hashLock,
        unlockTime,
        networkFeeCc,
        commandId
      });
    } catch (e) {
      if (!(e instanceof Error) || !e.message.includes("duplicate command committed")) {
        throw e;
      }
      const recovered = await fetchTransactionTreeByCommandId(
        commandId,
        o.userCantonParty,
        50_000
      );
      if (!recovered) {
        throw new Error(
          `duplicate HtlcLock command committed but transaction not found (${commandId})`
        );
      }
      const lock = recoverExactHtlcLockFromEvents(recovered.eventsById, {
        lockerParty: o.userCantonParty,
        receiverParty: o.solverCantonParty,
        executorParty: o.solverCantonParty,
        allocationCid,
        amountBtc: o.cbtcAmount!,
        instrumentId: NETWORK.instrumentId,
        hashLock,
        unlockTime
      });
      if (!lock) {
        throw new Error(
          `committed HtlcLock not found in recovered transaction (${commandId})`
        );
      }
      return {
        ...lock,
        updateId: recovered.updateId,
        networkFeeCollected:
          !!networkFeeCc && Number.parseFloat(networkFeeCc) > 0
      };
    }
  }

  /** Release the claim only when the daemon knows no EVM transaction was submitted. */
  async abortCounterLock(id: string): Promise<SwapOrder> {
    const o = await this.must(id);
    if (o.status !== "counter_locking") return o;
    o.status = "main_locked";
    o.evmFloatReserved = false;
    if (!(await this.store.putIfStatus(o, "counter_locking"))) {
      return this.must(id);
    }
    return o;
  }
  /** STEP 4 — ON-LEDGER lock: allocate the solver's CBTC + wrap it in HtlcLock.
   *  CBTC is genuinely locked on-ledger (Allocation), the hashLock recorded in our
   *  DAR, BEFORE the user reveals. Solver is sender+executor (pre-delegation). */
  async lockCounter(id: string) {
    let o = await this.must(id);
    // IDEMPOTENT: if already locked, return — never re-allocate (double-spend guard).
    if (o.status === "counter_locked" && o.allocationCid && o.htlcCid) return o;
    if (o.status === "main_locked") {
      o = await this.beginCounterLock(id);
    }
    // If we already allocated but the HtlcLock create failed, DON'T allocate again —
    // reuse the existing allocation so a retry doesn't double-spend the solver's CBTC.
    if (o.allocationCid && !o.htlcCid) {
      if (o.direction === "evm-to-canton") {
        await verifyEvmLock(o);
      }
      const hashLockHex0 = o.hashLock.startsWith("0x")
        ? o.hashLock.slice(2)
        : o.hashLock;
      const { htlcCid, htlcBlob } = await createHtlcLock({
        solverParty: o.solverCantonParty,
        receiverParty: o.userCantonParty,
        allocationCid: o.allocationCid,
        amountBtc: o.cbtcAmount!,
        hashLock: hashLockHex0,
        unlockTime: new Date(o.solverTimelock * 1000 - 60_000)
      });
      o.htlcCid = htlcCid;
      o.htlcBlob = htlcBlob;
      o.status = "counter_locked";
      if (!(await this.store.putIfStatus(o, "counter_locking"))) {
        return this.must(id);
      }
      if (o.direction === "evm-to-canton") {
        void measureAndLogSolverCounterLockTraffic({
          context: "lockCounter-create-retry",
          orderId: o.id,
          solverParty: o.solverCantonParty,
          userParty: o.userCantonParty,
          cbtcAmount: o.cbtcAmount!,
          allocationCid: o.allocationCid,
          hashLockHex: hashLockHex0,
          unlockTime: new Date(o.solverTimelock * 1000 - 60_000)
        });
      }
      return o;
    }
    if (o.status !== "counter_locking" && o.status !== "main_locked")
      throw new Error(`main not locked (${o.status})`);
    const expectedStatus = o.status;

    if (o.direction === "evm-to-canton") {
      // Do NOT re-price after the user's WBTC is already locked. Quote freshness is
      // enforced before the user commits funds; after main_locked the solver must
      // either fulfill the committed minOut or wait for the protocol refund path.
      // A flaky price feed must never strand a funded order in counter_locking.
      await verifyEvmLock(o);
    }

    const holdings = await getHoldings(o.solverCantonParty);
    const inputHoldingCids = holdings.map((h) => h.contractId);
    const now = Date.now();
    // settleBefore = the Canton timelock; HtlcLock unlockTime must be <= settleBefore.
    const settleBeforeMs = o.solverTimelock * 1000;
    const settleBefore = new Date(settleBeforeMs);
    // allocateBefore MUST be <= settleBefore (Allocation template precondition).
    // Use min(now+10min, settleBefore-30s) so short timelocks don't violate it.
    const allocateBefore = new Date(
      Math.min(now + 10 * 60 * 1000, settleBeforeMs - 30_000)
    );
    const unlockTime = new Date(settleBeforeMs - 60_000); // settleBefore - 1min

    const { allocationCid } = await allocate({
      solverParty: o.solverCantonParty,
      receiverParty: o.userCantonParty,
      amountBtc: o.cbtcAmount!,
      inputHoldings: holdings,
      inputHoldingCids,
      settlementId: `htlc-${o.id.slice(0, 18)}-${now}`,
      settleBefore,
      allocateBefore
    });
    // PERSIST the allocation immediately so a retry after a createHtlcLock failure
    // reuses it instead of allocating again (double-spend guard).
    o.allocationCid = allocationCid;
    if (!(await this.store.putIfStatus(o, expectedStatus))) {
      return this.must(id);
    }
    const hashLockHex = o.hashLock.startsWith("0x")
      ? o.hashLock.slice(2)
      : o.hashLock;
    const { htlcCid, htlcBlob } = await createHtlcLock({
      solverParty: o.solverCantonParty,
      receiverParty: o.userCantonParty,
      allocationCid,
      amountBtc: o.cbtcAmount!,
      hashLock: hashLockHex,
      unlockTime
    });

    o.allocationCid = allocationCid;
    o.htlcCid = htlcCid;
    o.htlcBlob = htlcBlob;
    o.status = "counter_locked";
    if (!(await this.store.putIfStatus(o, "counter_locking"))) {
      return this.must(id);
    }
    if (o.direction === "evm-to-canton") {
      void measureAndLogSolverCounterLockTraffic({
        context: "lockCounter",
        orderId: o.id,
        solverParty: o.solverCantonParty,
        userParty: o.userCantonParty,
        cbtcAmount: o.cbtcAmount!,
        allocationCid,
        hashLockHex,
        unlockTime
      });
    }
    return o;
  }

  /** LOOP REVEAL + DELIVER — Cancore's venue/custody ordering: SECRET FIRST, then CBTC.
   *
   *  Why this order (solver-robbery guard): if we delivered the CBTC on main_locked,
   *  a user could accept it, never reveal the secret, and retake their WBTC after the
   *  EVM timelock — robbing the solver. So the user's "Claim" click sends us the
   *  preimage FIRST; once we hold a valid preimage we can ALWAYS claim the WBTC
   *  (status flips to counter_claimed → the daemon claims it), and only then do we
   *  deliver the CBTC via a STANDARD TransferFactory_Transfer the user accepts in
   *  their Loop wallet. The user signs ONLY standard choices; all secret logic is on
   *  our node (Loop's Option 1, same custody model Cancore ships for Loop users).
   *
   *  IDEMPOTENT on retry: preimage step keys on status; delivery keys on
   *  counterTransferUpdateId (persisted the instant createTransfer returns).
   */
  async claimCounter(
    id: string,
    preimageHex: string
  ): Promise<{ order: SwapOrder; updateId: string; delivered: boolean }> {
    let o = await this.must(id);
    if (o.counterMode !== "loop") {
      throw new Error(
        `claim-counter is the Loop path (mode ${o.counterMode ?? "managed"}); managed users use claim-managed`
      );
    }
    // main_claimed is fine too — the daemon may have already claimed the WBTC after
    // the reveal (the custody ordering); the user is just completing their accept.
    if (
      o.status !== "main_locked" &&
      o.status !== "counter_claimed" &&
      o.status !== "main_claimed"
    ) {
      throw new Error(`unexpected status ${o.status}`);
    }
    if (!preimageMatches(preimageHex, o.hashLock))
      throw new Error("invalid preimage");

    // 1. SECRET FIRST — persist the preimage + flip to counter_claimed BEFORE any
    // delivery. From this moment the daemon can claim the WBTC; we are unrobbable.
    // (Only from main_locked — never downgrade counter_claimed/main_claimed.)
    if (o.status === "main_locked") {
      // 0. EVM LOCK CHECK — the WBTC must REALLY be locked for our solver with time to
      // spare. Do not re-price here: the user has already locked WBTC, and a price
      // source outage must not block reveal/delivery of the committed quote.
      await verifyEvmLock(o);

      o.revealedPreimage = ("0x" +
        (preimageHex.startsWith("0x")
          ? preimageHex.slice(2)
          : preimageHex)) as `0x${string}`;
      o.status = "counter_claimed";
      if (!(await this.store.putIfStatus(o, "main_locked"))) {
        o = await this.must(id);
        if (o.status !== "counter_claimed" && o.status !== "main_claimed") {
          throw new Error(`reveal lost lifecycle race (${o.status})`);
        }
      }
    }

    // 2. DELIVER the CBTC via a STANDARD transfer (no custom DAR). When the user's
    // Loop wallet has the CBTC PREAPPROVAL (the mandatory auto-accept gate), the
    // registry executes this as a DIRECT transfer — it COMPLETES in one step and
    // there is NO offer to accept (delivered=true). Otherwise an offer is created
    // and the user accepts it with TransferInstruction_Accept (delivered=false).
    // DOUBLE-SPEND GUARD: counterTransferUpdateId is persisted right after
    // createTransfer returns. To also close the crash-window BETWEEN the on-ledger
    // commit and that persist, use a DETERMINISTIC commandId so a retry hits the
    // ledger's duplicate-command dedup instead of sending a second transfer.
    let delivered = false;
    if (!o.counterTransferUpdateId) {
      const holdings = await getHoldings(o.solverCantonParty);
      const commandId = `htlc-counter-deliver-${id}`;
      let updateId: string;
      let offerContractId: string | undefined;
      let transferKind: string | undefined;
      try {
        ({ updateId, offerContractId, transferKind } = await createTransfer({
          senderParty: o.solverCantonParty,
          receiverParty: o.userCantonParty, // the Loop party (cross-participant)
          amountBtc: o.cbtcAmount!,
          inputHoldings: holdings,
          commandId
        }));
      } catch (e) {
        // F7: a retry after a committed-but-unpersisted transfer. The deterministic
        // commandId means the ledger already committed this exact transfer and now
        // rejects the re-submit as a duplicate — so the user WAS delivered, we just
        // crashed before persisting. Recover WITHOUT re-sending.
        if (e instanceof Error && e.message.includes("duplicate command committed")) {
          const fresh = await this.must(id);
          if (fresh.counterTransferUpdateId) {
            return {
              order: fresh,
              updateId: fresh.counterTransferUpdateId,
              delivered: !fresh.counterTransferOfferCid
            };
          }
          const committed = await fetchTransactionTreeByCommandId(
            commandId,
            o.solverCantonParty
          );
          if (!committed) {
            throw new Error(
              `duplicate command committed but counter delivery transaction not found (${commandId})`
            );
          }
          const recovered = recoverHtlcCounterDeliveryFromEvents(
            committed.eventsById,
            {
              senderParty: o.solverCantonParty,
              receiverParty: o.userCantonParty,
              amountBtc: o.cbtcAmount ?? "",
              expectedInstrument: NETWORK.instrumentId
            }
          );
          if (!recovered) {
            throw new Error(
              `committed counter delivery lacks receiver evidence (${commandId})`
            );
          }
          const persisted = await this.persistLoopCounterDeliveryEvidence({
            id,
            updateId: committed.updateId,
            offerContractId: recovered.offerCid
          });
          return {
            order: persisted,
            updateId: committed.updateId,
            delivered: recovered.delivered
          };
        }
        throw e;
      }
      o = await this.persistLoopCounterDeliveryEvidence({
        id,
        updateId,
        offerContractId
      });
      // No offer created = the transfer self-completed (preapproval auto-accept).
      delivered = !offerContractId;
      console.log(
        `[htlc] loop deliver ${id}: kind=${transferKind} delivered=${delivered}`
      );
    } else if (!o.counterTransferOfferCid) {
      // RETRY path with no recorded offer: either it auto-accepted (direct) or the
      // offer was already accepted. If no pending offer exists on-ledger, the CBTC
      // is with the user — nothing left to accept.
      const pending = await findOfferFromSender(
        o.solverCantonParty,
        o.userCantonParty
      );
      if (pending) {
        o.counterTransferOfferCid = pending;
        if (!(await this.store.putIfStatus(o, o.status))) {
          throw new Error("counter offer recovery lost lifecycle race");
        }
      } else delivered = true;
    }
    return { order: o, updateId: o.counterTransferUpdateId ?? "", delivered };
  }

  private async persistLoopCounterDeliveryEvidence(params: {
    id: string;
    updateId: string;
    offerContractId?: string;
  }): Promise<SwapOrder> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const fresh = await this.must(params.id);
      if (
        fresh.status !== "counter_claimed" &&
        fresh.status !== "main_claimed"
      ) {
        throw new Error(
          `counter delivery committed but order is no longer reveal-settled (${fresh.status})`
        );
      }
      if (
        fresh.counterTransferUpdateId &&
        fresh.counterTransferUpdateId !== params.updateId
      ) {
        throw new Error(
          "counter delivery already recorded with a different update id"
        );
      }
      if (
        params.offerContractId &&
        fresh.counterTransferOfferCid &&
        fresh.counterTransferOfferCid !== params.offerContractId
      ) {
        throw new Error(
          "counter delivery already recorded with a different offer id"
        );
      }

      fresh.counterTransferUpdateId =
        fresh.counterTransferUpdateId ?? params.updateId;
      fresh.counterTransferOfferCid =
        fresh.counterTransferOfferCid ?? params.offerContractId;
      const expectedStatus = fresh.status;
      if (await this.store.putIfStatus(fresh, expectedStatus)) return fresh;
    }

    const final = await this.must(params.id);
    if (final.counterTransferUpdateId === params.updateId) return final;
    throw new Error("counter delivery evidence persistence lost lifecycle race");
  }

  /** PREPARE the standard TransferInstruction_Accept command for the Loop user to
   *  sign in their own wallet. Standard Splice choice (no custom DAR) → runs on
   *  Loop's node. Only available AFTER the reveal+deliver (claimCounter). */
  async prepareLoopAccept(
    id: string
  ): Promise<{
    command: unknown;
    disclosedContracts: unknown[];
    synchronizerId: string;
  }> {
    const o = await this.must(id);
    if (o.counterMode !== "loop")
      throw new Error(`order is not a loop swap (mode ${o.counterMode})`);
    // counter_claimed = revealed+delivered; main_claimed = daemon already took the
    // WBTC too (normal custody ordering) — the user's accept is valid in both.
    if (o.status !== "counter_claimed" && o.status !== "main_claimed") {
      throw new Error(
        `counter transfer not ready (status ${o.status}) — reveal the secret first`
      );
    }
    if (!o.counterTransferUpdateId)
      throw new Error(
        "counter transfer not sent yet — reveal the secret first"
      );
    // RECOVERY: if the offer cid wasn't captured from the tx tree at create time,
    // find it from the SENDER's ACS (the solver sees the offers it created, even
    // when the receiver is cross-participant).
    if (!o.counterTransferOfferCid) {
      const recovered = await findOfferFromSender(
        o.solverCantonParty,
        o.userCantonParty
      );
      if (!recovered)
        throw new Error(
          "CBTC transfer offer not found on-ledger — it may have expired (24h TTL)"
        );
      o.counterTransferOfferCid = recovered;
      if (!(await this.store.putIfStatus(o, o.status))) {
        throw new Error("counter offer recovery lost lifecycle race");
      }
    }
    return prepareAcceptCommand({ offerContractId: o.counterTransferOfferCid });
  }

  /** Loop forward accept compatibility wrapper. Loop HTLC CC fees are not separately charged. */
  async prepareLoopAcceptWithFee(
    id: string,
    ccHoldingCids?: string[]
  ): Promise<{
    command: unknown;
    commands: unknown[];
    disclosedContracts: unknown[];
    synchronizerId: string;
    actAs: string[];
    networkFeeCc?: string;
  }> {
    const o = await this.must(id);
    const primary = await this.prepareLoopAccept(id);
    void ccHoldingCids;
    return {
      ...primary,
      commands: [primary.command],
      actAs: [o.userCantonParty],
      networkFeeCc: undefined
    };
  }

  /** STEP 6 (PARTICIPANT-MANAGED) — the BACKEND claims the CBTC AS the hosted
   *  receiver (it has CanActAs over the party). The user supplies the preimage at
   *  claim time (secret stays client-side until then). Exercises HtlcLock.Claim on
   *  the ledger → keccak gate → Allocation_ExecuteTransfer → CBTC to the user, and
   *  the preimage is now public (the daemon reads it to claim the WBTC). */
  async claimCounterAsBackend(
    id: string,
    preimageHex: string
  ): Promise<{ order: SwapOrder; updateId: string }> {
    const o = await this.must(id);
    if (o.status !== "counter_locked")
      throw new Error(`counter not locked (${o.status})`);
    if (!o.htlcCid || !o.allocationCid)
      throw new Error("on-ledger HtlcLock not present");
    if (!preimageMatches(preimageHex, o.hashLock))
      throw new Error("invalid preimage");

    // Same solver-robbery guard as claimCounter — reject late reveals when the EVM
    // lock no longer gives the daemon enough time to claim WBTC before user retake.
    if (o.direction === "evm-to-canton") await verifyEvmLock(o);

    let networkFeeCc: string | undefined;
    let feeEstimate:
      | Awaited<ReturnType<typeof revalidateHtlcNetworkFee>>
      | undefined;
    if (isNetworkFeeEnabled() && o.counterMode === "managed") {
      feeEstimate = await revalidateHtlcNetworkFee({
        order: o,
        action: "htlc-claim",
        preimageHex
      });
      networkFeeCc = feeEstimate.feeCc;
    }

    let updateId: string;
    let networkFeeCollected = false;
    try {
      const result = await claimAsReceiver({
        receiverParty: o.userCantonParty,
        solverParty: o.solverCantonParty,
        htlcCid: o.htlcCid,
        htlcBlob: o.htlcBlob,
        allocationCid: o.allocationCid,
        preimageHex,
        networkFeeCc,
        commandId: `htlc-claim-managed-${id}`
      });
      updateId = result.updateId;
      networkFeeCollected = !!result.networkFeeCollected;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("duplicate command committed")) {
        const fresh = await this.must(id);
        if (fresh.status === "counter_claimed") {
          return { order: fresh, updateId: fresh.counterClaimUpdateId ?? "" };
        }
        // C-04: ledger committed but DB never advanced — heal durable state.
        if (fresh.status === "counter_locked") {
          const commandId = `htlc-claim-managed-${id}`;
          const recovered = await fetchTransactionTreeByCommandId(
            commandId,
            o.userCantonParty,
            50_000
          );
          if (!recovered) {
            throw new Error(
              `duplicate claim committed but transaction not found (${commandId})`
            );
          }
          fresh.revealedPreimage = ("0x" +
            (preimageHex.startsWith("0x")
              ? preimageHex.slice(2)
              : preimageHex)) as `0x${string}`;
          fresh.counterClaimUpdateId = recovered.updateId;
          fresh.status = "counter_claimed";
          if (!(await this.store.putIfStatus(fresh, "counter_locked"))) {
            return { order: await this.must(id), updateId: recovered.updateId };
          }
          return { order: fresh, updateId: recovered.updateId };
        }
      }
      throw e;
    }

    o.revealedPreimage = ("0x" +
      (preimageHex.startsWith("0x")
        ? preimageHex.slice(2)
        : preimageHex)) as `0x${string}`;
    o.counterClaimUpdateId = updateId;
    o.status = "counter_claimed";
    if (networkFeeCollected && networkFeeCc) {
      o.networkFeeCc = networkFeeCc;
      o.networkFeeSettlementUpdateId = updateId;
      o.networkFeeAccountingPending = true;
    }
    if (!(await this.store.putIfStatus(o, "counter_locked"))) {
      return { order: await this.must(id), updateId };
    }

    if (networkFeeCollected && feeEstimate && networkFeeCc) {
      await this.flushNetworkFeeAccounting(o, {
        feeUsd: feeEstimate.feeUsd,
        trafficBytes: feeEstimate.trafficBytes,
        networkFeeSource: feeEstimate.networkFeeSource
      });
    }

    return { order: o, updateId };
  }

  // ===================== REVERSE DIRECTION (canton-to-evm) =====================
  // Main leg = CANTON (user's CBTC, LONG timelock = userTimelock). Counter leg =
  // EVM (solver's WBTC, SHORT timelock = solverTimelock). The user reveals the
  // secret by MetaMask-claiming the WBTC; the solver then claims the CBTC via the
  // on-ledger keccak-gated HtlcLock.Claim. Fully trustless (email users only —
  // both Canton parties are local on warpx). See docs/canton-to-evm-design.md.

  /** REVERSE STEP 2 — backend locks the USER's CBTC on-ledger (CanActAs = Cancore's
   *  "platform auto-locks"): Allocation sender=user, receiver=solver, executor=
   *  solver + HtlcLock locker=user. Idempotent (allocation persisted first). */
  async lockMainCanton(id: string): Promise<SwapOrder> {
    let o = await this.must(id);
    if (o.direction !== "canton-to-evm")
      throw new Error(`lock-main is canton-to-evm only`);
    if (o.counterMode !== "managed")
      throw new Error(
        "canton-to-evm requires a participant-managed (email) user in v1"
      );
    if (o.status === "main_locked" && o.allocationCid && o.htlcCid) return o;
    if (o.status === "accepted") {
      await assertHtlcSettlementQuoteFresh(o);
      o = await this.reserveReverseFloatBeforeMainLock(o);
    }
    // Retry after a partial run: allocation exists, HtlcLock create failed.
    if (o.allocationCid && !o.htlcCid) {
      let networkFeeCc: string | undefined;
      let feeEstimate:
        | Awaited<ReturnType<typeof revalidateHtlcNetworkFee>>
        | undefined;
      if (isNetworkFeeEnabled() && o.counterMode === "managed") {
        feeEstimate = await revalidateHtlcNetworkFee({
          order: o,
          action: "htlc-lock"
        });
        networkFeeCc = feeEstimate.feeCc;
      }
      const {
        htlcCid,
        htlcBlob,
        updateId: createUpdateId,
        networkFeeCollected
      } = await this.createOrRecoverReverseMainHtlc({
        order: o,
        allocationCid: o.allocationCid,
        networkFeeCc
      });
      o.htlcCid = htlcCid;
      o.htlcBlob = htlcBlob;
      o.status = "main_locked";
      if (networkFeeCollected && networkFeeCc) {
        o.networkFeeCc = networkFeeCc;
        o.networkFeeSettlementUpdateId = createUpdateId;
        o.networkFeeAccountingPending = true;
      }
      if (!(await this.store.putIfStatus(o, "main_locking"))) {
        return this.must(id);
      }
      if (networkFeeCollected && feeEstimate && networkFeeCc) {
        await this.flushNetworkFeeAccounting(o, {
          feeUsd: feeEstimate.feeUsd,
          trafficBytes: feeEstimate.trafficBytes,
          networkFeeSource: feeEstimate.networkFeeSource
        });
      }
      return o;
    }
    if (o.status !== "main_locking")
      throw new Error(`order not accepted (${o.status})`);

    let networkFeeCc: string | undefined;
    let feeEstimate:
      | Awaited<ReturnType<typeof revalidateHtlcNetworkFee>>
      | undefined;
    if (isNetworkFeeEnabled() && o.counterMode === "managed") {
      feeEstimate = await revalidateHtlcNetworkFee({
        order: o,
        action: "htlc-lock"
      });
      networkFeeCc = feeEstimate.feeCc;
    }

    const holdings = await getHoldings(o.userCantonParty); // the USER's CBTC
    const now = Date.now();
    const settleBeforeMs = o.userTimelock * 1000; // LONG leg
    const settlementId = `htlc-rev-${o.id.slice(0, 18)}`;
    const allocationCommandId = `htlc-lock-alloc-${id}`;
    const settleBefore = new Date(settleBeforeMs);
    let allocationCid: string;
    try {
      ({ allocationCid } = await allocate({
        solverParty: o.solverCantonParty, // executor
        senderParty: o.userCantonParty, // the user locks THEIR holdings
        receiverParty: o.solverCantonParty, // solver receives on claim
        amountBtc: o.cbtcAmount!,
        inputHoldings: holdings,
        inputHoldingCids: holdings.map((h) => h.contractId),
        settlementId,
        settleBefore,
        allocateBefore: new Date(
          Math.min(now + 10 * 60 * 1000, settleBeforeMs - 30_000)
        ),
        commandId: allocationCommandId
      }));
    } catch (e) {
      if (
        !(e instanceof Error) ||
        !e.message.includes("duplicate command committed")
      ) {
        throw e;
      }
      const recovered = await fetchTransactionTreeByCommandId(
        allocationCommandId,
        o.userCantonParty,
        50_000
      );
      if (!recovered) {
        throw new Error(
          `duplicate Allocation command committed but transaction not found (${allocationCommandId})`
        );
      }
      const allocation = recoverExactAllocationFromEvents(
        recovered.eventsById,
        {
          settlementId,
          senderParty: o.userCantonParty,
          receiverParty: o.solverCantonParty,
          executorParty: o.solverCantonParty,
          amountBtc: o.cbtcAmount!,
          instrumentId: NETWORK.instrumentId,
          settleBefore
        }
      );
      if (!allocation) {
        throw new Error(
          `committed Allocation not found in recovered transaction (${allocationCommandId})`
        );
      }
      allocationCid = allocation.allocationCid;
    }
    o.allocationCid = allocationCid;
    if (!(await this.store.putIfStatus(o, "main_locking"))) {
      return this.must(id);
    }
    const {
      htlcCid,
      htlcBlob,
      updateId: createUpdateId,
      networkFeeCollected
    } = await this.createOrRecoverReverseMainHtlc({
      order: o,
      allocationCid,
      networkFeeCc
    });
    o.htlcCid = htlcCid;
    o.htlcBlob = htlcBlob;
    o.status = "main_locked";
    if (networkFeeCollected && networkFeeCc) {
      o.networkFeeCc = networkFeeCc;
      o.networkFeeSettlementUpdateId = createUpdateId;
      o.networkFeeAccountingPending = true;
    }
    if (!(await this.store.putIfStatus(o, "main_locking"))) {
      return this.must(id);
    }
    if (networkFeeCollected && feeEstimate && networkFeeCc) {
      await this.flushNetworkFeeAccounting(o, {
        feeUsd: feeEstimate.feeUsd,
        trafficBytes: feeEstimate.trafficBytes,
        networkFeeSource: feeEstimate.networkFeeSource
      });
    }
    return o;
  }

  /** REVERSE STEP 3 record — the solver locked the WBTC on EVM (short timelock). */
  async recordCounterLocked(
    id: string,
    counterLockTx: string
  ): Promise<SwapOrder> {
    let o = await this.must(id);
    if (o.direction !== "canton-to-evm")
      throw new Error("counter-lock is canton-to-evm only");
    if (o.status === "counter_locked") {
      const reconciled = await this.reconcilePhantomEvmCounterLock(o);
      if (reconciled.status === "counter_locked") return reconciled;
      o = reconciled;
    }
    if (o.status !== "counter_locking" && o.status !== "main_locked")
      throw new Error(`main not locked (${o.status})`);
    const expectedStatus = o.status;
    if (!o.wbtcAmount || !o.userEvmAddress || o.solverTimelock == null) {
      throw new Error("order missing EVM counter-lock fields");
    }
    const expectedWbtc = SWAP_CHAIN.wbtc?.trim();
    if (!expectedWbtc) {
      throw new Error("WBTC address not configured — cannot verify counter-lock");
    }
    await verifyReverseCounterLockTx(counterLockTx, {
      hashLock: o.hashLock,
      wbtcAmount: o.wbtcAmount,
      userEvmAddress: o.userEvmAddress,
      solverTimelock: o.solverTimelock,
      expectedWbtcAddress: expectedWbtc
    });
    o.counterLockTx = counterLockTx;
    o.status = "counter_locked";
    o.evmFloatReserved = false;
    if (!(await this.store.putIfStatus(o, expectedStatus))) {
      return this.must(id);
    }
    return o;
  }

  /** REVERSE STEP 5 — the SOLVER claims the user's CBTC with the preimage the user
   *  revealed on EVM (recorded by the UI or by the daemon's Claimed-event watch).
   *  HtlcLock.Claim controller=receiver=solver (LOCAL, own authority) → on-ledger
   *  keccak gate → Allocation_ExecuteTransfer. */
  async claimMainAsSolver(
    id: string,
    preimageHex?: string
  ): Promise<{ order: SwapOrder; updateId: string }> {
    let o = await this.must(id);
    if (o.direction !== "canton-to-evm")
      throw new Error("claim-main is canton-to-evm only");
    if (o.status === "main_claimed")
      return { order: o, updateId: o.counterClaimUpdateId ?? "" };
    if (o.status !== "counter_claimed" && o.status !== "counter_locked") {
      throw new Error(`unexpected status ${o.status}`);
    }
    let expectedStatus: SwapStatus = o.status;
    const preimage =
      preimageHex ??
      (o.revealedPreimage ? o.revealedPreimage.slice(2) : undefined);
    if (!preimage) throw new Error("no preimage — user has not revealed yet");
    if (!preimageMatches(preimage, o.hashLock))
      throw new Error("invalid preimage");
    const normalizedPreimage = ("0x" +
      (preimage.startsWith("0x")
        ? preimage.slice(2)
        : preimage)) as `0x${string}`;

    // The EVM claim has made the preimage public. Persist that fact BEFORE trying
    // the Canton claim so auto-refund can never race a revealed secret, and so a
    // failed Canton submit does not force the daemon to rediscover the event forever.
    if (o.revealedPreimage !== normalizedPreimage || o.status === "counter_locked") {
      const expected = o.status;
      const withReveal: SwapOrder = {
        ...o,
        status: "counter_claimed",
        revealedPreimage: normalizedPreimage
      };
      if (await this.store.putIfStatus(withReveal, expected)) {
        o = withReveal;
      } else {
        const fresh = await this.must(id);
        if (fresh.status === "main_claimed") {
          return { order: fresh, updateId: fresh.counterClaimUpdateId ?? "" };
        }
        if (
          fresh.status !== "counter_claimed" ||
          fresh.revealedPreimage !== normalizedPreimage
        ) {
          throw new Error(`claim-main state changed (${fresh.status})`);
        }
        o = fresh;
      }
    }
    expectedStatus = o.status;
    let updateId: string;
    if (o.counterMode === "loop") {
      // LOOP SELLER (Variant A custody): the CBTC entered our float at lock time
      // (transfer-to-venue accept). The user's EVM claim revealed the preimage —
      // the swap is settled; NO Canton action remains. Just record completion.
      if (!o.counterTransferUpdateId)
        throw new Error("custody transfer not recorded — lock step incomplete");
      updateId = o.counterTransferUpdateId;
    } else {
      if (!o.htlcCid || !o.allocationCid)
        throw new Error("on-ledger HtlcLock not present");
      const commandId = `htlc-claim-main-${id}`;
      const recoverCommittedClaim = async () =>
        fetchTransactionTreeByCommandId(
          commandId,
          o.solverCantonParty,
          50_000
        );
      const alreadyCommitted = await recoverCommittedClaim();
      if (alreadyCommitted) {
        updateId = alreadyCommitted.updateId;
      } else {
        try {
          ({ updateId } = await claimAsReceiver({
            receiverParty: o.solverCantonParty, // the solver IS the receiver here
            solverParty: o.solverCantonParty,
            htlcCid: o.htlcCid,
            htlcBlob: o.htlcBlob,
            allocationCid: o.allocationCid,
            preimageHex: preimage,
            commandId
          }));
        } catch (e) {
          const recovered = await recoverCommittedClaim();
          if (recovered) {
            updateId = recovered.updateId;
          } else {
            if (
              !(e instanceof Error) ||
              !e.message.includes("duplicate command committed")
            ) {
              throw e;
            }
            throw new Error(
              `duplicate main claim committed but transaction not found (${commandId})`
            );
          }
        }
      }
    }
    o.revealedPreimage = normalizedPreimage;
    o.status = "main_claimed";
    o.evmFloatReserved = false;
    o.counterClaimUpdateId = updateId;
    if (!(await this.store.putIfStatus(o, expectedStatus))) {
      return { order: await this.must(id), updateId };
    }
    return { order: o, updateId };
  }

  // ============ LOOP SELLERS (canton-to-evm, external wallet) ============
  // L-02: BUILT = Variant A (transfer-to-venue custody, = Cancore): the user signs a
  // STANDARD TransferFactory_Transfer (user → venue) in THEIR wallet; the backend
  // accepts it as the venue → custody. No custom contract touches the Loop party.
  // DEAD = Variant B (allocation escrow): proven UNSETTLEABLE on-node — the CBTC
  // DvpLegAllocation.ExecuteTransfer needs sender+receiver+executor all three live,
  // impossible cross-participant. See docs/canton-to-evm-design.md.

  /** STEP 2a (LOOP SELLER, Variant A = Cancore's transfer-to-venue) — build the
   *  STANDARD TransferFactory_Transfer (user → venue) for the user's wallet.
   *  Holding cids are read in the BROWSER (we can't see a Loop party's holdings).
   *
   *  WHY NOT THE ALLOCATION ESCROW (settled 2026-06-12, proven on-node): the CBTC
   *  DvpLegAllocation's ExecuteTransfer needs sender+receiver+executor ALL THREE at
   *  execute time — a bare allocation with a cross-participant party can be locked
   *  but settled by NO ONE. Custody is forced; it's exactly what Cancore ships. */
  async prepareLoopSellerLock(
    id: string,
    holdingCids: string[]
  ): Promise<{
    command: unknown;
    disclosedContracts: unknown[];
    synchronizerId: string;
  }> {
    let o = await this.must(id);
    if (o.direction !== "canton-to-evm" || o.counterMode !== "loop") {
      throw new Error(
        "prepare-lock-loop is for Loop-seller (canton-to-evm) orders only"
      );
    }
    if (o.status === "accepted") {
      await assertHtlcSettlementQuoteFresh(o);
      o = await this.reserveReverseFloatBeforeMainLock(o);
    }
    if (o.status !== "main_locking")
      throw new Error(`order not accepted (${o.status})`);
    if (!holdingCids?.length) throw new Error("no input holdings supplied");
    return prepareTransferCommand({
      senderParty: o.userCantonParty,
      receiverParty: o.solverCantonParty,
      amountBtc: o.cbtcAmount!,
      inputHoldingCids: holdingCids
    });
  }

  /** Loop reverse seller lock (user→venue transfer). L-02: reverse Loop HTLC
   *  charges NO Oranj network fee (forward-only policy), so there is no fee leg —
   *  this builds the transfer command only. (Name kept for the existing route.) */
  async prepareLoopSellerLockWithFee(
    id: string,
    holdingCids: string[]
  ): Promise<{
    command: unknown;
    commands: unknown[];
    disclosedContracts: unknown[];
    synchronizerId: string;
    actAs: string[];
  }> {
    const o = await this.must(id);
    const primary = await this.prepareLoopSellerLock(id, holdingCids);
    return {
      ...primary,
      commands: [primary.command],
      actAs: [o.userCantonParty]
    };
  }

  /** STEP 2b (LOOP SELLER) — find the user's transfer offer in OUR view and ACCEPT
   *  it as the venue (custody starts) → main_locked. Never trusts the browser.
   *  Polls the solver ACS — cross-participant offers can lag a few seconds after
   *  the Loop wallet submits, and a page refresh may leave confirm never called. */
  async confirmLoopSellerLock(
    id: string,
    opts?: { maxAttempts?: number; pollMs?: number }
  ): Promise<SwapOrder> {
    let o = await this.must(id);
    if (o.direction !== "canton-to-evm" || o.counterMode !== "loop") {
      throw new Error("confirm-lock-loop is for Loop-seller orders only");
    }
    if (o.status === "main_locked") return o; // idempotent
    if (o.status === "accepted") {
      await assertHtlcSettlementQuoteFresh(o);
      o = await this.reserveReverseFloatBeforeMainLock(o);
    }
    if (o.status !== "main_locking")
      throw new Error(`order not accepted (${o.status})`);

    const maxAttempts = opts?.maxAttempts ?? 15;
    const pollMs = opts?.pollMs ?? 2000;
    if (!o.solverCustodyBaselineCids) {
      throw new Error(
        "custody baseline missing — refusing to infer a Loop deposit from current vault holdings"
      );
    }
    const baselineCids = new Set(o.solverCustodyBaselineCids);

    // Holdings already linked to other in-flight loop-seller orders (same amount).
    const active = await this.store.active();
    const reservedCids = new Set(
      active
        .filter(
          (x) =>
            x.id !== id &&
            x.counterTransferOfferCid &&
            x.direction === "canton-to-evm" &&
            x.counterMode === "loop" &&
            !["refunded", "cancelled", "failed", "main_claimed", "both_claimed"].includes(
              x.status
            )
        )
        .map((x) => x.counterTransferOfferCid as string)
    );

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const offers = await listPendingOffers(o.solverCantonParty);
      const matchingOffers = offers.filter(
        (x) =>
          x.sender === o.userCantonParty &&
          x.receiver === o.solverCantonParty &&
          cbtcAmountsMatch(x.amountBtc, o.cbtcAmount!) &&
          !!x.instrumentId &&
          matchesInstrument(x.instrumentId, NETWORK.instrumentId)
      );
      if (matchingOffers.length > 1) {
        throw new Error(
          "ambiguous Loop custody transfer — multiple exact offers match this order"
        );
      }
      const offer = matchingOffers[0];
      if (offer) {
        const { updateId } = await acceptTransfer({
          receiverParty: o.solverCantonParty,
          offerContractId: offer.contractId
        });
        o.counterTransferOfferCid = offer.contractId;
        o.counterTransferUpdateId = updateId;
        o.status = "main_locked";
        if (!(await this.store.putIfStatus(o, "main_locking"))) {
          return this.must(id);
        }
        return o;
      }

      // TransferPreapproval on the solver can auto-accept cross-participant Loop
      // transfers — CBTC lands as a Holding with no pending TransferInstruction.
      const custodyHolding = await detectLoopSellerCustodyHolding(
        o.solverCantonParty,
        o.cbtcAmount!,
        baselineCids,
        reservedCids
      );
      if (custodyHolding) {
        o.counterTransferOfferCid = custodyHolding;
        o.counterTransferUpdateId = LOOP_PREAPPROVAL_SETTLED;
        o.status = "main_locked";
        if (!(await this.store.putIfStatus(o, "main_locking"))) {
          return this.must(id);
        }
        return o;
      }

      if (attempt < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, pollMs));
      }
    }

    const rollback = {
      ...o,
      status: "accepted" as const,
      evmFloatReserved: false
    };
    await this.store.putIfStatus(rollback, "main_locking").catch(() => {});
    throw new Error(
      "transfer offer not visible on-ledger yet — connect Loop and use Retry lock, or wait a moment and confirm again. " +
        "If you already signed in Loop, tap Confirm CBTC lock on Orders (custody may have auto-settled)."
    );
  }

  /** REVERSE refund — after the LONG (Canton) timelock, return the CBTC to the
   *  USER: HtlcLock.Refund as locker=user (backend CanActAs) → Allocation_Withdraw. */
  async refundMainCanton(
    id: string
  ): Promise<{ order: SwapOrder; updateId: string }> {
    const o = await this.must(id);
    if (o.direction !== "canton-to-evm") {
      throw new Error("refund-main is canton-to-evm only");
    }
    // `refunding` is accepted for recovery re-entry (a prior attempt crashed between
    // the on-ledger transfer and the `refunded` write — finish it idempotently).
    if (
      o.status !== "main_locked" &&
      o.status !== "counter_locking" &&
      o.status !== "counter_locked" &&
      o.status !== "counter_claimed" &&
      o.status !== "refunding"
    ) {
      throw new Error(`not refundable (${o.status})`);
    }
    if (Date.now() / 1000 < o.userTimelock)
      throw new Error("Canton timelock not reached yet");
    // REFUND-vs-CLAIM RACE GUARD (both modes): once the secret is public the swap
    // MUST settle (the user has, or can, claim the WBTC). Refunding the CBTC then
    // would let the user keep both legs. The on-ledger HtlcLock.Refund timelock is a
    // backstop, but never even attempt a refund once revealed.
    if (o.revealedPreimage)
      throw new Error("preimage revealed — swap must settle, not refund");
    await assertEvmCounterNotClaimed(o);

    // CONCURRENCY + CRASH GUARD (F2). The Loop branch issues a fresh createTransfer
    // from the solver's float — NOT idempotent on its own — and the sweep runs from
    // two triggers (daemon POST + cron GET). We use a DURABLE transient `refunding`
    // status (not a jump straight to `refunded`):
    //   1. CAS-claim `refunding` from the current status. Losing = someone else owns
    //      the refund → return their result, never send a 2nd transfer.
    //   2. Do the on-ledger return with a DETERMINISTIC commandId so a retry after a
    //      commit/crash hits the ledger's duplicate dedup instead of paying twice.
    //   3. Mark `refunded`. A crash between (2) and (3) leaves the order `refunding`
    //      (recoverable) rather than terminal-unpaid — a later sweep re-runs the
    //      idempotent transfer and advances to `refunded`. (refundMainCanton itself
    //      accepts `refunding` as a re-entry status below.)
    const prevStatus = o.status;
    o.status = "refunding";
    o.evmFloatReserved = false;
    const wonRefund = await this.store.putIfStatus(o, prevStatus);
    if (!wonRefund) {
      const fresh = await this.must(id);
      // Another worker may still be mid-refund (status 'refunding'); return its state.
      return { order: fresh, updateId: fresh.counterTransferUpdateId ?? "" };
    }

    let updateId: string;
    try {
      if (o.counterMode === "loop") {
        // LOOP SELLER custody refund — send the custodied CBTC straight back (direct
        // transfer; the user's preapproval auto-accepts). Deterministic commandId so
        // a retry after a committed-but-unrecorded transfer dedups at the ledger.
        if (!o.counterTransferUpdateId)
          throw new Error("no custody transfer recorded — nothing to refund");
        const holdings = await getHoldings(o.solverCantonParty);
        ({ updateId } = await createTransfer({
          senderParty: o.solverCantonParty,
          receiverParty: o.userCantonParty,
          amountBtc: o.cbtcAmount!,
          inputHoldings: holdings,
          commandId: `htlc-refund-main-${id}`
        }));
      } else {
        if (!o.htlcCid || !o.allocationCid)
          throw new Error("on-ledger HtlcLock not present");
        ({ updateId } = await refundHtlcLock({
          solverParty: o.solverCantonParty,
          lockerParty: o.userCantonParty,
          htlcCid: o.htlcCid,
          allocationCid: o.allocationCid,
          commandId: `htlc-refund-main-${id}`
        }));
      }
    } catch (e) {
      // Transfer failed AFTER claiming `refunding`. If the ledger says the refund
      // already committed (duplicate command), the user WAS paid — fall through to
      // mark refunded. Otherwise roll back to the prior status so a sweep retries —
      // but ONLY if the row is still `refunding` (CAS, not an unconditional put), so
      // we never clobber a concurrent sweep that already advanced it to `refunded`.
      if (e instanceof Error && e.message.includes("duplicate command committed")) {
        const commandId = `htlc-refund-main-${id}`;
        const recovered = await fetchTransactionTreeByCommandId(
          commandId,
          o.counterMode === "loop"
            ? o.solverCantonParty
            : o.userCantonParty,
          50_000
        );
        if (!recovered) {
          throw new Error(
            `duplicate refund committed but transaction not found (${commandId})`
          );
        }
        updateId = recovered.updateId;
      } else {
        const rollback = { ...o, status: prevStatus };
        await this.store.putIfStatus(rollback, "refunding").catch(() => {});
        throw e;
      }
    }
    o.status = "refunded";
    o.counterClaimUpdateId = updateId;
    if (!(await this.store.putIfStatus(o, "refunding"))) {
      return { order: await this.must(id), updateId };
    }
    return { order: o, updateId };
  }

  /** STEP 6b — record that the USER's Loop wallet submitted the Claim (CBTC released,
   *  preimage now public on-ledger). The frontend calls this with the updateId after
   *  provider.submitTransaction succeeds. Stores the preimage for the solver's EVM claim. */
  async recordCounterClaimed(
    id: string,
    preimageHex: string,
    updateId: string
  ): Promise<SwapOrder> {
    const o = await this.must(id);
    // GUARD: a forward MANAGED order must settle via claimCounterAsBackend (which
    // ACTUALLY claims the CBTC on-ledger), NOT this record-only endpoint — else a
    // client could mark it counter_claimed without the CBTC moving, then the daemon
    // pays out the WBTC. Only Loop-buyer (forward) and reverse orders use this path.
    if (o.direction === "evm-to-canton" && o.counterMode === "managed") {
      throw new Error(
        "forward managed orders settle via claim-managed, not claim-record"
      );
    }
    if (o.status !== "counter_locked" && o.status !== "counter_claimed") {
      throw new Error(`unexpected status ${o.status}`);
    }
    if (o.status === "counter_claimed") return o;
    // DEFENSE-IN-DEPTH (solver-robbery guard): for ANY forward order, re-verify the
    // EVM WBTC lock has enough margin BEFORE we record the reveal — same guard as
    // claimCounter/claimCounterAsBackend. Today no forward order reaches this path
    // without that check already having run (forward managed is rejected above;
    // forward Loop reveals via claimCounter), so this is belt-and-suspenders: if a
    // future change ever routes a forward order here, a late reveal still cannot rob
    // the solver.
    if (o.direction === "evm-to-canton") await verifyEvmLock(o);
    // VALIDATE the preimage (same gate as the managed path). The browser supplies it,
    // so reject a junk preimage here — recording a bad one as counter_claimed would
    // stall the solver's EVM claim with an unusable secret. (The on-chain claim also
    // re-checks keccak, but we must not corrupt order state.)
    if (!preimageMatches(preimageHex, o.hashLock))
      throw new Error("invalid preimage");
    const claimRef = updateId.trim();
    if (o.direction === "canton-to-evm") {
      const fromBlockHex = o.counterLockTx
        ? await evmTxBlockHex(o.counterLockTx)
        : undefined;
      const claimed = await hasEvmClaimedForHashLock(o.hashLock, {
        fromBlockHex
      });
      if (!claimed) {
        throw new Error(
          "EVM WBTC not claimed on-chain — refusing to record preimage"
        );
      }
      if (isEvmTxHash(claimRef)) {
        await verifyReverseClaimTx(claimRef, o.hashLock);
      }
    }
    o.revealedPreimage = ("0x" +
      (preimageHex.startsWith("0x")
        ? preimageHex.slice(2)
        : preimageHex)) as `0x${string}`;
    if (o.direction === "canton-to-evm" && isEvmTxHash(claimRef)) {
      o.mainClaimTx = claimRef;
    } else {
      o.counterClaimUpdateId = claimRef;
    }
    o.status = "counter_claimed";
    if (!(await this.store.putIfStatus(o, "counter_locked"))) {
      return this.must(id);
    }
    return o;
  }

  async recordMainClaim(id: string, mainClaimTx: string) {
    const o = await this.must(id);
    // FORWARD-ONLY endpoint (records the solver's EVM WBTC claim). A stale daemon
    // once hit this for a REVERSE order and falsely marked it main_claimed without
    // the Canton settlement ever happening. Hard-reject reverse orders.
    if (o.direction === "canton-to-evm")
      throw new Error(
        "main-claim is forward-only; reverse orders settle via claim-main"
      );
    if (o.status !== "counter_claimed")
      throw new Error(`counter not claimed (${o.status})`);
    await verifyReverseClaimTx(mainClaimTx, o.hashLock);
    o.status = "main_claimed";
    o.mainClaimTx = mainClaimTx;
    if (!(await this.store.putIfStatus(o, "counter_claimed"))) {
      return this.must(id);
    }
    return o;
  }
  async getRevealedPreimage(id: string) {
    return (await this.must(id)).revealedPreimage;
  }

  /** REFUND (CBTC) — after the Canton timelock, the solver withdraws the locked
   *  CBTC via HtlcLock.Refund → Allocation_Withdraw (controller=locker=solver, so
   *  the backend signs it). Only valid once solverTimelock has passed (the ledger
   *  also enforces this: "HTLC: too early"). Returns the CBTC to the solver. */
  async refundCounter(
    id: string
  ): Promise<{ order: SwapOrder; updateId: string }> {
    const o = await this.must(id);
    if (o.status !== "counter_locked" && o.status !== "refunding")
      throw new Error(`nothing to refund (status ${o.status})`);
    const htlcCid = o.htlcCid;
    const allocationCid = o.allocationCid;
    if (!htlcCid || !allocationCid)
      throw new Error("on-ledger HtlcLock not present");
    const now = Math.floor(Date.now() / 1000);
    if (now < o.solverTimelock) {
      throw new Error(
        `too early — refund allowed after ${new Date(o.solverTimelock * 1000).toISOString()}`
      );
    }
    const previous = o.status;
    o.status = "refunding";
    if (!(await this.store.putIfStatus(o, previous))) {
      const fresh = await this.must(id);
      return { order: fresh, updateId: fresh.counterClaimUpdateId ?? "" };
    }
    const commandId = `htlc-refund-counter-${id}`;
    let updateId: string;
    try {
      ({ updateId } = await refundHtlcLock({
        solverParty: o.solverCantonParty,
        htlcCid,
        allocationCid,
        commandId
      }));
    } catch (e) {
      if (e instanceof Error && e.message.includes("duplicate command committed")) {
        const recovered = await fetchTransactionTreeByCommandId(
          commandId,
          o.solverCantonParty,
          50_000
        );
        if (!recovered) {
          throw new Error(
            `duplicate refund committed but transaction not found (${commandId})`
          );
        }
        updateId = recovered.updateId;
      } else {
        const rollback = { ...o, status: "counter_locked" as const };
        await this.store.putIfStatus(rollback, "refunding").catch(() => {});
        throw e;
      }
    }
    o.status = "refunded";
    o.counterClaimUpdateId = updateId;
    if (!(await this.store.putIfStatus(o, "refunding"))) {
      return { order: await this.must(id), updateId };
    }
    return { order: o, updateId };
  }

  /** Record that the user retook (refunded) their WBTC on EVM after the timelock. */
  async recordMainRetake(id: string, retakeTx: string): Promise<SwapOrder> {
    const o = await this.must(id);
    // GUARD: this records the user's EVM WBTC retake (forward direction only) and is
    // bookkeeping. Reject reverse orders and any settled/terminal state so a stray
    // or stale POST can't knock a live/completed order out of the active set.
    if (o.direction !== "evm-to-canton")
      throw new Error("retake-main is forward-only");
    if (
      o.status === "main_claimed" ||
      o.status === "refunded" ||
      o.status === "cancelled"
    ) {
      throw new Error(`order already terminal (${o.status})`);
    }
    await verifyForwardRetakeTx(retakeTx, o.hashLock);
    // STRANDED-FLOAT GUARD: if the order is still counter_locked, the SOLVER's CBTC
    // is locked on-ledger. Marking 'refunded' here would drop it from refundableOrders()
    // (which scans counter_locked) and the auto-refund sweep would never free it. So
    // refund the solver's CBTC HtlcLock NOW (the user retaking WBTC means userTimelock
    // passed, and the ladder guarantees solverTimelock < userTimelock, so the counter
    // refund window is open). If the on-ledger refund fails, leave the order in
    // counter_locked so the sweep retries — do NOT mark refunded with float stranded.
    const previousStatus = o.status;
    o.mainClaimTx = retakeTx;
    if (previousStatus === "counter_locked" && o.htlcCid && o.allocationCid) {
      if (!(await this.store.putIfStatus(o, "counter_locked"))) {
        return this.must(id);
      }
      return (await this.refundCounter(id)).order;
    }
    o.status = previousStatus === "counter_claimed" ? "failed" : "refunded";
    if (!(await this.store.putIfStatus(o, previousStatus))) {
      return this.must(id);
    }
    return o;
  }

  /** Swaps that are counter_locked AND past their Canton timelock — candidates for
   *  the auto-refund sweep (the daemon refunds these to free the solver's CBTC). */
  async refundableOrders(): Promise<SwapOrder[]> {
    const now = Math.floor(Date.now() / 1000);
    return (await this.store.byStatus("counter_locked")).filter(
      (o) => now >= o.solverTimelock
    );
  }

  /** All expired-and-actionable orders, categorized for the auto-refund sweep.
   *  - forwardCounter: evm→canton MANAGED orders whose on-ledger CBTC HtlcLock
   *    (solver's) expired → refundCounter. (Loop orders never lock CBTC.)
   *  - reverseMain: canton→evm orders whose on-ledger CBTC HtlcLock (USER's)
   *    expired → refundMainCanton (backend CanActAs — fully automated).
   *  - staleForwardMain: evm→canton orders stuck in main_locked past the EVM
   *    timelock — nothing of OURS is locked (the user retakes their WBTC on EVM
   *    with their own key); mark refunded so the active list drains. */
  async expiredOrders(): Promise<{
    abandonedAccepted: SwapOrder[];
    forwardCounter: SwapOrder[];
    reverseMain: SwapOrder[];
    staleForwardMain: SwapOrder[];
    staleLoopSeller: SwapOrder[];
    loopCustodyStalled: SwapOrder[];
  }> {
    const now = Math.floor(Date.now() / 1000);
    const [accepted, counterLocked, counterLocking, counterClaimed, mainLocked, refunding] = await Promise.all([
      this.store.byStatus("accepted"),
      this.store.byStatus("counter_locked"),
      this.store.byStatus("counter_locking"),
      this.store.byStatus("counter_claimed"),
      this.store.byStatus("main_locked"),
      // F2 recovery: orders stuck mid-refund (crashed between the on-ledger transfer
      // and the `refunded` write) must be re-swept so the idempotent refund finishes.
      this.store.byStatus("refunding")
    ]);
    return {
      abandonedAccepted: accepted.filter(
        (o) =>
          now >=
          (o.updatedAt ?? o.createdAt) + ACCEPTED_DRAFT_TTL_SECONDS
      ),
      forwardCounter: [...counterLocked, ...refunding].filter(
        (o) =>
          o.direction === "evm-to-canton" &&
          o.counterMode !== "loop" &&
          !!o.htlcCid &&
          now >= o.solverTimelock
      ),
      // Exclude revealed orders — once the secret is public the swap settles, never
      // refunds (refund-vs-claim race guard). Include `refunding` for crash recovery.
      reverseMain: [...mainLocked, ...counterLocking, ...counterLocked, ...counterClaimed, ...refunding].filter(
        (o) =>
          o.direction === "canton-to-evm" &&
          o.counterMode !== "loop" &&
          !!o.htlcCid &&
          !o.revealedPreimage &&
          now >= o.userTimelock
      ),
      staleForwardMain: mainLocked.filter(
        (o) => o.direction === "evm-to-canton" && now >= o.userTimelock
      ),
      // LOOP SELLERS (Variant A custody): WE hold the CBTC → the sweep sends it
      // straight back after the timelock (refundMainCanton, fully automated). Skip
      // revealed (settled) orders. Include `refunding` for crash recovery.
      staleLoopSeller: [...mainLocked, ...counterLocking, ...counterLocked, ...refunding].filter(
        (o) =>
          o.direction === "canton-to-evm" &&
          o.counterMode === "loop" &&
          !o.revealedPreimage &&
          now >= o.userTimelock
      ),
      // EARLY refund (hardening): custody taken but the WBTC counter-lock never
      // happened within the grace window — return the custody NOW instead of
      // making the user wait out the full timelock. Verified safe in
      // earlyRefundLoopCustody (on-chain check that NO WBTC lock exists).
      // Include `refunding` so an EARLY refund that crashed mid-transfer (now
      // `refunding`, still before userTimelock) is re-swept and finished idempotently —
      // otherwise no bucket would re-select it until userTimelock passed.
      loopCustodyStalled: [...mainLocked, ...refunding].filter(
        (o) =>
          o.direction === "canton-to-evm" &&
          o.counterMode === "loop" &&
          now >= o.createdAt + LOOP_CUSTODY_GRACE_SECONDS &&
          now < o.userTimelock
      )
    };
  }

  /** Recover or release stale reverse pre-lock reservations. */
  async reconcileReverseMainLocking(): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    const orders = await this.store.byStatus("main_locking");
    let reconciled = 0;
    for (const order of orders) {
      if (
        order.direction !== "canton-to-evm" ||
        now <
          (order.updatedAt ?? order.createdAt) +
            REVERSE_PRELOCK_RESERVATION_TTL_SECONDS
      ) {
        continue;
      }
      try {
        const result =
          order.counterMode === "loop"
            ? await this.confirmLoopSellerLock(order.id, {
                maxAttempts: 1,
                pollMs: 0
              })
            : await this.lockMainCanton(order.id);
        if (result.status !== "main_locking") reconciled++;
      } catch (e) {
        const fresh = await this.must(order.id);
        if (fresh.status !== "main_locking") {
          reconciled++;
          continue;
        }
        if (await this.releaseStaleReversePrelockReservation(fresh, e)) {
          reconciled++;
        }
      }
    }
    return reconciled;
  }

  private async releaseStaleReversePrelockReservation(
    order: SwapOrder,
    cause: unknown
  ): Promise<boolean> {
    if (
      order.status !== "main_locking" ||
      order.direction !== "canton-to-evm" ||
      order.allocationCid ||
      order.htlcCid ||
      order.counterTransferUpdateId
    ) {
      return false;
    }

    const commandId = `htlc-lock-alloc-${order.id}`;
    let recovered: Awaited<ReturnType<typeof fetchTransactionTreeByCommandId>>;
    try {
      recovered = await fetchTransactionTreeByCommandId(
        commandId,
        order.userCantonParty,
        50_000
      );
    } catch (e) {
      void alert("warn", "Kept stale reverse HTLC WBTC reservation after recovery scan failure", {
        order: order.id.slice(0, 18),
        reason: (e instanceof Error ? e.message : String(e)).slice(0, 180)
      });
      return false;
    }
    if (recovered?.eventsById) {
      const settlementId = `htlc-rev-${order.id.slice(0, 18)}`;
      const allocation = recoverExactAllocationFromEvents(recovered.eventsById, {
        settlementId,
        senderParty: order.userCantonParty,
        receiverParty: order.solverCantonParty,
        executorParty: order.solverCantonParty,
        amountBtc: order.cbtcAmount!,
        instrumentId: NETWORK.instrumentId,
        settleBefore: new Date(order.userTimelock * 1000)
      });
      if (allocation) {
        order.allocationCid = allocation.allocationCid;
        return this.store.putIfStatus(order, "main_locking");
      }
    }

    const detail = cause instanceof Error ? cause.message : String(cause);
    if (!isSafeReversePrelockReleaseCause(cause)) {
      void alert("warn", "Kept stale reverse HTLC WBTC reservation after ambiguous failure", {
        order: order.id.slice(0, 18),
        reason: detail.slice(0, 180)
      });
      return false;
    }

    void alert("warn", "Released stale reverse HTLC WBTC reservation", {
      order: order.id.slice(0, 18),
      reason: detail.slice(0, 180)
    });
    order.status = "failed";
    order.evmFloatReserved = false;
    return this.store.putIfStatus(order, "main_locking");
  }

  /** Release stale accepted exposure, but recover a forward EVM lock if it landed. */
  async expireAbandonedAccepted(id: string): Promise<SwapOrder> {
    const o = await this.must(id);
    if (o.status !== "accepted") return o;
    if (
      Math.floor(Date.now() / 1000) <
      (o.updatedAt ?? o.createdAt) + ACCEPTED_DRAFT_TTL_SECONDS
    ) {
      throw new Error("accepted-order grace period has not elapsed");
    }

    if (o.direction === "evm-to-canton") {
      let lock: Awaited<ReturnType<typeof readEvmLock>>;
      try {
        lock = await readEvmLock(o.hashLock);
      } catch (e) {
        throw new Error(
          `could not verify stale accepted EVM lock: ${e instanceof Error ? e.message : e}`
        );
      }
      if (lock.amount > 0n) {
        await verifyEvmLock(o);
        o.status = "main_locked";
        if (!(await this.store.putIfStatus(o, "accepted"))) {
          return this.must(id);
        }
        return o;
      }
    }

    o.status = "cancelled";
    if (!(await this.store.putIfStatus(o, "accepted"))) {
      return this.must(id);
    }
    return o;
  }

  /** EARLY custody return for a stalled Loop-seller swap (no WBTC counter-lock).
   *  SAFETY: only from main_locked, only when the secret is unrevealed, and only
   *  after an ON-CHAIN check that no WBTC lock exists under this hashLock (so a
   *  daemon that locked but failed to report can't be double-paid). */
  async earlyRefundLoopCustody(
    id: string
  ): Promise<{ order: SwapOrder; updateId: string }> {
    const o = await this.must(id);
    if (o.direction !== "canton-to-evm" || o.counterMode !== "loop")
      throw new Error("early refund is loop-seller only");
    // Accept `refunding` for recovery re-entry (a prior attempt crashed mid-refund).
    if (o.status !== "main_locked" && o.status !== "refunding")
      throw new Error(`not stalled (${o.status})`);
    if (o.revealedPreimage)
      throw new Error("preimage revealed — swap must settle, not refund");
    if (!o.counterTransferUpdateId)
      throw new Error("no custody transfer recorded");
    const lock = await readEvmLock(o.hashLock);
    if (lock.amount > 0n)
      throw new Error("WBTC lock exists on-chain — not stalled, do not refund");
    // CONCURRENCY + CRASH GUARD (F2): durable `refunding` CAS + deterministic
    // commandId, identical to refundMainCanton. The shared commandId
    // (htlc-refund-main-${id}) makes the two refund entry points mutually idempotent
    // at the ledger — whichever runs second dedups instead of double-paying.
    const prevStatus = o.status;
    o.status = "refunding";
    if (!(await this.store.putIfStatus(o, prevStatus))) {
      const fresh = await this.must(id);
      return { order: fresh, updateId: fresh.counterTransferUpdateId ?? "" };
    }
    let updateId: string;
    try {
      const holdings = await getHoldings(o.solverCantonParty);
      ({ updateId } = await createTransfer({
        senderParty: o.solverCantonParty,
        receiverParty: o.userCantonParty,
        amountBtc: o.cbtcAmount!,
        inputHoldings: holdings,
        commandId: `htlc-refund-main-${id}`
      }));
    } catch (e) {
      if (e instanceof Error && e.message.includes("duplicate command committed")) {
        const commandId = `htlc-refund-main-${id}`;
        const recovered = await fetchTransactionTreeByCommandId(
          commandId,
          o.solverCantonParty,
          50_000
        );
        if (!recovered) {
          throw new Error(
            `duplicate refund committed but transaction not found (${commandId})`
          );
        }
        updateId = recovered.updateId;
      } else {
        // CAS rollback (not an unconditional put) — don't clobber a concurrent
        // sweep that already advanced this order to `refunded`.
        const rollback = { ...o, status: prevStatus };
        await this.store.putIfStatus(rollback, "refunding").catch(() => {});
        throw e;
      }
    }
    o.status = "refunded";
    o.counterClaimUpdateId = updateId;
    if (!(await this.store.putIfStatus(o, "refunding"))) {
      return { order: await this.must(id), updateId };
    }
    return { order: o, updateId };
  }

  /** Bookkeeping: mark a dead order refunded (no on-ledger action by US — used when
   *  the locked funds are recoverable only by the USER's own signature: their EVM
   *  WBTC retake, or a Loop seller's Allocation_Withdraw). */
  async markRefunded(id: string): Promise<SwapOrder> {
    const o = await this.must(id);
    if (o.status !== "main_locked" && o.status !== "counter_locked")
      throw new Error(`not stale (${o.status})`);
    const previousStatus = o.status;
    o.status = "refunded";
    o.evmFloatReserved = false;
    return (await this.store.putIfStatus(o, previousStatus))
      ? o
      : this.must(id);
  }

  async reconcileNetworkFeeAccounting(): Promise<number> {
    const pending = await this.store.pendingNetworkFeeAccounting();
    let completed = 0;
    for (const o of pending) {
      const before = o.networkFeeAccountingPending;
      await this.flushNetworkFeeAccounting(o);
      if (before) {
        const fresh = await this.must(o.id);
        if (!fresh.networkFeeAccountingPending) completed++;
      }
    }
    return completed;
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
    if (!NETWORK?.decentralizedPartyId)
      throw new Error("NETWORK not configured");
    _svc = new HtlcService(new SupabaseSwapStore());
  }
  return _svc;
}

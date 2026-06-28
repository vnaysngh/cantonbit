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
import { Buffer } from "node:buffer";

import { getHoldings } from "./canton";
import { alert } from "./alert";
import { chainConfigForOrder } from "./swap-evm";
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
import {
  isEvmTxHash,
  reverseZeroLockReconcileOutcome,
  isRefundMainCantonStatusEligible,
  isReverseMainExpiredSweepCandidate
} from "./htlc-order-logic";
import { htlcCanExposePreimageToSolver, htlcForwardLoopDeliveryProven, htlcVisibleCompleted } from "./swap-product-invariants";
import { htlcUserWbtcClaimTx } from "./htlc-order-logic";
import {
  allocate,
  createHtlcLock,
  claimAsReceiver,
  refundHtlcLock
} from "./htlc-onledger";
import { SupabaseSwapStore, type SwapStore } from "./htlc-order-store";
import { resolveCreateOrder } from "./htlc-order-logic";
import {
  assertValidPrepareCreatedAt
} from "./swap-prepare-intent";
import {
  isCustodyEvidenceConflictError,
  isSafeReversePrelockReleaseCause
} from "./htlc-loop-custody-logic";
import {
  assertEvmLockSafeForReveal,
  EVM_CLAIM_MARGIN_SECONDS
} from "./htlc-evm-lock-guard";
import {
  evmTxBlockHex,
  type EvmProofOpts,
  assertEvmTransactionFinalized,
  evmBlockAtOrBeforeUnixTime,
  hasEvmClaimedForHashLock,
  findEvmClaimTxForHashLock,
  findEvmRetakeTxForHashLock,
  isReverseEvmCounterLockReady,
  readErc20Balance,
  readEvmLockMapping,
  verifyForwardRetakeTx,
  verifyReverseClaimTx,
  verifyReverseCounterLockTx
} from "./htlc-evm-counter-lock";
import type { SwapOrder, SwapStatus, SwapDirection } from "./htlc-types";
import { fetchTransactionTreeByCommandId, fetchTransactionTreeForOfferAccept } from "./canton-command-recovery";
import { fetchUpdateEventsById } from "./canton-swap-leg-verify";
import { recoverHtlcCounterDeliveryFromEvents } from "./htlc-counter-delivery-recovery";
import { counterOfferConsumedInEvents } from "./canton-swap-leg-verify-logic";
import {
  recoverExactAllocationFromEvents,
  recoverExactHtlcLockFromEvents
} from "./htlc-ledger-recovery";
import { matchesInstrument } from "./canton-assets";
import { assertHtlcSettlementQuoteFresh } from "./htlc-quote";
import { TRANSFER_REASON_META_KEY } from "./transfer-options";
import { htlcLoopCounterDeliveryMemo, htlcReverseLoopCustodyMemoFromTerms, HTLC_REVERSE_LOOP_MEMO_PREFIX } from "./swap-transfer-memo";
import { verifyHtlcReverseLoopCustodySubmit } from "./htlc-reverse-custody-verify";

export type { SwapOrder, SwapStatus, SwapDirection };

type GetOrderMode = "full" | "light";

function reconcileCacheKey(id: string, mode: GetOrderMode): string {
  return `${id}:${mode}`;
}

function isUniqueConstraintViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if ((err as { code?: string }).code === "23505") return true;
  const message = (err as { message?: string }).message ?? "";
  return message.includes("duplicate key") || message.includes("unique constraint");
}

function isAwaitingEvmFinality(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.message.includes("EVM transaction awaiting finality")
  );
}

function isExpiredTransferInstructionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /deadline-exceeded|executeBefore.*future|Transfer `executeBefore` must be in the future/i.test(
    msg
  );
}

function isInactiveTransferInstructionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /LOCAL_VERDICT_INACTIVE_CONTRACT|INACTIVE_CONTRACT|contract.*inactive|not active/i.test(
    msg
  );
}

function toHexLower(bytes: Uint8Array): string {
  return (
    "0x" +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}

/** Re-export for daemon alignment — defined in htlc-evm-lock-guard. */
export { EVM_CLAIM_MARGIN_SECONDS };
/** Loop-seller custody: if the WBTC counter-lock hasn't happened within this grace,
 *  the sweep returns the custody early (no point holding the user's funds). */
const LOOP_CUSTODY_GRACE_SECONDS = 30 * 60;
/** Accepted orders that never produce a main lock must not reserve float forever. */
const ACCEPTED_DRAFT_TTL_SECONDS = Number(
  process.env.HTLC_ACCEPTED_DRAFT_TTL_SECONDS ?? 10 * 60
);
/** Max concurrent forward accepted drafts (reserved CBTC, no EVM lock yet) per party. */
const FORWARD_ACCEPTED_DRAFT_CAP = Number(
  process.env.HTLC_FORWARD_ACCEPTED_DRAFT_CAP ?? 2
);
/** Max concurrent reverse Loop pre-locks (reserved WBTC, no custody yet) per party. */
const REVERSE_PRELOCK_DRAFT_CAP = Number(
  process.env.HTLC_REVERSE_PRELOCK_DRAFT_CAP ?? 2
);
/** Reverse pre-lock reservation TTL: no durable custody/Allocation evidence => release. */
const REVERSE_PRELOCK_RESERVATION_TTL_SECONDS = Number(
  process.env.HTLC_REVERSE_PRELOCK_RESERVATION_TTL_SECONDS ?? 10 * 60
);
/** Managed reverse bare Allocation (allocationCid set, htlcCid missing) recovery TTL. */
const BARE_ALLOCATION_RECOVERY_TTL_SECONDS = Number(
  process.env.HTLC_BARE_ALLOCATION_RECOVERY_TTL_SECONDS ?? 10 * 60
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

function reverseLoopCustodyMemo(order: SwapOrder): string {
  return htlcReverseLoopCustodyMemoFromTerms({
    id: order.id,
    createdAt: order.createdAt,
    userCantonParty: order.userCantonParty,
    solverCantonParty: order.solverCantonParty
  });
}

function evmProofOptsForOrder(order: SwapOrder): EvmProofOpts & {
  expectedWbtcAddress: string;
} {
  const chain = chainConfigForOrder(order);
  if (!chain.escrow?.trim()) {
    throw new Error(`HTLC escrow not configured for ${chain.slug}`);
  }
  if (!chain.wbtc?.trim()) {
    throw new Error(`WBTC address not configured for ${chain.slug}`);
  }
  return {
    rpcUrl: chain.rpcUrls[0],
    escrowAddress: chain.escrow,
    chainName: chain.name,
    chainSlug: chain.slug,
    expectedWbtcAddress: chain.wbtc
  };
}

function transferOfferMemo(offer: { meta?: Record<string, unknown> }): string {
  const values = offer.meta?.values;
  if (!values || typeof values !== "object") return "";
  const memo = (values as Record<string, unknown>)[TRANSFER_REASON_META_KEY];
  return typeof memo === "string" ? memo : "";
}

function transferOfferRequestedAtMs(offer: { requestedAt?: string }): number {
  const ms = Date.parse(offer.requestedAt ?? "");
  return Number.isFinite(ms) ? ms : 0;
}

/** Raw read of the order-bound escrow's lock for a hashLock. */
async function readOrderEvmLock(order: SwapOrder): Promise<{
  unlockTime: number;
  amount: bigint;
  tokenAddress: string;
  receiver: string;
}> {
  return readEvmLockMapping(order.hashLock, evmProofOptsForOrder(order));
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
    await waitForEvmTransactionFinality(o, o.mainLockTx);
  }
  const evm = evmProofOptsForOrder(o);
  const { unlockTime, amount, tokenAddress, receiver } = await readOrderEvmLock(o);
  assertEvmLockSafeForReveal(
    { unlockTime, amount, tokenAddress, receiver },
    {
      wbtcAmount: o.wbtcAmount,
      solverEvmAddress: o.solverEvmAddress,
      expectedWbtcAddress: evm.expectedWbtcAddress,
      expectedUserTimelock: o.userTimelock
    }
  );
}

async function waitForEvmTransactionFinality(
  order: SwapOrder,
  txHash: string
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      await assertEvmTransactionFinalized(txHash, evmProofOptsForOrder(order));
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
    const evm = evmProofOptsForOrder(o);
    const lock = await readOrderEvmLock(o);
    if (lock.amount > 0n) {
      throw new Error(
        "EVM counter is still locked — settlement or solver retake must complete before Canton refund"
      );
    }
    const fromBlockHex = o.counterLockTx
      ? await evmTxBlockHex(o.counterLockTx, evm)
      : o.createdAt
        ? await evmBlockAtOrBeforeUnixTime(o.createdAt - 10 * 60, evm.rpcUrl)
        : undefined;
    const claimed = await hasEvmClaimedForHashLock(o.hashLock, {
      ...evm,
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
    o: Omit<SwapOrder, "status" | "createdAt">,
    opts?: { createdAt?: number }
  ): Promise<SwapOrder> {
    // No-overwrite + idempotent (audit 2026-06-12) — see resolveCreateOrder.
    const existing = await this.store.get(o.id);
    const { order, isNew } = resolveCreateOrder(
      existing,
      o,
      opts?.createdAt ?? Math.floor(Date.now() / 1000)
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
  async peekOrder(id: string): Promise<SwapOrder | undefined> {
    return this.store.get(id);
  }

  /** Forward HTLC: reserve CBTC float before the user locks WBTC on EVM. */
  async prepareForwardIntent(
    incoming: Omit<SwapOrder, "status" | "createdAt">
  ): Promise<SwapOrder> {
    if (incoming.direction !== "evm-to-canton") {
      throw new Error("prepare-forward-intent is for evm-to-canton orders only");
    }
    await this.createOrder(incoming);
    let o = await this.must(incoming.id);
    if (o.mainLockTx || o.status === "main_locked") {
      throw new Error("forward HTLC order is already committed");
    }
    if (o.status === "open") {
      await this.assertForwardAcceptedDraftCap(o.userCantonParty, o.id);
      await assertHtlcSettlementQuoteFresh(o);
      await this.accept(incoming.id);
      o = await this.must(incoming.id);
    }
    if (o.status !== "accepted") {
      throw new Error(`forward CBTC pre-lock failed (${o.status})`);
    }
    return o;
  }

  private async assertForwardAcceptedDraftCap(
    party: string,
    excludeId: string
  ): Promise<void> {
    if (FORWARD_ACCEPTED_DRAFT_CAP <= 0) return;
    const orders = await this.store.byParty(party, 100);
    const active = orders.filter(
      (o) =>
        o.direction === "evm-to-canton" &&
        o.status === "accepted" &&
        !o.mainLockTx &&
        o.id !== excludeId
    ).length;
    if (active >= FORWARD_ACCEPTED_DRAFT_CAP) {
      throw new Error(
        `too many in-progress forward swaps (${active} pending CBTC reservations) — complete one or wait for it to expire`
      );
    }
  }

  private async assertReversePrelockDraftCap(
    party: string,
    excludeId: string
  ): Promise<void> {
    if (REVERSE_PRELOCK_DRAFT_CAP <= 0) return;
    const orders = await this.store.byParty(party, 100);
    const active = orders.filter(
      (o) =>
        o.direction === "canton-to-evm" &&
        o.counterMode === "loop" &&
        o.status === "main_locking" &&
        o.evmFloatReserved === true &&
        !o.counterTransferOfferCid &&
        !o.counterTransferUpdateId &&
        o.id !== excludeId
    ).length;
    if (active >= REVERSE_PRELOCK_DRAFT_CAP) {
      throw new Error(
        `too many in-progress reverse swaps (${active} pending WBTC reservations) — complete one or wait for it to expire`
      );
    }
  }

  /** Forward HTLC: bind verified WBTC lock after prepareForwardIntent. */
  async commitForwardOrder(
    incoming: Omit<SwapOrder, "status" | "createdAt">,
    mainLockTx: string
  ): Promise<SwapOrder> {
    let o = await this.peekOrder(incoming.id);
    if (o?.status === "main_locked") return o;
    if (!o || o.status === "open") {
      // Recovery / legacy path: WBTC may already be locked without a prior prepare.
      await this.createOrder(incoming);
      const fresh = await this.must(incoming.id);
      if (fresh.status === "open") {
        await this.accept(incoming.id);
      }
    } else if (o.status !== "accepted" && o.status !== "main_locking") {
      throw new Error(`order not accepted (${o.status})`);
    }
    return this.recordMainLock(incoming.id, mainLockTx);
  }

  /** Reverse Loop: reserve WBTC float and build CBTC transfer before Loop signs. */
  async prepareReverseLoopLockIntent(
    incoming: Omit<SwapOrder, "status" | "createdAt">,
    holdingCids: string[]
  ): Promise<{
    command: unknown;
    disclosedContracts: unknown[];
    synchronizerId: string;
    createdAt: number;
    expectedMemo: string;
  }> {
    if (!holdingCids?.length) throw new Error("no input holdings supplied");
    await this.createOrder(incoming);
    let o = await this.must(incoming.id);
    if (o.status === "main_locked") {
      throw new Error("reverse Loop order is already committed");
    }
    if (o.status === "open") {
      await this.accept(incoming.id);
      o = await this.must(incoming.id);
    }
    if (o.status === "accepted") {
      await this.assertReversePrelockDraftCap(o.userCantonParty, o.id);
      await assertHtlcSettlementQuoteFresh(o);
      o = await this.reserveReverseFloatBeforeMainLock(o);
    }
    if (o.status !== "main_locking" || !o.evmFloatReserved) {
      throw new Error(`WBTC pre-lock failed (${o.status})`);
    }
    const expectedMemo = reverseLoopCustodyMemo(o);
    const built = await prepareTransferCommand({
      senderParty: o.userCantonParty,
      receiverParty: o.solverCantonParty,
      amountBtc: o.cbtcAmount!,
      inputHoldingCids: holdingCids,
      memo: expectedMemo
    });
    return { ...built, createdAt: o.createdAt, expectedMemo };
  }

  /** Reverse Loop: verify Loop payment and bind custody after WBTC pre-lock. */
  async commitReverseLoopOrder(
    incoming: Omit<SwapOrder, "status" | "createdAt">,
    params: {
      createdAt: number;
      submitUpdateId: string;
      offerCidHint?: string;
    }
  ): Promise<SwapOrder> {
    const createdAt = assertValidPrepareCreatedAt(params.createdAt);
    let o = await this.must(incoming.id);
    if (o.status === "main_locked") return o;
    if (o.status !== "main_locking" || !o.evmFloatReserved) {
      throw new Error(
        "reverse Loop order is not in WBTC pre-lock state — prepare lock intent first"
      );
    }
    if (createdAt !== o.createdAt) {
      throw new Error("prepare createdAt does not match the pre-locked order");
    }
    const expectedMemo = htlcReverseLoopCustodyMemoFromTerms({
      id: incoming.id,
      createdAt: o.createdAt,
      userCantonParty: incoming.userCantonParty,
      solverCantonParty: incoming.solverCantonParty
    });
    const evidence = await verifyHtlcReverseLoopCustodySubmit(
      params.submitUpdateId,
      {
        userParty: incoming.userCantonParty,
        solverParty: incoming.solverCantonParty,
        cbtcAmount: incoming.cbtcAmount!,
        expectedMemo,
        offerCidHint: params.offerCidHint
      }
    );
    if (!evidence.offerCid && !evidence.inboundHoldingCid) {
      throw new Error("Loop CBTC custody evidence missing");
    }
    if (evidence.inboundHoldingCid && !evidence.offerCid) {
      o.counterTransferOfferCid = undefined;
      o.counterTransferUpdateId = params.submitUpdateId;
      o.status = "main_locked";
      if (!(await this.store.putIfStatus(o, "main_locking"))) {
        const fresh = await this.must(incoming.id);
        if (fresh.status === "main_locked") return fresh;
        throw new Error("could not bind direct Loop custody to pre-locked order");
      }
      return o;
    }
    const offerCid = evidence.offerCid;
    if (!offerCid) {
      throw new Error("Loop CBTC custody offer evidence missing");
    }
    o.counterTransferOfferCid = offerCid;
    if (!(await this.store.putIfStatus(o, "main_locking"))) {
      const fresh = await this.must(incoming.id);
      if (fresh.status === "main_locked") return fresh;
      if (fresh.counterTransferOfferCid) {
        o = fresh;
      } else {
        throw new Error("could not bind Loop custody offer to pre-locked order");
      }
    }
    let updateId: string;
    try {
      ({ updateId } = await acceptTransfer({
        receiverParty: o.solverCantonParty,
        offerContractId: offerCid
      }));
    } catch (e) {
      if (isInactiveTransferInstructionError(e) && evidence.inboundHoldingCid) {
        o = await this.must(incoming.id);
        o.counterTransferOfferCid = undefined;
        o.counterTransferUpdateId = params.submitUpdateId;
        o.status = "main_locked";
        if (!(await this.store.putIfStatus(o, "main_locking"))) {
          const fresh = await this.must(incoming.id);
          if (fresh.status === "main_locked") return fresh;
          throw new Error("could not recover direct Loop custody after inactive offer");
        }
        return o;
      }
      if (!isExpiredTransferInstructionError(e)) throw e;
      o.status = "failed";
      o.evmFloatReserved = false;
      o.counterTransferOfferCid = undefined;
      await this.store.putIfStatus(o, "main_locking").catch(() => {});
      throw new Error(
        "Loop CBTC transfer expired before the solver could accept it — start a new swap."
      );
    }
    o = await this.must(incoming.id);
    o.counterTransferUpdateId = updateId;
    o.status = "main_locked";
    if (!(await this.store.putIfStatus(o, "main_locking"))) {
      return this.must(incoming.id);
    }
    return o;
  }

  /** Reverse managed: create + accept + lock only when backend custody succeeds. */
  async commitReverseManagedOrder(
    incoming: Omit<SwapOrder, "status" | "createdAt">
  ): Promise<SwapOrder> {
    await this.createOrder(incoming);
    await this.accept(incoming.id);
    return this.lockMainCanton(incoming.id);
  }

  private reconcileInflight = new Map<string, Promise<SwapOrder>>();

  async getOrder(
    id: string,
    opts?: { mode?: GetOrderMode }
  ): Promise<SwapOrder | undefined> {
    const o = await this.store.get(id);
    if (!o) return undefined;
    const mode = opts?.mode ?? "full";
    const key = reconcileCacheKey(id, mode);
    const inflight = this.reconcileInflight.get(key);
    if (inflight) return inflight;
    const work = (
      mode === "light"
        ? this.reconcileOrderLight(o)
        : this.reconcileOrderIfNeeded(o)
    ).finally(() => {
      this.reconcileInflight.delete(key);
    });
    this.reconcileInflight.set(key, work);
    return work;
  }
  /** Orders the solver should act on (not terminal). Runs light reconcile only
   *  (Loop delivery proof repair) — no per-order EVM event scans, so many
   *  concurrent orders do not serialize on Base RPC during every poll tick. */
  async activeOrders(evmChainSlug?: string): Promise<SwapOrder[]> {
    const all = await this.store.active(evmChainSlug);
    const actionable = new Set([
      "main_locking",
      "main_locked",
      "counter_locking",
      "counter_locked",
      "counter_claimed"
    ]);
    const filtered = all.filter(
      (o) =>
        (o.direction === "evm-to-canton" || o.direction === "canton-to-evm") &&
        actionable.has(o.status) &&
        !o.id.startsWith("smoke-")
    );
    const reconciled: SwapOrder[] = [];
    for (const o of filtered) {
      reconciled.push(await this.reconcileOrderLight(o));
    }
    return reconciled;
  }

  /** Light repair for daemon polls — ledger update trees only, no EVM scans. */
  private async reconcileOrderLight(o: SwapOrder): Promise<SwapOrder> {
    if (
      o.status === "refunded" ||
      o.status === "cancelled" ||
      o.status === "failed" ||
      htlcVisibleCompleted(o)
    ) {
      return o;
    }
    return this.reconcileLoopForwardCounterDelivery(o);
  }

  /** Full reconcile for list/detail views (history, getOrder). */
  private async reconcileOrderIfNeeded(o: SwapOrder): Promise<SwapOrder> {
    if (
      o.status === "refunded" ||
      o.status === "cancelled" ||
      o.status === "failed" ||
      htlcVisibleCompleted(o)
    ) {
      return o;
    }
    let row = await this.reconcilePhantomEvmCounterLock(o);
    row = await this.reconcileLoopForwardCounterDelivery(row);
    row = await this.reconcileForwardEvmMainClaim(row);
    row = await this.reconcileReverseSolverClaim(row);
    row = await this.reconcileMainClaimedProof(row);
    return row;
  }

  /** When Loop delivery proof exists and the solver already claimed WBTC on EVM,
   *  repair counter_claimed → main_claimed so history/status show Completed. */
  private async reconcileForwardEvmMainClaim(
    o: SwapOrder
  ): Promise<SwapOrder> {
    if (o.direction !== "evm-to-canton" || o.status !== "counter_claimed") {
      return o;
    }
    if (o.mainClaimTx) {
      const patched = { ...o, status: "main_claimed" as const };
      if (await this.store.putIfStatus(patched, "counter_claimed")) {
        return patched;
      }
      return this.must(o.id);
    }
    const gate = htlcCanExposePreimageToSolver(o);
    if (!gate.ok) return o;
    const evm = evmProofOptsForOrder(o);
    try {
      const lock = await readEvmLockMapping(o.hashLock, evm);
      if (lock.amount > 0n) return o;
    } catch (e) {
      console.warn(
        `[htlc] forward main-claim reconcile ${o.id.slice(0, 12)} lock read failed: ${e instanceof Error ? e.message : e}`
      );
      return o;
    }
    const fromBlockHex = o.mainLockTx
      ? await evmTxBlockHex(o.mainLockTx, evm)
      : undefined;
    let claimTx: string | undefined;
    try {
      claimTx = await findEvmClaimTxForHashLock(o.hashLock, {
        ...evm,
        fromBlockHex
      });
    } catch (e) {
      console.warn(
        `[htlc] forward main-claim reconcile ${o.id.slice(0, 12)} Claimed scan failed: ${e instanceof Error ? e.message : e}`
      );
      return o;
    }
    if (!claimTx) return o;
    try {
      await verifyReverseClaimTx(claimTx, o.hashLock, evm);
    } catch {
      return o;
    }
    const patched = {
      ...o,
      status: "main_claimed" as const,
      mainClaimTx: claimTx as `0x${string}`
    };
    if (await this.store.putIfStatus(patched, "counter_claimed")) {
      return patched;
    }
    return this.must(o.id);
  }

  /** Reverse counter_claimed: user already claimed WBTC — finish Canton settlement. */
  private async reconcileReverseSolverClaim(o: SwapOrder): Promise<SwapOrder> {
    if (o.direction !== "canton-to-evm" || o.status !== "counter_claimed") {
      return o;
    }
    if (!htlcUserWbtcClaimTx(o) || !o.revealedPreimage) return o;
    try {
      const { order } = await this.claimMainAsSolver(o.id);
      return order;
    } catch (e) {
      console.warn(
        `[htlc] reverse solver claim reconcile ${o.id.slice(0, 12)} failed: ${e instanceof Error ? e.message : e}`
      );
      return o;
    }
  }

  /** Repair main_claimed rows that advanced without persisting required proof fields. */
  private async reconcileMainClaimedProof(o: SwapOrder): Promise<SwapOrder> {
    if (o.status !== "main_claimed" || htlcVisibleCompleted(o)) return o;

    if (
      o.direction === "evm-to-canton" &&
      o.counterMode === "loop" &&
      !htlcForwardLoopDeliveryProven(o)
    ) {
      o = await this.reconcileLoopForwardCounterDelivery(o);
      if (htlcVisibleCompleted(o)) return o;
    }

    const needsForwardClaimTx =
      o.direction === "evm-to-canton" && !o.mainClaimTx;
    const needsReverseUserClaimTx =
      o.direction === "canton-to-evm" && !htlcUserWbtcClaimTx(o);
    if (!needsForwardClaimTx && !needsReverseUserClaimTx) return o;

    const anchorTx =
      o.direction === "evm-to-canton" ? o.mainLockTx : o.counterLockTx;
    const evm = evmProofOptsForOrder(o);
    let fromBlockHex: string | undefined;
    if (anchorTx) {
      try {
        fromBlockHex = await evmTxBlockHex(anchorTx, evm);
      } catch {
        /* scan from genesis */
      }
    }
    let claimTx: string | undefined;
    try {
      claimTx = await findEvmClaimTxForHashLock(o.hashLock, {
        ...evm,
        fromBlockHex
      });
    } catch (e) {
      console.warn(
        `[htlc] main_claimed proof reconcile ${o.id.slice(0, 12)} Claimed scan failed: ${e instanceof Error ? e.message : e}`
      );
      return o;
    }
    if (!claimTx) return o;
    try {
      await verifyReverseClaimTx(claimTx, o.hashLock, evm);
    } catch {
      return o;
    }

    const patched = { ...o, mainClaimTx: claimTx as `0x${string}` };
    if (await this.store.putIfStatus(patched, "main_claimed")) {
      return patched;
    }
    return this.must(o.id);
  }

  /** Repair stale Loop forward rows where delivery update proves direct/preapproved
   *  settlement but a transient offer CID blocked counterClaimUpdateId persistence. */
  private async reconcileLoopForwardCounterDelivery(
    o: SwapOrder
  ): Promise<SwapOrder> {
    if (
      o.direction !== "evm-to-canton" ||
      o.counterMode !== "loop" ||
      !o.counterTransferUpdateId ||
      o.counterClaimUpdateId
    ) {
      return o;
    }
    if (o.status !== "counter_claimed" && o.status !== "main_claimed") {
      return o;
    }
    const expectedMemo = htlcLoopCounterDeliveryMemo(o);
    const proof = await this.recoverLoopCounterDeliveryEvidence({
      order: o,
      updateId: o.counterTransferUpdateId,
      expectedMemo
    });
    if (proof?.delivered) {
      try {
        return await this.persistLoopCounterDeliveryEvidence({
          id: o.id,
          updateId: o.counterTransferUpdateId,
          directDeliveryProven: true
        });
      } catch (e) {
        console.warn(
          `[htlc] loop forward delivery repair ${o.id.slice(0, 12)} failed: ${e instanceof Error ? e.message : e}`
        );
        return o;
      }
    }

    let offerCid = o.counterTransferOfferCid ?? proof?.offerCid;
    if (!offerCid) {
      offerCid =
        (await findOfferFromSender(
          o.solverCantonParty,
          o.userCantonParty,
          expectedMemo,
          {
            amountBtc: o.cbtcAmount!,
            amountDecimals: 8,
            instrumentId: NETWORK.instrumentId
          }
        )) ?? undefined;
    }
    if (!offerCid) return o;

    if (!o.counterTransferOfferCid) {
      const withOffer = { ...o, counterTransferOfferCid: offerCid };
      if (await this.store.putIfStatus(withOffer, o.status)) {
        o = withOffer;
      } else {
        o = await this.must(o.id);
      }
    }

    let userPending: Awaited<ReturnType<typeof listPendingOffers>> = [];
    try {
      userPending = await listPendingOffers(o.userCantonParty);
    } catch (e) {
      console.warn(
        `[htlc] loop forward accept repair ${o.id.slice(0, 12)} pending-offer ACS skipped: ${e instanceof Error ? e.message : e}`
      );
    }
    if (userPending.some((p) => p.contractId === offerCid)) {
      return o;
    }

    try {
      const acceptTree = await fetchTransactionTreeForOfferAccept(
        offerCid,
        o.userCantonParty,
        counterOfferConsumedInEvents
      );
      if (!acceptTree?.updateId) return o;
      const patched = {
        ...o,
        counterTransferOfferCid: offerCid,
        counterClaimUpdateId: acceptTree.updateId
      };
      if (await this.store.putIfStatus(patched, o.status)) return patched;
      return this.must(o.id);
    } catch (e) {
      console.warn(
        `[htlc] loop forward accept repair ${o.id.slice(0, 12)} failed: ${e instanceof Error ? e.message : e}`
      );
      return o;
    }
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
    if (!o.wbtcAmount || !o.userEvmAddress || o.solverTimelock == null) {
      return o;
    }
    const evm = evmProofOptsForOrder(o);

    // C-02: a zero lock amount means the user Claimed OR the solver Retook. We may
    // ONLY advance to counter_claimed on a confirmed Claim, and we must NEVER roll
    // back to main_locked unless we have CONCLUSIVE evidence the lock is gone AND was
    // not claimed — otherwise a swallowed RPC/scan error after a real claim would
    // roll back, the daemon would re-lock the hash, and the solver double-funds.
    // Any error reading the lock / scanning for Claimed is FAIL-CLOSED: keep the
    // order in counter_locked (no rollback) and retry on the next poll.
    let lockAmount: bigint;
    try {
      lockAmount = (await readEvmLockMapping(o.hashLock, evm)).amount;
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
          ? await evmTxBlockHex(o.counterLockTx, evm)
          : undefined;
        claimed = await hasEvmClaimedForHashLock(o.hashLock, {
          ...evm,
          fromBlockHex
        });
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

      if (o.counterLockTx) {
        try {
          await verifyReverseCounterLockTx(
            o.counterLockTx,
            {
              hashLock: o.hashLock,
              wbtcAmount: o.wbtcAmount,
              userEvmAddress: o.userEvmAddress,
              solverTimelock: o.solverTimelock,
              expectedWbtcAddress: evm.expectedWbtcAddress
            },
            { ...evm, requireFinality: false }
          );
          const fromBlockHex = await evmTxBlockHex(o.counterLockTx, evm);
          const retakeTx = await findEvmRetakeTxForHashLock(o.hashLock, {
            ...evm,
            fromBlockHex
          });
          if (retakeTx) {
            o.mainClaimTx = retakeTx;
          }
          console.warn(
            `[htlc] reverse counter lock ${o.id.slice(0, 12)} was cleared without Claim after a valid lock tx — keeping counter_locked for refund/recovery`
          );
          o.evmFloatReserved = false;
          if (await this.store.putIfStatus(o, "counter_locked")) return o;
          return this.must(o.id);
        } catch {
          // The recorded tx does not prove a valid lock. Treat this as never
          // landed and allow the daemon to re-lock below.
        }
      }

      // Lock gone, conclusively NOT claimed → solver retook (or lock never landed).
      // Only no/invalid lock evidence is safe to roll back to main_locked so
      // the swap can re-lock. A valid landed lock that later disappeared stays
      // counter_locked above so refund/recovery cannot double-fund.
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
    }, evm);
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
  /** Order history for one user party (newest first). Reconciles in-flight rows so
   *  list views match getOrder() proof repair (Loop delivery + EVM main claim). */
  async historyForParty(party: string): Promise<SwapOrder[]> {
    const orders = await this.store.byParty(party);
    return Promise.all(orders.map((o) => this.reconcileOrderIfNeeded(o)));
  }

  async accept(id: string) {
    const o = await this.must(id);
    if (o.status === "accepted") return this.must(id);
    if (o.status !== "open") throw new Error(`order not open (${o.status})`);
    // SOLVENCY GATE (M1): refuse BEFORE the user locks anything if the solver can't
    // fill its leg. Forward (evm→canton): the solver must have the CBTC float.
    // Reverse (canton→evm): WBTC is reserved atomically before the user's Canton
    // lock/custody transfer begins, because EVM balance alone is not a reservation.
    if (o.direction === "evm-to-canton") {
      // M-2: re-read spendable float immediately before each reservation attempt.
      let reservation: Awaited<
        ReturnType<typeof this.store.acceptWithFloatReservation>
      > = {
        accepted: false,
        reservedSats: 0n,
        needSats: 0n
      };
      let floatSats = 0n;
      for (let attempt = 0; attempt < 3; attempt++) {
        const holdings = await getHoldings(o.solverCantonParty);
        floatSats = holdings.reduce(
          (s, h) =>
            s + toBaseUnitsFloor(h.payload.amount ?? "0", 8),
          0n
        );
        reservation = await this.store.acceptWithFloatReservation(
          o.id,
          o.solverCantonParty,
          floatSats
        );
        if (
          reservation.accepted ||
          reservation.reason !== "insufficient_float" ||
          attempt === 2
        ) {
          break;
        }
      }
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

  /** Release a reverse pre-lock reservation when Loop signing failed or custody
   *  never landed. Only valid while main_locking with no custody evidence linked. */
  async releaseReversePrelockWithoutCustody(id: string): Promise<SwapOrder> {
    const o = await this.must(id);
    if (o.status !== "main_locking") return o;
    if (
      o.counterTransferOfferCid ||
      o.counterTransferUpdateId ||
      o.allocationCid ||
      o.htlcCid
    ) {
      throw new Error(
        "cannot release pre-lock — custody or lock evidence is already linked"
      );
    }
    const expectedMemo = reverseLoopCustodyMemo(o);
    const pending = await listPendingOffers(o.solverCantonParty);
    const liveOffer = pending.find(
      (x) =>
        x.sender === o.userCantonParty &&
        x.receiver === o.solverCantonParty &&
        cbtcAmountsMatch(x.amountBtc, o.cbtcAmount!) &&
        transferOfferMemo(x) === expectedMemo
    );
    if (liveOffer) {
      throw new Error(
        "cannot release pre-lock — on-ledger custody transfer offer is still pending"
      );
    }
    o.status = "failed";
    o.evmFloatReserved = false;
    if (!(await this.store.putIfStatus(o, "main_locking"))) {
      return this.must(id);
    }
    return o;
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
      await waitForEvmTransactionFinality(o, mainLockTx);
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
        if (reservation.reason === "unbound_chain") {
          throw new Error(
            "order missing EVM chain binding; backfill legacy order before reserving WBTC float"
          );
        }
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
    const evm = evmProofOptsForOrder(order);
    const wbtc = evm.expectedWbtcAddress;
    const solver = order.solverEvmAddress?.trim();
    if (!wbtc || !solver) {
      throw new Error("canonical solver WBTC inventory is not configured");
    }
    const balance = await readErc20Balance(wbtc, solver, evm.rpcUrl);
    const reservation =
      await this.store.reserveReverseEvmFloatBeforeMainLock(order.id, balance);
    if (!reservation.reserved) {
      if (reservation.reason === "unbound_chain") {
        throw new Error(
          "order missing EVM chain binding; backfill legacy order before reserving WBTC float"
        );
      }
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

    const settlementId = `htlc-fwd-${o.id.slice(0, 18)}`;
    const allocationCommandId = `htlc-lock-counter-alloc-${o.id}`;
    let allocationCid: string;
    try {
      ({ allocationCid } = await allocate({
        solverParty: o.solverCantonParty,
        receiverParty: o.userCantonParty,
        amountBtc: o.cbtcAmount!,
        inputHoldings: holdings,
        inputHoldingCids,
        settlementId,
        settleBefore,
        allocateBefore,
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
        o.solverCantonParty,
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
          senderParty: o.solverCantonParty,
          receiverParty: o.userCantonParty,
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

  /** LOOP REVEAL + DELIVER — trust-minimized Loop path.
   *
   *  Loop cannot exercise our custom HTLC DAR, so the user reveals to our backend
   *  and receives CBTC through standard TransferFactory transfers. The critical
   *  invariant is that the daemon must not claim WBTC until the CBTC delivery is
   *  proven:
   *    - direct/preapproved delivery: delivery update creates the user's holding;
   *    - pending offer: the exact offer is later consumed by the user's Loop accept.
   *
   *  IDEMPOTENT on retry: preimage step keys on status; delivery keys on
   *  counterTransferUpdateId (persisted the instant createTransfer returns).
   */
  private async recoverLoopCounterDeliveryEvidence(params: {
    order: SwapOrder;
    updateId: string;
    expectedMemo: string;
  }): Promise<{ delivered: boolean; offerCid?: string } | null> {
    const eventsById = await fetchUpdateEventsById(params.updateId, [
      params.order.solverCantonParty,
      params.order.userCantonParty
    ]);
    if (!eventsById) return null;
    return recoverHtlcCounterDeliveryFromEvents(eventsById, {
      senderParty: params.order.solverCantonParty,
      receiverParty: params.order.userCantonParty,
      amountBtc: params.order.cbtcAmount ?? "",
      expectedInstrument: NETWORK.instrumentId,
      expectedMemo: params.expectedMemo
    });
  }

  private loopCounterDeliveryMatch(order: SwapOrder, expectedMemo: string) {
    return {
      senderParty: order.solverCantonParty,
      receiverParty: order.userCantonParty,
      amountBtc: order.cbtcAmount ?? "",
      expectedInstrument: NETWORK.instrumentId,
      expectedMemo
    };
  }

  /** Parse or poll until the solver delivery update proves offer vs direct delivery. */
  private async waitForLoopCounterDeliveryEvidence(params: {
    order: SwapOrder;
    updateId: string;
    expectedMemo: string;
    eventsById?: Record<string, unknown>;
    maxAttempts?: number;
    pollMs?: number;
  }): Promise<{ delivered: boolean; offerCid?: string } | null> {
    const match = this.loopCounterDeliveryMatch(params.order, params.expectedMemo);
    if (params.eventsById) {
      const immediate = recoverHtlcCounterDeliveryFromEvents(
        params.eventsById,
        match
      );
      if (immediate) return immediate;
    }
    const maxAttempts = params.maxAttempts ?? 15;
    const pollMs = params.pollMs ?? 2000;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const recovered = await this.recoverLoopCounterDeliveryEvidence({
        order: params.order,
        updateId: params.updateId,
        expectedMemo: params.expectedMemo
      });
      if (recovered) return recovered;
      if (attempt < maxAttempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    }
    return null;
  }

  private async persistLoopCounterDeliveryUpdateOnly(params: {
    id: string;
    updateId: string;
    offerContractId?: string;
  }): Promise<SwapOrder> {
    return this.persistLoopCounterDeliveryEvidence({
      id: params.id,
      updateId: params.updateId,
      offerContractId: params.offerContractId,
      directDeliveryProven: false
    });
  }

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
    // counter_claimed/main_claimed are retry states. They are valid only because
    // preimage exposure to the solver is separately proof-gated by
    // htlcCanExposePreimageToSolver; a pending Loop offer must still be accepted
    // before the daemon can claim WBTC.
    if (
      o.status !== "main_locked" &&
      o.status !== "counter_claimed" &&
      o.status !== "main_claimed"
    ) {
      throw new Error(`unexpected status ${o.status}`);
    }
    if (!preimageMatches(preimageHex, o.hashLock))
      throw new Error("invalid preimage");

    // 1. Store the reveal as durable user intent, but do NOT let the daemon use it
    // until the standard Loop delivery obligation is proven. /preimage and /active
    // both gate forward Loop preimage exposure on counterTransferUpdateId +
    // counterClaimUpdateId.
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
      const counterDeliveryMemo = htlcLoopCounterDeliveryMemo(o);
      let updateId: string;
      let offerContractId: string | undefined;
      let transferKind: string | undefined;
      let deliveryEventsById: Record<string, unknown> | undefined;
      try {
        ({
          updateId,
          offerContractId,
          transferKind,
          eventsById: deliveryEventsById
        } = await createTransfer({
          senderParty: o.solverCantonParty,
          receiverParty: o.userCantonParty, // the Loop party (cross-participant)
          amountBtc: o.cbtcAmount!,
          inputHoldings: holdings,
          commandId,
          memo: counterDeliveryMemo
        }));
      } catch (e) {
        // F7: a retry after a committed-but-unpersisted transfer. The deterministic
        // commandId means the ledger already committed this exact transfer and now
        // rejects the re-submit as a duplicate — so the user WAS delivered, we just
        // crashed before persisting. Recover WITHOUT re-sending.
        if (e instanceof Error && e.message.includes("duplicate command committed")) {
          const fresh = await this.must(id);
          const memo = htlcLoopCounterDeliveryMemo(fresh);
          if (fresh.counterTransferUpdateId) {
            const recoveredFresh = await this.waitForLoopCounterDeliveryEvidence({
              order: fresh,
              updateId: fresh.counterTransferUpdateId,
              expectedMemo: memo
            });
            if (!recoveredFresh) {
              o = await this.persistLoopCounterDeliveryUpdateOnly({
                id,
                updateId: fresh.counterTransferUpdateId,
                offerContractId: fresh.counterTransferOfferCid
              });
              return {
                order: o,
                updateId: fresh.counterTransferUpdateId,
                delivered: false
              };
            }
            const persisted = await this.persistLoopCounterDeliveryEvidence({
              id,
              updateId: fresh.counterTransferUpdateId,
              offerContractId: recoveredFresh.delivered
                ? undefined
                : recoveredFresh.offerCid,
              directDeliveryProven: recoveredFresh.delivered
            });
            return {
              order: persisted,
              updateId: fresh.counterTransferUpdateId,
              delivered: recoveredFresh.delivered
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
          const recovered = await this.waitForLoopCounterDeliveryEvidence({
            order: o,
            updateId: committed.updateId,
            expectedMemo: memo,
            eventsById: committed.eventsById
          });
          if (!recovered) {
            o = await this.persistLoopCounterDeliveryUpdateOnly({
              id,
              updateId: committed.updateId
            });
            return {
              order: o,
              updateId: committed.updateId,
              delivered: false
            };
          }
          const persisted = await this.persistLoopCounterDeliveryEvidence({
            id,
            updateId: committed.updateId,
            offerContractId: recovered.delivered
              ? undefined
              : recovered.offerCid,
            directDeliveryProven: recovered.delivered
          });
          return {
            order: persisted,
            updateId: committed.updateId,
            delivered: recovered.delivered
          };
        }
        throw e;
      }
      const recovered = await this.waitForLoopCounterDeliveryEvidence({
        order: o,
        updateId,
        expectedMemo: counterDeliveryMemo,
        eventsById: deliveryEventsById
      });
      if (!recovered) {
        o = await this.persistLoopCounterDeliveryUpdateOnly({
          id,
          updateId,
          offerContractId: offerContractId || undefined
        });
        console.warn(
          `[htlc] loop deliver ${id}: update committed, proof pending propagation (${updateId.slice(0, 20)}...)`
        );
        return { order: o, updateId, delivered: false };
      }
      delivered = recovered.delivered;
      offerContractId = recovered.delivered ? undefined : recovered.offerCid;
      o = await this.persistLoopCounterDeliveryEvidence({
        id,
        updateId,
        offerContractId,
        directDeliveryProven: delivered
      });
      console.log(
        `[htlc] loop deliver ${id}: kind=${transferKind} delivered=${delivered}`
      );
    } else if (!o.counterClaimUpdateId) {
      o = await this.reconcileLoopForwardCounterDelivery(o);
      if (o.counterClaimUpdateId) {
        delivered = true;
      } else if (!o.counterTransferOfferCid) {
        // RETRY path with no recorded offer: never treat "no pending offer found" as
        // proof of delivery. A missing offer can also mean propagation lag, an expired
        // transfer instruction, or an offer cid we failed to persist. Only mark direct
        // delivery when the original update tree proves a receiver holding was created.
        const pending = await findOfferFromSender(
          o.solverCantonParty,
          o.userCantonParty,
          htlcLoopCounterDeliveryMemo(o),
          {
            amountBtc: o.cbtcAmount!,
            amountDecimals: 8,
            instrumentId: NETWORK.instrumentId
          }
        );
        if (pending) {
          o.counterTransferOfferCid = pending;
          if (!(await this.store.putIfStatus(o, o.status))) {
            throw new Error("counter offer recovery lost lifecycle race");
          }
        } else {
          const recovered = await this.waitForLoopCounterDeliveryEvidence({
            order: o,
            updateId: o.counterTransferUpdateId!,
            expectedMemo: htlcLoopCounterDeliveryMemo(o),
            maxAttempts: 8,
            pollMs: 1500
          });
          if (!recovered) {
            delivered = false;
          } else if (recovered.delivered) {
            o = await this.persistLoopCounterDeliveryEvidence({
              id,
              updateId: o.counterTransferUpdateId!,
              directDeliveryProven: true
            });
            delivered = true;
          } else if (recovered.offerCid) {
            o = await this.persistLoopCounterDeliveryEvidence({
              id,
              updateId: o.counterTransferUpdateId!,
              offerContractId: recovered.offerCid
            });
            delivered = false;
          }
        }
      }
    }
    return { order: o, updateId: o.counterTransferUpdateId ?? "", delivered };
  }

  private async persistLoopCounterDeliveryEvidence(params: {
    id: string;
    updateId: string;
    offerContractId?: string;
    directDeliveryProven?: boolean;
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
      if (params.directDeliveryProven) {
        fresh.counterClaimUpdateId =
          fresh.counterClaimUpdateId ?? params.updateId;
        fresh.counterTransferOfferCid = undefined;
      } else if (params.offerContractId) {
        fresh.counterTransferOfferCid =
          fresh.counterTransferOfferCid ?? params.offerContractId;
      }
      const expectedStatus = fresh.status;
      if (await this.store.putIfStatus(fresh, expectedStatus)) return fresh;
    }

    const final = await this.must(params.id);
    if (final.counterTransferUpdateId === params.updateId) return final;
    throw new Error("counter delivery evidence persistence lost lifecycle race");
  }

  /** PREPARE the standard TransferInstruction_Accept command for the Loop user to
   *  sign in their own wallet. Standard Splice choice (no custom DAR) → runs on
   *  Loop's node. Only available after the reveal path has created a pending
   *  order-bound transfer offer. */
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
    // counter_claimed means the reveal path has created or recovered the standard
    // delivery obligation. If direct/preapproved delivery already happened, there
    // is no accept command to prepare.
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
    // first find it from the SENDER's ACS (the solver sees the offers it created,
    // even when the receiver is cross-participant). If that is not visible, recover
    // from the original delivery update tree. Do not infer delivery from a missing
    // offer; only the update tree can prove preapproval/direct delivery.
    if (!o.counterTransferOfferCid) {
      let recovered = await findOfferFromSender(
        o.solverCantonParty,
        o.userCantonParty,
        htlcLoopCounterDeliveryMemo(o),
        {
          amountBtc: o.cbtcAmount!,
          amountDecimals: 8,
          instrumentId: NETWORK.instrumentId
        }
      );
      if (!recovered) {
        const proof = await this.recoverLoopCounterDeliveryEvidence({
          order: o,
          updateId: o.counterTransferUpdateId,
          expectedMemo: htlcLoopCounterDeliveryMemo(o)
        });
        if (proof?.delivered) {
          await this.persistLoopCounterDeliveryEvidence({
            id,
            updateId: o.counterTransferUpdateId,
            directDeliveryProven: true
          });
          throw new Error(
            "CBTC was already delivered by Transfer Preapproval — no Loop accept is needed."
          );
        }
        recovered = proof?.offerCid ?? null;
      }
      if (!recovered) {
        throw new Error(
          "CBTC transfer offer is not proven on-ledger yet — retry shortly."
        );
      }
      o.counterTransferOfferCid = recovered;
      if (!(await this.store.putIfStatus(o, o.status))) {
        throw new Error("counter offer recovery lost lifecycle race");
      }
    }
    if (o.counterTransferOfferCid) {
      const pending = await listPendingOffers(o.userCantonParty);
      const stillOpen = pending.some(
        (p) => p.contractId === o.counterTransferOfferCid
      );
      if (!stillOpen) {
        const repaired = await this.reconcileLoopForwardCounterDelivery(o);
        if (repaired.counterClaimUpdateId) {
          throw new Error(
            "CBTC was already delivered by Transfer Preapproval — no Loop accept is needed."
          );
        }
        throw new Error(
          "This CBTC transfer offer is no longer pending. Refresh this page — WarpX will reconcile your accept proof."
        );
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
    if (o.direction === "evm-to-canton" && o.status === "counter_locked") {
      await verifyEvmLock(o);
    }

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
    const evm = evmProofOptsForOrder(o);
    try {
      await verifyReverseCounterLockTx(
        counterLockTx,
        {
          hashLock: o.hashLock,
          wbtcAmount: o.wbtcAmount,
          userEvmAddress: o.userEvmAddress,
          solverTimelock: o.solverTimelock,
          expectedWbtcAddress: evm.expectedWbtcAddress
        },
        evm
      );
    } catch (e) {
      if (!isAwaitingEvmFinality(e)) throw e;

      // The tx is mined, successful, and structurally matches this order, but
      // it has not reached the configured confirmation depth yet. Persist the
      // tx while keeping the order in counter_locking so daemon restarts retry
      // finality instead of sending another WBTC lock.
      await verifyReverseCounterLockTx(
        counterLockTx,
        {
          hashLock: o.hashLock,
          wbtcAmount: o.wbtcAmount,
          userEvmAddress: o.userEvmAddress,
          solverTimelock: o.solverTimelock,
          expectedWbtcAddress: evm.expectedWbtcAddress
        },
        { ...evm, requireFinality: false }
      );
      o.counterLockTx = counterLockTx;
      o.status = "counter_locking";
      if (!(await this.store.putIfStatus(o, expectedStatus))) {
        return this.must(id);
      }
      return o;
    }
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

    const evm = evmProofOptsForOrder(o);
    const fromBlockHex = o.counterLockTx
      ? await evmTxBlockHex(o.counterLockTx, evm)
      : undefined;
    const claimTx = await findEvmClaimTxForHashLock(o.hashLock, {
      ...evm,
      fromBlockHex
    });
    if (!claimTx) {
      throw new Error(
        "EVM WBTC claim proof missing — refusing to claim user CBTC"
      );
    }
    if (
      o.mainClaimTx &&
      o.mainClaimTx.toLowerCase() !== claimTx.toLowerCase()
    ) {
      throw new Error("EVM claim proof mismatch");
    }
    o.mainClaimTx = claimTx;

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
      inputHoldingCids: holdingCids,
      memo: reverseLoopCustodyMemo(o)
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

    if (o.counterTransferOfferCid && !o.counterTransferUpdateId) {
      const pendingBound = await listPendingOffers(o.solverCantonParty);
      if (
        !pendingBound.some((p) => p.contractId === o.counterTransferOfferCid)
      ) {
        const acceptTree = await fetchTransactionTreeForOfferAccept(
          o.counterTransferOfferCid,
          o.solverCantonParty,
          counterOfferConsumedInEvents
        );
        if (acceptTree?.updateId) {
          o.counterTransferUpdateId = acceptTree.updateId;
          o.status = "main_locked";
          if (await this.store.putIfStatus(o, "main_locking")) return o;
          return this.must(id);
        }
      }
    }

    const expectedMemo = reverseLoopCustodyMemo(o);
    let usedCustodyCids = await this.store.usedCounterTransferOfferCids();
    if (o.counterTransferOfferCid) {
      usedCustodyCids.delete(o.counterTransferOfferCid);
    }
    const maxAttempts = opts?.maxAttempts ?? 15;
    const pollMs = opts?.pollMs ?? 2000;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const offers = await listPendingOffers(o.solverCantonParty);
      const baseMatchingOffers = offers.filter(
        (x) =>
          x.sender === o.userCantonParty &&
          x.receiver === o.solverCantonParty &&
          cbtcAmountsMatch(x.amountBtc, o.cbtcAmount!) &&
          !!x.instrumentId &&
          matchesInstrument(x.instrumentId, NETWORK.instrumentId) &&
          !usedCustodyCids.has(x.contractId)
      );
      const memoMatchingOffers = baseMatchingOffers.filter(
        (x) => transferOfferMemo(x) === expectedMemo
      );
      if (memoMatchingOffers.length > 1) {
        throw new Error(
          "ambiguous Loop custody transfer — multiple offers carry this order memo"
        );
      }
      const offer = memoMatchingOffers[0];
      if (offer) {
        let updateId: string;
        try {
          ({ updateId } = await acceptTransfer({
            receiverParty: o.solverCantonParty,
            offerContractId: offer.contractId
          }));
        } catch (e) {
          if (!isExpiredTransferInstructionError(e)) throw e;
          const failed: SwapOrder = {
            ...o,
            status: "failed",
            evmFloatReserved: false
          };
          await this.store.putIfStatus(failed, "main_locking").catch(() => {});
          throw new Error(
            "Loop CBTC transfer expired before the solver could accept it — start a new swap."
          );
        }
        o.counterTransferOfferCid = offer.contractId;
        o.counterTransferUpdateId = updateId;
        o.status = "main_locked";
        try {
          if (!(await this.store.putIfStatus(o, "main_locking"))) {
            return this.must(id);
          }
          return o;
        } catch (e) {
          if (!isCustodyEvidenceConflictError(e)) throw e;
          usedCustodyCids.add(offer.contractId);
          o = await this.must(id);
          if (o.status !== "main_locking") return o;
          continue;
        }
      }

      if (attempt < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, pollMs));
      }
    }

    throw new Error(
      "Loop custody transfer is not visible on-ledger yet — confirmation will retry automatically."
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
    // `failed` with mainClaimTx is accepted after solver retake (recordCounterRetake).
    if (!isRefundMainCantonStatusEligible(o)) {
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
        const commandId = `htlc-refund-main-${id}`;
        const existingRefund = await fetchTransactionTreeByCommandId(
          commandId,
          o.solverCantonParty,
          50_000
        );
        if (existingRefund) {
          updateId = existingRefund.updateId;
        } else {
          const holdings = await getHoldings(o.solverCantonParty);
          ({ updateId } = await createTransfer({
            senderParty: o.solverCantonParty,
            receiverParty: o.userCantonParty,
            amountBtc: o.cbtcAmount!,
            inputHoldings: holdings,
            commandId
          }));
        }
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
    const claimRef = updateId.trim();
    // GUARD: a forward MANAGED order must settle via claimCounterAsBackend (which
    // ACTUALLY claims the CBTC on-ledger), NOT this record-only endpoint — else a
    // client could mark it counter_claimed without the CBTC moving, then the daemon
    // pays out the WBTC. Only Loop-buyer (forward) and reverse orders use this path.
    if (o.direction === "evm-to-canton" && o.counterMode === "managed") {
      throw new Error(
        "forward managed orders settle via claim-managed, not claim-record"
      );
    }
    if (!preimageMatches(preimageHex, o.hashLock))
      throw new Error("invalid preimage");
    // Reverse: the solver watchtower may call claim-main as soon as the EVM Claim
    // event is visible — often before the browser's recordClaim arrives. Treat that
    // as success, not "unexpected status main_claimed".
    if (o.direction === "canton-to-evm" && o.status === "main_claimed") {
      if (isEvmTxHash(claimRef)) {
        if (
          o.mainClaimTx &&
          o.mainClaimTx.toLowerCase() !== claimRef.toLowerCase()
        ) {
          throw new Error("claim tx mismatch");
        }
        if (!o.mainClaimTx) {
          await verifyReverseClaimTx(claimRef, o.hashLock, evmProofOptsForOrder(o));
          const patched = { ...o, mainClaimTx: claimRef as `0x${string}` };
          if (await this.store.putIfStatus(patched, "main_claimed")) {
            return patched;
          }
        }
      }
      return o;
    }
    if (
      o.direction === "canton-to-evm" &&
      o.status === "counter_claimed" &&
      isEvmTxHash(claimRef) &&
      o.mainClaimTx?.toLowerCase() === claimRef.toLowerCase()
    ) {
      return o;
    }
    if (o.status !== "counter_locked" && o.status !== "counter_claimed") {
      throw new Error(`unexpected status ${o.status}`);
    }
    // DEFENSE-IN-DEPTH (solver-robbery guard): for ANY forward order, re-verify the
    // EVM WBTC lock has enough margin BEFORE we record the reveal — same guard as
    // claimCounter/claimCounterAsBackend. Today no forward order reaches this path
    // without that check already having run (forward managed is rejected above;
    // forward Loop reveals via claimCounter), so this is belt-and-suspenders: if a
    // future change ever routes a forward order here, a late reveal still cannot rob
    // the solver.
    if (o.direction === "evm-to-canton") await verifyEvmLock(o);
    if (o.status === "counter_claimed") {
      // Forward Loop has two sub-cases:
      // - preapproval/direct delivery: no offer exists, so there is no Loop accept tx.
      // - pending offer: the user must accept the exact TransferInstruction in Loop.
      //   Without this gate the daemon can claim WBTC and mark the order complete
      //   while the user's CBTC is still only a pending offer.
      if (o.direction === "evm-to-canton" && o.counterMode === "loop") {
        if (o.counterClaimUpdateId) return o;
        if (!o.counterTransferUpdateId) {
          throw new Error(
            "Loop counter delivery update missing — cannot prove CBTC delivery"
          );
        }
        if (o.counterTransferOfferCid) {
          const deliveryProof = await this.recoverLoopCounterDeliveryEvidence({
            order: o,
            updateId: o.counterTransferUpdateId,
            expectedMemo: htlcLoopCounterDeliveryMemo(o)
          });
          if (deliveryProof?.delivered) {
            o.counterClaimUpdateId = o.counterTransferUpdateId;
            o.counterTransferOfferCid = undefined;
          } else {
            const parties = [o.userCantonParty, o.solverCantonParty];
            let eventsById = await fetchUpdateEventsById(claimRef, parties);
            let consumed =
              !!eventsById &&
              counterOfferConsumedInEvents(
                eventsById,
                o.counterTransferOfferCid
              );
            for (let attempt = 0; !consumed && attempt < 15; attempt++) {
              if (attempt > 0) {
                await new Promise((resolve) => setTimeout(resolve, 2000));
              }
              eventsById = await fetchUpdateEventsById(claimRef, parties);
              consumed =
                !!eventsById &&
                counterOfferConsumedInEvents(
                  eventsById,
                  o.counterTransferOfferCid
                );
            }
            if (!consumed) {
              throw new Error(
                "Loop accept update is not visible on Canton yet — keep this page open and WarpX will retry shortly."
              );
            }
            o.counterClaimUpdateId = claimRef;
          }
        } else {
          const proof = await this.recoverLoopCounterDeliveryEvidence({
            order: o,
            updateId: o.counterTransferUpdateId,
            expectedMemo: htlcLoopCounterDeliveryMemo(o)
          });
          if (!proof?.delivered) {
            throw new Error(
              "Loop direct-delivery update does not prove CBTC was delivered"
            );
          }
          o.counterClaimUpdateId = o.counterTransferUpdateId;
        }
        if (!(await this.store.putIfStatus(o, "counter_claimed"))) {
          return this.must(id);
        }
      }
      return o;
    }
    if (o.direction === "canton-to-evm") {
      const evm = evmProofOptsForOrder(o);
      const fromBlockHex = o.counterLockTx
        ? await evmTxBlockHex(o.counterLockTx, evm)
        : undefined;
      const claimed = await hasEvmClaimedForHashLock(o.hashLock, {
        ...evm,
        fromBlockHex
      });
      if (!claimed) {
        throw new Error(
          "EVM WBTC not claimed on-chain — refusing to record preimage"
        );
      }
      if (isEvmTxHash(claimRef)) {
        await verifyReverseClaimTx(claimRef, o.hashLock, evm);
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
    const canComplete = htlcCanExposePreimageToSolver(o);
    if (!canComplete.ok) {
      throw new Error(canComplete.reason);
    }
    await verifyReverseClaimTx(mainClaimTx, o.hashLock, evmProofOptsForOrder(o));
    o.status = "main_claimed";
    o.mainClaimTx = mainClaimTx;
    if (!(await this.store.putIfStatus(o, "counter_claimed"))) {
      return this.must(id);
    }
    return o;
  }
  async getRevealedPreimage(id: string) {
    const order = await this.must(id);
    const gate = htlcCanExposePreimageToSolver(order);
    if (!gate.ok) throw new Error(gate.reason);
    return order.revealedPreimage;
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
    if (o.revealedPreimage)
      throw new Error("preimage revealed — swap must settle, not refund");
    await assertEvmCounterNotClaimed(o);
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
      const existingRefund = await fetchTransactionTreeByCommandId(
        commandId,
        o.solverCantonParty,
        50_000
      );
      if (existingRefund) {
        updateId = existingRefund.updateId;
      } else {
        ({ updateId } = await refundHtlcLock({
          solverParty: o.solverCantonParty,
          htlcCid,
          allocationCid,
          commandId
        }));
      }
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

  /** Record that the solver retook WBTC on a reverse order after the user never claimed. */
  async recordCounterRetake(id: string, retakeTx: string): Promise<SwapOrder> {
    const o = await this.must(id);
    if (o.direction !== "canton-to-evm") {
      throw new Error("counter-retake is reverse-only");
    }
    if (o.revealedPreimage) {
      throw new Error("preimage revealed — swap must settle, not retake");
    }
    if (o.status !== "counter_locked") {
      throw new Error(`not retake-eligible (${o.status})`);
    }
    await verifyForwardRetakeTx(retakeTx, o.hashLock, evmProofOptsForOrder(o));
    const previousStatus = o.status;
    o.mainClaimTx = retakeTx;
    o.evmFloatReserved = false;
    if (!(await this.store.putIfStatus(o, previousStatus))) {
      return this.must(id);
    }
    if (Date.now() / 1000 >= o.userTimelock) {
      return (await this.refundMainCanton(id)).order;
    }
    o.status = "failed";
    if (!(await this.store.putIfStatus(o, previousStatus))) {
      return this.must(id);
    }
    return o;
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
    await verifyForwardRetakeTx(retakeTx, o.hashLock, evmProofOptsForOrder(o));
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

  /** Mark a stale forward order refunded only after an on-chain Retaken proof. */
  async reconcileForwardMainRetake(id: string): Promise<SwapOrder> {
    const o = await this.must(id);
    if (o.direction !== "evm-to-canton") {
      throw new Error("forward retake reconcile is forward-only");
    }
    if (o.status !== "main_locked") {
      throw new Error(`not stale forward main (${o.status})`);
    }
    const evm = evmProofOptsForOrder(o);
    const fromBlockHex = o.mainLockTx
      ? await evmTxBlockHex(o.mainLockTx, evm)
      : undefined;
    const retakeTx = await findEvmRetakeTxForHashLock(o.hashLock, {
      ...evm,
      fromBlockHex
    });
    if (!retakeTx) {
      throw new Error(
        "EVM retake proof missing — leaving order active/refundable"
      );
    }
    return this.recordMainRetake(id, retakeTx);
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
   *    timelock — the sweep records refunded only after finding the user's
   *    on-chain Retaken proof. */
  async expiredOrders(): Promise<{
    abandonedAccepted: SwapOrder[];
    forwardCounter: SwapOrder[];
    reverseMain: SwapOrder[];
    staleForwardMain: SwapOrder[];
    staleLoopSeller: SwapOrder[];
    loopCustodyStalled: SwapOrder[];
    bareReverseAllocation: SwapOrder[];
  }> {
    const now = Math.floor(Date.now() / 1000);
    const [
      accepted,
      counterLocked,
      counterLocking,
      counterClaimed,
      mainLocked,
      mainLocking,
      refunding,
      failed
    ] = await Promise.all([
      this.store.byStatus("accepted"),
      this.store.byStatus("counter_locked"),
      this.store.byStatus("counter_locking"),
      this.store.byStatus("counter_claimed"),
      this.store.byStatus("main_locked"),
      this.store.byStatus("main_locking"),
      this.store.byStatus("refunding"),
      this.store.byStatus("failed")
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
      reverseMain: [
        ...mainLocked,
        ...counterLocking,
        ...counterLocked,
        ...counterClaimed,
        ...refunding,
        ...failed
      ].filter((o) => isReverseMainExpiredSweepCandidate(o, now)),
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
      ),
      bareReverseAllocation: mainLocking.filter(
        (o) =>
          o.direction === "canton-to-evm" &&
          o.counterMode !== "loop" &&
          !!o.allocationCid &&
          !o.htlcCid &&
          now >=
            (o.updatedAt ?? o.createdAt) + BARE_ALLOCATION_RECOVERY_TTL_SECONDS
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
      order.counterTransferOfferCid ||
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
      let lock: Awaited<ReturnType<typeof readOrderEvmLock>>;
      try {
        lock = await readOrderEvmLock(o);
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
    const lock = await readOrderEvmLock(o);
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

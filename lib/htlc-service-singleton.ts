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
import { alert } from "./alert";
import { SWAP_CHAIN } from "./swap-evm";
import {
  createTransfer, findOfferFromSender, prepareAcceptCommand,
  prepareTransferCommand, listPendingOffers, acceptTransfer,
} from "./transfer";
import { NETWORK } from "./constants";
import {
  allocate, createHtlcLock, claimAsReceiver, refundHtlcLock,
  prepareWithdrawCommand,
} from "./htlc-onledger";
import { SupabaseSwapStore, type SwapStore } from "./htlc-order-store";
import type { SwapOrder, SwapStatus, SwapDirection } from "./htlc-types";

export type { SwapOrder, SwapStatus, SwapDirection };

function toHexLower(bytes: Uint8Array): string {
  return "0x" + Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const HTLC_ESCROW_ADDR =
  process.env.NEXT_PUBLIC_HTLC_ESCROW ?? "0x1b19a764ab35db1833ae2137544dd84ba5bf8cf1";
/** Min seconds the solver needs left on the EVM lock to safely claim after a reveal. */
const EVM_CLAIM_MARGIN_SECONDS = 10 * 60;
/** Loop-seller custody: if the WBTC counter-lock hasn't happened within this grace,
 *  the sweep returns the custody early (no point holding the user's funds). */
const LOOP_CUSTODY_GRACE_SECONDS = 30 * 60;

/** Raw read of the escrow's lock for a hashLock: { unlockTime, amount, receiver }. */
async function readEvmLock(hashLockRaw: string): Promise<{ unlockTime: number; amount: bigint; receiver: string }> {
  const hashLock = (hashLockRaw.startsWith("0x") ? hashLockRaw.slice(2) : hashLockRaw).toLowerCase();
  const selector = toHexLower(keccak_256(new TextEncoder().encode("locks(bytes32)"))).slice(2, 10);
  const res = await fetch(SWAP_CHAIN.rpcUrls[0], {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "eth_call",
      params: [{ to: HTLC_ESCROW_ADDR, data: `0x${selector}${hashLock}` }, "latest"],
    }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`EVM lock check failed (rpc ${res.status})`);
  const { result, error } = (await res.json()) as { result?: string; error?: { message?: string } };
  if (error || !result || result.length < 2 + 5 * 64) throw new Error(`EVM lock check failed: ${error?.message ?? "bad rpc result"}`);
  const word = (i: number) => result.slice(2 + i * 64, 2 + (i + 1) * 64);
  return {
    unlockTime: parseInt(word(0), 16),
    amount: BigInt(`0x${word(1)}`),
    receiver: `0x${word(4).slice(24)}`.toLowerCase(),
  };
}

/**
 * SERVER-SIDE EVM LOCK CHECK (solver-robbery guard for the Loop path): before we
 * deliver cBTC, verify on-chain that the user's WBTC is REALLY locked in the HTLC
 * escrow under this order's hashLock — right amount, claimable by OUR solver, with
 * enough time left. Without this, a faked recordMainLock would let a user collect
 * cBTC against a non-existent WBTC lock. (The daemon re-checks at claim time too.)
 */
async function verifyEvmLock(o: SwapOrder): Promise<void> {
  const { unlockTime, amount, receiver } = await readEvmLock(o.hashLock);
  if (amount === 0n) throw new Error("EVM lock not found — WBTC is not locked under this hashLock");
  if (amount < BigInt(o.wbtcAmount)) throw new Error(`EVM lock amount too small (${amount} < ${o.wbtcAmount})`);
  if (receiver !== o.solverEvmAddress.toLowerCase()) throw new Error("EVM lock receiver is not the solver");
  const now = Math.floor(Date.now() / 1000);
  if (unlockTime - now < EVM_CLAIM_MARGIN_SECONDS) throw new Error("EVM lock expires too soon for the solver to claim safely");
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
  /** Order history for one user party (newest first). */
  async historyForParty(party: string): Promise<SwapOrder[]> { return this.store.byParty(party); }

  async accept(id: string) {
    const o = await this.must(id);
    if (o.status !== "open") throw new Error(`order not open (${o.status})`);
    // SOLVENCY GATE (M1): refuse BEFORE the user locks anything if the solver can't
    // fill its leg. Forward (evm→canton): the solver must have the cBTC float.
    // Reverse (canton→evm): the solver must have the WBTC — but that check lives in
    // the daemon (it holds the EVM key) which refuses to lock if its balance is short;
    // the user's cBTC there auto-refunds, so the worst case is a clean abort.
    if (o.direction === "evm-to-canton") {
      const holdings = await getHoldings(o.solverCantonParty);
      const floatSats = holdings.reduce((s, h) => s + BigInt(Math.round(parseFloat(h.payload.amount ?? "0") * 1e8)), 0n);
      const needSats = BigInt(Math.round(parseFloat(o.cbtcAmount) * 1e8));
      if (floatSats < needSats) {
        o.status = "failed"; await this.store.put(o);
        void alert("error", "Solver cBTC float too low — order rejected", {
          order: o.id.slice(0, 18), have: Number(floatSats) / 1e8, need: o.cbtcAmount,
        });
        throw new Error(`solver cBTC float too low (have ${Number(floatSats) / 1e8}, need ${o.cbtcAmount}) — order rejected before you lock`);
      }
    }
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
        allocationCid: o.allocationCid, amountBtc: o.cbtcAmount, hashLock: hashLockHex0,
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
      amountBtc: o.cbtcAmount,
      hashLock: hashLockHex,
      unlockTime,
    });

    o.allocationCid = allocationCid;
    o.htlcCid = htlcCid;
    o.htlcBlob = htlcBlob;
    o.status = "counter_locked"; await this.store.put(o); return o;
  }

  /** LOOP REVEAL + DELIVER — Cancore's venue/custody ordering: SECRET FIRST, then cBTC.
   *
   *  Why this order (solver-robbery guard): if we delivered the cBTC on main_locked,
   *  a user could accept it, never reveal the secret, and retake their WBTC after the
   *  EVM timelock — robbing the solver. So the user's "Claim" click sends us the
   *  preimage FIRST; once we hold a valid preimage we can ALWAYS claim the WBTC
   *  (status flips to counter_claimed → the daemon claims it), and only then do we
   *  deliver the cBTC via a STANDARD TransferFactory_Transfer the user accepts in
   *  their Loop wallet. The user signs ONLY standard choices; all secret logic is on
   *  our node (Loop's Option 1, same custody model Cancore ships for Loop users).
   *
   *  IDEMPOTENT on retry: preimage step keys on status; delivery keys on
   *  counterTransferUpdateId (persisted the instant createTransfer returns).
   */
  async claimCounter(id: string, preimageHex: string): Promise<{ order: SwapOrder; updateId: string; delivered: boolean }> {
    const o = await this.must(id);
    if (o.counterMode !== "loop") {
      throw new Error(`claim-counter is the Loop path (mode ${o.counterMode ?? "managed"}); managed users use claim-managed`);
    }
    // main_claimed is fine too — the daemon may have already claimed the WBTC after
    // the reveal (the custody ordering); the user is just completing their accept.
    if (o.status !== "main_locked" && o.status !== "counter_claimed" && o.status !== "main_claimed") {
      throw new Error(`unexpected status ${o.status}`);
    }
    if (!preimageMatches(preimageHex, o.hashLock)) throw new Error("invalid preimage");

    // 0. EVM LOCK CHECK — the WBTC must REALLY be locked for our solver with time to
    // spare. Guards against a faked recordMainLock collecting cBTC for nothing.
    await verifyEvmLock(o);

    // 1. SECRET FIRST — persist the preimage + flip to counter_claimed BEFORE any
    // delivery. From this moment the daemon can claim the WBTC; we are unrobbable.
    // (Only from main_locked — never downgrade counter_claimed/main_claimed.)
    if (o.status === "main_locked") {
      o.revealedPreimage = ("0x" + (preimageHex.startsWith("0x") ? preimageHex.slice(2) : preimageHex)) as `0x${string}`;
      o.status = "counter_claimed";
      await this.store.put(o);
    }

    // 2. DELIVER the cBTC via a STANDARD transfer (no custom DAR). When the user's
    // Loop wallet has the cBTC PREAPPROVAL (the mandatory auto-accept gate), the
    // registry executes this as a DIRECT transfer — it COMPLETES in one step and
    // there is NO offer to accept (delivered=true). Otherwise an offer is created
    // and the user accepts it with TransferInstruction_Accept (delivered=false).
    // DOUBLE-SPEND GUARD: the updateId is persisted the instant createTransfer
    // returns, so a retry never re-sends.
    let delivered = false;
    if (!o.counterTransferUpdateId) {
      const holdings = await getHoldings(o.solverCantonParty);
      const { updateId, offerContractId, transferKind } = await createTransfer({
        senderParty: o.solverCantonParty,
        receiverParty: o.userCantonParty, // the Loop party (cross-participant)
        amountBtc: o.cbtcAmount,
        inputHoldings: holdings,
      });
      o.counterTransferUpdateId = updateId;
      await this.store.put(o);
      if (offerContractId) { o.counterTransferOfferCid = offerContractId; await this.store.put(o); }
      // No offer created = the transfer self-completed (preapproval auto-accept).
      delivered = !offerContractId;
      console.log(`[htlc] loop deliver ${id}: kind=${transferKind} delivered=${delivered}`);
    } else if (!o.counterTransferOfferCid) {
      // RETRY path with no recorded offer: either it auto-accepted (direct) or the
      // offer was already accepted. If no pending offer exists on-ledger, the cBTC
      // is with the user — nothing left to accept.
      const pending = await findOfferFromSender(o.solverCantonParty, o.userCantonParty);
      if (pending) { o.counterTransferOfferCid = pending; await this.store.put(o); }
      else delivered = true;
    }
    return { order: o, updateId: o.counterTransferUpdateId ?? "", delivered };
  }

  /** PREPARE the standard TransferInstruction_Accept command for the Loop user to
   *  sign in their own wallet. Standard Splice choice (no custom DAR) → runs on
   *  Loop's node. Only available AFTER the reveal+deliver (claimCounter). */
  async prepareLoopAccept(id: string): Promise<{ command: unknown; disclosedContracts: unknown[]; synchronizerId: string }> {
    const o = await this.must(id);
    if (o.counterMode !== "loop") throw new Error(`order is not a loop swap (mode ${o.counterMode})`);
    // counter_claimed = revealed+delivered; main_claimed = daemon already took the
    // WBTC too (normal custody ordering) — the user's accept is valid in both.
    if (o.status !== "counter_claimed" && o.status !== "main_claimed") {
      throw new Error(`counter transfer not ready (status ${o.status}) — reveal the secret first`);
    }
    if (!o.counterTransferUpdateId) throw new Error("counter transfer not sent yet — reveal the secret first");
    // RECOVERY: if the offer cid wasn't captured from the tx tree at create time,
    // find it from the SENDER's ACS (the solver sees the offers it created, even
    // when the receiver is cross-participant).
    if (!o.counterTransferOfferCid) {
      const recovered = await findOfferFromSender(o.solverCantonParty, o.userCantonParty);
      if (!recovered) throw new Error("cBTC transfer offer not found on-ledger — it may have expired (24h TTL)");
      o.counterTransferOfferCid = recovered;
      await this.store.put(o);
    }
    return prepareAcceptCommand({ offerContractId: o.counterTransferOfferCid });
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

  // ===================== REVERSE DIRECTION (canton-to-evm) =====================
  // Main leg = CANTON (user's cBTC, LONG timelock = userTimelock). Counter leg =
  // EVM (solver's WBTC, SHORT timelock = solverTimelock). The user reveals the
  // secret by MetaMask-claiming the WBTC; the solver then claims the cBTC via the
  // on-ledger keccak-gated HtlcLock.Claim. Fully trustless (email users only —
  // both Canton parties are local on warpx). See docs/canton-to-evm-design.md.

  /** REVERSE STEP 2 — backend locks the USER's cBTC on-ledger (CanActAs = Cancore's
   *  "platform auto-locks"): Allocation sender=user, receiver=solver, executor=
   *  solver + HtlcLock locker=user. Idempotent (allocation persisted first). */
  async lockMainCanton(id: string): Promise<SwapOrder> {
    const o = await this.must(id);
    if (o.direction !== "canton-to-evm") throw new Error(`lock-main is canton-to-evm only`);
    if (o.counterMode !== "managed") throw new Error("canton-to-evm requires a participant-managed (email) user in v1");
    if (o.status === "main_locked" && o.allocationCid && o.htlcCid) return o;
    const hashLockHex = o.hashLock.startsWith("0x") ? o.hashLock.slice(2) : o.hashLock;
    // Retry after a partial run: allocation exists, HtlcLock create failed.
    if (o.allocationCid && !o.htlcCid) {
      const { htlcCid, htlcBlob } = await createHtlcLock({
        solverParty: o.solverCantonParty, receiverParty: o.solverCantonParty,
        lockerParty: o.userCantonParty, allocationCid: o.allocationCid,
        amountBtc: o.cbtcAmount, hashLock: hashLockHex, unlockTime: new Date(o.userTimelock * 1000 - 60_000),
      });
      o.htlcCid = htlcCid; o.htlcBlob = htlcBlob; o.status = "main_locked"; await this.store.put(o); return o;
    }
    if (o.status !== "accepted") throw new Error(`order not accepted (${o.status})`);

    const holdings = await getHoldings(o.userCantonParty); // the USER's cBTC
    const now = Date.now();
    const settleBeforeMs = o.userTimelock * 1000; // LONG leg
    const { allocationCid } = await allocate({
      solverParty: o.solverCantonParty,        // executor
      senderParty: o.userCantonParty,          // the user locks THEIR holdings
      receiverParty: o.solverCantonParty,      // solver receives on claim
      amountBtc: o.cbtcAmount,
      inputHoldings: holdings,
      inputHoldingCids: holdings.map((h) => h.contractId),
      settlementId: `htlc-rev-${o.id.slice(0, 18)}-${now}`,
      settleBefore: new Date(settleBeforeMs),
      allocateBefore: new Date(Math.min(now + 10 * 60 * 1000, settleBeforeMs - 30_000)),
    });
    o.allocationCid = allocationCid; await this.store.put(o); // double-spend guard
    const { htlcCid, htlcBlob } = await createHtlcLock({
      solverParty: o.solverCantonParty, receiverParty: o.solverCantonParty,
      lockerParty: o.userCantonParty, allocationCid,
      amountBtc: o.cbtcAmount,
      hashLock: hashLockHex, unlockTime: new Date(settleBeforeMs - 60_000),
    });
    o.htlcCid = htlcCid; o.htlcBlob = htlcBlob;
    o.status = "main_locked"; await this.store.put(o); return o;
  }

  /** REVERSE STEP 3 record — the solver locked the WBTC on EVM (short timelock). */
  async recordCounterLocked(id: string, counterLockTx: string): Promise<SwapOrder> {
    const o = await this.must(id);
    if (o.direction !== "canton-to-evm") throw new Error("counter-lock is canton-to-evm only");
    if (o.status === "counter_locked") return o; // idempotent
    if (o.status !== "main_locked") throw new Error(`main not locked (${o.status})`);
    o.counterLockTx = counterLockTx;
    o.status = "counter_locked"; await this.store.put(o); return o;
  }

  /** REVERSE STEP 5 — the SOLVER claims the user's cBTC with the preimage the user
   *  revealed on EVM (recorded by the UI or by the daemon's Claimed-event watch).
   *  HtlcLock.Claim controller=receiver=solver (LOCAL, own authority) → on-ledger
   *  keccak gate → Allocation_ExecuteTransfer. */
  async claimMainAsSolver(id: string, preimageHex?: string): Promise<{ order: SwapOrder; updateId: string }> {
    const o = await this.must(id);
    if (o.direction !== "canton-to-evm") throw new Error("claim-main is canton-to-evm only");
    if (o.status === "main_claimed") return { order: o, updateId: o.counterClaimUpdateId ?? "" };
    if (o.status !== "counter_claimed" && o.status !== "counter_locked") {
      throw new Error(`unexpected status ${o.status}`);
    }
    const preimage = preimageHex ?? (o.revealedPreimage ? o.revealedPreimage.slice(2) : undefined);
    if (!preimage) throw new Error("no preimage — user has not revealed yet");
    if (!preimageMatches(preimage, o.hashLock)) throw new Error("invalid preimage");
    let updateId: string;
    if (o.counterMode === "loop") {
      // LOOP SELLER (Variant A custody): the cBTC entered our float at lock time
      // (transfer-to-venue accept). The user's EVM claim revealed the preimage —
      // the swap is settled; NO Canton action remains. Just record completion.
      if (!o.counterTransferUpdateId) throw new Error("custody transfer not recorded — lock step incomplete");
      updateId = o.counterTransferUpdateId;
    } else {
      if (!o.htlcCid || !o.allocationCid) throw new Error("on-ledger HtlcLock not present");
      ({ updateId } = await claimAsReceiver({
        receiverParty: o.solverCantonParty, // the solver IS the receiver here
        solverParty: o.solverCantonParty,
        htlcCid: o.htlcCid, htlcBlob: o.htlcBlob,
        allocationCid: o.allocationCid, preimageHex: preimage,
      }));
    }
    o.revealedPreimage = ("0x" + (preimage.startsWith("0x") ? preimage.slice(2) : preimage)) as `0x${string}`;
    o.status = "main_claimed"; await this.store.put(o);
    return { order: o, updateId };
  }

  // ============ LOOP SELLERS (canton-to-evm, external wallet) ============
  // The user locks via the STANDARD AllocationFactory_Allocate signed in THEIR
  // wallet (Variant B — escrow with a unilateral Allocation_Withdraw exit). No
  // custom contract touches the Loop party. VARIANT A (transfer-to-venue custody,
  // = Cancore): the allocation-escrow variant was proven UNSETTLEABLE on-node
  // (DvpLegAllocation.ExecuteTransfer needs sender+receiver+executor, all three,
  // live — impossible cross-participant). See docs/canton-to-evm-design.md.

  /** STEP 2a (LOOP SELLER, Variant A = Cancore's transfer-to-venue) — build the
   *  STANDARD TransferFactory_Transfer (user → venue) for the user's wallet.
   *  Holding cids are read in the BROWSER (we can't see a Loop party's holdings).
   *
   *  WHY NOT THE ALLOCATION ESCROW (settled 2026-06-12, proven on-node): the cBTC
   *  DvpLegAllocation's ExecuteTransfer needs sender+receiver+executor ALL THREE at
   *  execute time — a bare allocation with a cross-participant party can be locked
   *  but settled by NO ONE. Custody is forced; it's exactly what Cancore ships. */
  async prepareLoopSellerLock(id: string, holdingCids: string[]): Promise<{ command: unknown; disclosedContracts: unknown[]; synchronizerId: string }> {
    const o = await this.must(id);
    if (o.direction !== "canton-to-evm" || o.counterMode !== "loop") {
      throw new Error("prepare-lock-loop is for Loop-seller (canton-to-evm) orders only");
    }
    if (o.status !== "accepted") throw new Error(`order not accepted (${o.status})`);
    if (!holdingCids?.length) throw new Error("no input holdings supplied");
    return prepareTransferCommand({
      senderParty: o.userCantonParty,
      receiverParty: o.solverCantonParty,
      amountBtc: o.cbtcAmount,
      inputHoldingCids: holdingCids,
    });
  }

  /** STEP 2b (LOOP SELLER) — find the user's transfer offer in OUR view and ACCEPT
   *  it as the venue (custody starts) → main_locked. Never trusts the browser. */
  async confirmLoopSellerLock(id: string): Promise<SwapOrder> {
    const o = await this.must(id);
    if (o.direction !== "canton-to-evm" || o.counterMode !== "loop") {
      throw new Error("confirm-lock-loop is for Loop-seller orders only");
    }
    if (o.status === "main_locked") return o; // idempotent
    if (o.status !== "accepted") throw new Error(`order not accepted (${o.status})`);
    const offers = await listPendingOffers(o.solverCantonParty);
    const offer = offers.find(
      (x) => x.sender === o.userCantonParty && parseFloat(x.amountBtc) + 1e-9 >= parseFloat(o.cbtcAmount),
    );
    if (!offer) throw new Error("transfer offer not visible on-ledger yet");
    const { updateId } = await acceptTransfer({
      receiverParty: o.solverCantonParty,
      offerContractId: offer.contractId,
    });
    o.counterTransferOfferCid = offer.contractId;
    o.counterTransferUpdateId = updateId;
    o.status = "main_locked"; await this.store.put(o); return o;
  }

  /** LOOP-SELLER refund prep — the user's unilateral exit: standard
   *  Allocation_Withdraw signed in their wallet. */
  async prepareLoopSellerWithdraw(id: string): Promise<{ command: unknown; disclosedContracts: unknown[]; synchronizerId: string }> {
    const o = await this.must(id);
    if (o.counterMode !== "loop" || !o.allocationCid) throw new Error("no loop allocation to withdraw");
    return prepareWithdrawCommand({ allocationCid: o.allocationCid });
  }

  /** REVERSE refund — after the LONG (Canton) timelock, return the cBTC to the
   *  USER: HtlcLock.Refund as locker=user (backend CanActAs) → Allocation_Withdraw. */
  async refundMainCanton(id: string): Promise<{ order: SwapOrder; updateId: string }> {
    const o = await this.must(id);
    if (o.direction !== "canton-to-evm") throw new Error("refund-main is canton-to-evm only");
    if (o.status !== "main_locked" && o.status !== "counter_locked") {
      throw new Error(`not refundable (${o.status})`);
    }
    if (Date.now() / 1000 < o.userTimelock) throw new Error("Canton timelock not reached yet");
    // REFUND-vs-CLAIM RACE GUARD (both modes): once the secret is public the swap
    // MUST settle (the user has, or can, claim the WBTC). Refunding the cBTC then
    // would let the user keep both legs. The on-ledger HtlcLock.Refund timelock is a
    // backstop, but never even attempt a refund once revealed.
    if (o.revealedPreimage) throw new Error("preimage revealed — swap must settle, not refund");
    let updateId: string;
    if (o.counterMode === "loop") {
      // LOOP SELLER custody refund — fully automatable on OUR side: send the
      // custodied cBTC straight back (direct transfer; the user's preapproval
      // auto-accepts).
      if (!o.counterTransferUpdateId) throw new Error("no custody transfer recorded — nothing to refund");
      const holdings = await getHoldings(o.solverCantonParty);
      ({ updateId } = await createTransfer({
        senderParty: o.solverCantonParty,
        receiverParty: o.userCantonParty,
        amountBtc: o.cbtcAmount,
        inputHoldings: holdings,
      }));
    } else {
      if (!o.htlcCid || !o.allocationCid) throw new Error("on-ledger HtlcLock not present");
      ({ updateId } = await refundHtlcLock({
        solverParty: o.solverCantonParty, lockerParty: o.userCantonParty,
        htlcCid: o.htlcCid, allocationCid: o.allocationCid,
      }));
    }
    o.status = "refunded"; await this.store.put(o);
    return { order: o, updateId };
  }

  /** STEP 6b — record that the USER's Loop wallet submitted the Claim (cBTC released,
   *  preimage now public on-ledger). The frontend calls this with the updateId after
   *  provider.submitTransaction succeeds. Stores the preimage for the solver's EVM claim. */
  async recordCounterClaimed(id: string, preimageHex: string, updateId: string): Promise<SwapOrder> {
    const o = await this.must(id);
    // GUARD: a forward MANAGED order must settle via claimCounterAsBackend (which
    // ACTUALLY claims the cBTC on-ledger), NOT this record-only endpoint — else a
    // client could mark it counter_claimed without the cBTC moving, then the daemon
    // pays out the WBTC. Only Loop-buyer (forward) and reverse orders use this path.
    if (o.direction === "evm-to-canton" && o.counterMode === "managed") {
      throw new Error("forward managed orders settle via claim-managed, not claim-record");
    }
    if (o.status !== "counter_locked" && o.status !== "counter_claimed") {
      throw new Error(`unexpected status ${o.status}`);
    }
    // VALIDATE the preimage (same gate as the managed path). The browser supplies it,
    // so reject a junk preimage here — recording a bad one as counter_claimed would
    // stall the solver's EVM claim with an unusable secret. (The on-chain claim also
    // re-checks keccak, but we must not corrupt order state.)
    if (!preimageMatches(preimageHex, o.hashLock)) throw new Error("invalid preimage");
    o.revealedPreimage = ("0x" + (preimageHex.startsWith("0x") ? preimageHex.slice(2) : preimageHex)) as `0x${string}`;
    o.counterClaimUpdateId = updateId;
    o.status = "counter_claimed"; await this.store.put(o);
    return o;
  }

  async recordMainClaim(id: string, mainClaimTx: string) {
    const o = await this.must(id);
    // FORWARD-ONLY endpoint (records the solver's EVM WBTC claim). A stale daemon
    // once hit this for a REVERSE order and falsely marked it main_claimed without
    // the Canton settlement ever happening. Hard-reject reverse orders.
    if (o.direction === "canton-to-evm") throw new Error("main-claim is forward-only; reverse orders settle via claim-main");
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
    // GUARD: this records the user's EVM WBTC retake (forward direction only) and is
    // bookkeeping. Reject reverse orders and any settled/terminal state so a stray
    // or stale POST can't knock a live/completed order out of the active set.
    if (o.direction !== "evm-to-canton") throw new Error("retake-main is forward-only");
    if (o.status === "main_claimed" || o.status === "refunded" || o.status === "cancelled") {
      throw new Error(`order already terminal (${o.status})`);
    }
    o.status = "refunded"; o.mainClaimTx = retakeTx; await this.store.put(o); return o;
  }

  /** Swaps that are counter_locked AND past their Canton timelock — candidates for
   *  the auto-refund sweep (the daemon refunds these to free the solver's cBTC). */
  async refundableOrders(): Promise<SwapOrder[]> {
    const now = Math.floor(Date.now() / 1000);
    return (await this.store.byStatus("counter_locked")).filter((o) => now >= o.solverTimelock);
  }

  /** All expired-and-actionable orders, categorized for the auto-refund sweep.
   *  - forwardCounter: evm→canton MANAGED orders whose on-ledger cBTC HtlcLock
   *    (solver's) expired → refundCounter. (Loop orders never lock cBTC.)
   *  - reverseMain: canton→evm orders whose on-ledger cBTC HtlcLock (USER's)
   *    expired → refundMainCanton (backend CanActAs — fully automated).
   *  - staleForwardMain: evm→canton orders stuck in main_locked past the EVM
   *    timelock — nothing of OURS is locked (the user retakes their WBTC on EVM
   *    with their own key); mark refunded so the active list drains. */
  async expiredOrders(): Promise<{ forwardCounter: SwapOrder[]; reverseMain: SwapOrder[]; staleForwardMain: SwapOrder[]; staleLoopSeller: SwapOrder[]; loopCustodyStalled: SwapOrder[] }> {
    const now = Math.floor(Date.now() / 1000);
    const [counterLocked, mainLocked] = await Promise.all([
      this.store.byStatus("counter_locked"),
      this.store.byStatus("main_locked"),
    ]);
    return {
      forwardCounter: counterLocked.filter(
        (o) => o.direction === "evm-to-canton" && o.counterMode !== "loop" && !!o.htlcCid && now >= o.solverTimelock,
      ),
      // Exclude revealed orders — once the secret is public the swap settles, never
      // refunds (refund-vs-claim race guard).
      reverseMain: [...mainLocked, ...counterLocked].filter(
        (o) => o.direction === "canton-to-evm" && o.counterMode !== "loop" && !!o.htlcCid && !o.revealedPreimage && now >= o.userTimelock,
      ),
      staleForwardMain: mainLocked.filter(
        (o) => o.direction === "evm-to-canton" && now >= o.userTimelock,
      ),
      // LOOP SELLERS (Variant A custody): WE hold the cBTC → the sweep sends it
      // straight back after the timelock (refundMainCanton, fully automated). Skip
      // revealed (settled) orders.
      staleLoopSeller: [...mainLocked, ...counterLocked].filter(
        (o) => o.direction === "canton-to-evm" && o.counterMode === "loop" && !o.revealedPreimage && now >= o.userTimelock,
      ),
      // EARLY refund (hardening): custody taken but the WBTC counter-lock never
      // happened within the grace window — return the custody NOW instead of
      // making the user wait out the full timelock. Verified safe in
      // earlyRefundLoopCustody (on-chain check that NO WBTC lock exists).
      loopCustodyStalled: mainLocked.filter(
        (o) => o.direction === "canton-to-evm" && o.counterMode === "loop" && now >= o.createdAt + LOOP_CUSTODY_GRACE_SECONDS && now < o.userTimelock,
      ),
    };
  }

  /** EARLY custody return for a stalled Loop-seller swap (no WBTC counter-lock).
   *  SAFETY: only from main_locked, only when the secret is unrevealed, and only
   *  after an ON-CHAIN check that no WBTC lock exists under this hashLock (so a
   *  daemon that locked but failed to report can't be double-paid). */
  async earlyRefundLoopCustody(id: string): Promise<{ order: SwapOrder; updateId: string }> {
    const o = await this.must(id);
    if (o.direction !== "canton-to-evm" || o.counterMode !== "loop") throw new Error("early refund is loop-seller only");
    if (o.status !== "main_locked") throw new Error(`not stalled (${o.status})`);
    if (o.revealedPreimage) throw new Error("preimage revealed — swap must settle, not refund");
    if (!o.counterTransferUpdateId) throw new Error("no custody transfer recorded");
    const lock = await readEvmLock(o.hashLock);
    if (lock.amount > 0n) throw new Error("WBTC lock exists on-chain — not stalled, do not refund");
    const holdings = await getHoldings(o.solverCantonParty);
    const { updateId } = await createTransfer({
      senderParty: o.solverCantonParty,
      receiverParty: o.userCantonParty,
      amountBtc: o.cbtcAmount,
      inputHoldings: holdings,
    });
    o.status = "refunded"; await this.store.put(o);
    return { order: o, updateId };
  }

  /** Bookkeeping: mark a dead order refunded (no on-ledger action by US — used when
   *  the locked funds are recoverable only by the USER's own signature: their EVM
   *  WBTC retake, or a Loop seller's Allocation_Withdraw). */
  async markRefunded(id: string): Promise<SwapOrder> {
    const o = await this.must(id);
    if (o.status !== "main_locked" && o.status !== "counter_locked") throw new Error(`not stale (${o.status})`);
    o.status = "refunded"; await this.store.put(o); return o;
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

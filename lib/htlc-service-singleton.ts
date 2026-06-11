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
import { SWAP_CHAIN } from "./swap-evm";
import { createTransfer, findOfferFromSender, prepareAcceptCommand } from "./transfer";
import { NETWORK } from "./constants";
import { allocate, createHtlcLock, prepareClaimCommand, claimAsReceiver, refundHtlcLock } from "./htlc-onledger";
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

/**
 * SERVER-SIDE EVM LOCK CHECK (solver-robbery guard for the Loop path): before we
 * deliver cBTC, verify on-chain that the user's WBTC is REALLY locked in the HTLC
 * escrow under this order's hashLock — right amount, claimable by OUR solver, with
 * enough time left. Without this, a faked recordMainLock would let a user collect
 * cBTC against a non-existent WBTC lock. (The daemon re-checks at claim time too.)
 */
async function verifyEvmLock(o: SwapOrder): Promise<void> {
  const hashLock = (o.hashLock.startsWith("0x") ? o.hashLock.slice(2) : o.hashLock).toLowerCase();
  // locks(bytes32) getter — selector = first 4 bytes of keccak256 of the signature.
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
  const unlockTime = parseInt(word(0), 16);          // Lock.unlockTime (uint64)
  const amount = BigInt(`0x${word(1)}`);             // Lock.amount
  const receiver = `0x${word(4).slice(24)}`.toLowerCase(); // Lock.receiverAddress
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
        hashLock: hashLockHex, unlockTime: new Date(o.userTimelock * 1000 - 60_000),
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
    if (!o.htlcCid || !o.allocationCid) throw new Error("on-ledger HtlcLock not present");
    const { updateId } = await claimAsReceiver({
      receiverParty: o.solverCantonParty, // the solver IS the receiver here
      solverParty: o.solverCantonParty,
      htlcCid: o.htlcCid, htlcBlob: o.htlcBlob,
      allocationCid: o.allocationCid, preimageHex: preimage,
    });
    o.revealedPreimage = ("0x" + (preimage.startsWith("0x") ? preimage.slice(2) : preimage)) as `0x${string}`;
    o.status = "main_claimed"; await this.store.put(o);
    return { order: o, updateId };
  }

  /** REVERSE refund — after the LONG (Canton) timelock, return the cBTC to the
   *  USER: HtlcLock.Refund as locker=user (backend CanActAs) → Allocation_Withdraw. */
  async refundMainCanton(id: string): Promise<{ order: SwapOrder; updateId: string }> {
    const o = await this.must(id);
    if (o.direction !== "canton-to-evm") throw new Error("refund-main is canton-to-evm only");
    if (o.status !== "main_locked" && o.status !== "counter_locked") {
      throw new Error(`not refundable (${o.status})`);
    }
    if (!o.htlcCid || !o.allocationCid) throw new Error("on-ledger HtlcLock not present");
    if (Date.now() / 1000 < o.userTimelock) throw new Error("Canton timelock not reached yet");
    const { updateId } = await refundHtlcLock({
      solverParty: o.solverCantonParty, lockerParty: o.userCantonParty,
      htlcCid: o.htlcCid, allocationCid: o.allocationCid,
    });
    o.status = "refunded"; await this.store.put(o);
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

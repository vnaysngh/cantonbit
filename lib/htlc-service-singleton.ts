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
import { allocate, createHtlcLock, prepareClaimCommand } from "./htlc-onledger";

export type SwapDirection = "evm-to-canton" | "canton-to-evm";
export type SwapStatus =
  | "open" | "accepted" | "main_locked" | "counter_locked"
  | "counter_claimed" | "main_claimed" | "refunded" | "failed";

export interface SwapOrder {
  id: string;
  direction: SwapDirection;
  status: SwapStatus;
  hashLock: `0x${string}`;
  userEvmAddress: string;
  solverEvmAddress: string;
  wbtcAmount: string;
  userTimelock: number;
  userCantonParty: string;
  solverCantonParty: string;
  cbtcAmount: string;
  solverTimelock: number;
  mainLockTx?: string;
  counterClaimUpdateId?: string;
  revealedPreimage?: `0x${string}`;
  mainClaimTx?: string;
  createdAt: number;
  // on-ledger HTLC (the DAR path)
  allocationCid?: string;
  htlcCid?: string;
  htlcBlob?: string;
}

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

// In-memory store (swap for Supabase in production, like solver_orders).
const ORDERS = new Map<string, SwapOrder>();

class HtlcService {
  async createOrder(o: Omit<SwapOrder, "status" | "createdAt">): Promise<SwapOrder> {
    const order: SwapOrder = { ...o, status: "open", createdAt: Math.floor(Date.now() / 1000) };
    ORDERS.set(order.id, order);
    return order;
  }
  async getOrder(id: string) { return ORDERS.get(id); }
  /** Orders the solver should act on (not terminal). */
  async activeOrders(): Promise<SwapOrder[]> {
    return [...ORDERS.values()].filter(
      (o) => o.status !== "main_claimed" && o.status !== "refunded" && o.status !== "failed",
    );
  }

  async accept(id: string) {
    const o = this.must(id);
    if (o.status !== "open") throw new Error(`order not open (${o.status})`);
    o.status = "accepted"; ORDERS.set(id, o); return o;
  }
  async recordMainLock(id: string, mainLockTx: string) {
    const o = this.must(id);
    if (o.status !== "accepted") throw new Error(`order not accepted (${o.status})`);
    o.status = "main_locked"; o.mainLockTx = mainLockTx; ORDERS.set(id, o); return o;
  }
  /** STEP 4 — ON-LEDGER lock: allocate the solver's cBTC + wrap it in HtlcLock.
   *  cBTC is genuinely locked on-ledger (Allocation), the hashLock recorded in our
   *  DAR, BEFORE the user reveals. Solver is sender+executor (pre-delegation). */
  async lockCounter(id: string) {
    const o = this.must(id);
    if (o.status !== "main_locked") throw new Error(`main not locked (${o.status})`);

    const holdings = await getHoldings(o.solverCantonParty);
    const inputHoldingCids = holdings.map((h) => h.contractId);
    const now = Date.now();
    // settleBefore = the Canton timelock; HtlcLock unlockTime must be <= settleBefore.
    const settleBefore = new Date(o.solverTimelock * 1000);
    const allocateBefore = new Date(now + 10 * 60 * 1000);
    const unlockTime = new Date(o.solverTimelock * 1000 - 60_000); // settleBefore - 1min

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
    o.status = "counter_locked"; ORDERS.set(id, o); return o;
  }

  /** STEP 6a — PREPARE the user's Claim command. The Claim is controller=receiver,
   *  so the USER submits it from their Loop wallet (backend CANNOT). Returns the
   *  command + disclosed contracts for the browser's provider.submitTransaction. */
  async prepareClaim(id: string, preimageHex: string): Promise<{ command: unknown; disclosedContracts: unknown[] }> {
    const o = this.must(id);
    if (o.status !== "counter_locked") throw new Error(`counter not locked (${o.status})`);
    if (!o.htlcCid || !o.allocationCid) throw new Error("on-ledger HtlcLock not present");
    // Backend pre-check so a bad preimage fails fast. The AUTHORITATIVE gate is the
    // ledger's keccak check inside HtlcLock.Claim.
    if (!preimageMatches(preimageHex, o.hashLock)) throw new Error("invalid preimage");
    return prepareClaimCommand({ htlcCid: o.htlcCid, htlcBlob: o.htlcBlob, allocationCid: o.allocationCid, solverParty: o.solverCantonParty, preimageHex });
  }

  /** STEP 6b — record that the USER's Loop wallet submitted the Claim (cBTC released,
   *  preimage now public on-ledger). The frontend calls this with the updateId after
   *  provider.submitTransaction succeeds. Stores the preimage for the solver's EVM claim. */
  async recordCounterClaimed(id: string, preimageHex: string, updateId: string): Promise<SwapOrder> {
    const o = this.must(id);
    if (o.status !== "counter_locked" && o.status !== "counter_claimed") {
      throw new Error(`unexpected status ${o.status}`);
    }
    o.revealedPreimage = ("0x" + (preimageHex.startsWith("0x") ? preimageHex.slice(2) : preimageHex)) as `0x${string}`;
    o.counterClaimUpdateId = updateId;
    o.status = "counter_claimed"; ORDERS.set(id, o);
    return o;
  }

  async recordMainClaim(id: string, mainClaimTx: string) {
    const o = this.must(id);
    if (o.status !== "counter_claimed") throw new Error(`counter not claimed (${o.status})`);
    o.status = "main_claimed"; o.mainClaimTx = mainClaimTx; ORDERS.set(id, o); return o;
  }
  async getRevealedPreimage(id: string) { return this.must(id).revealedPreimage; }

  private must(id: string): SwapOrder {
    const o = ORDERS.get(id);
    if (!o) throw new Error("swap not found");
    return o;
  }
}

let _svc: HtlcService | undefined;
export function htlcService(): HtlcService {
  if (!_svc) {
    // touch NETWORK so a misconfig fails loudly at first use
    if (!NETWORK?.decentralizedPartyId) throw new Error("NETWORK not configured");
    _svc = new HtlcService();
  }
  return _svc;
}

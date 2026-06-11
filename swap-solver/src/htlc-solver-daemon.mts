/**
 * INDEPENDENT HTLC SOLVER DAEMON (B-REAL2).
 *
 * This is the real solver — a standalone process, NOT the browser. It:
 *   1. Polls the order API for orders.
 *   2. When an order is `main_locked`, verifies the WBTC lock on-chain, then locks
 *      the cBTC counter (transitions it to counter_locked) so the user can claim.
 *   3. When an order is `counter_claimed` (the USER revealed the preimage by
 *      claiming the cBTC), the solver READS the revealed preimage and submits
 *      claim(preImage) on the HTLCEscrow — actually taking the WBTC on EVM.
 *   4. Records main_claimed.
 *
 * The user and the solver each do their own steps. The secret is revealed by the
 * USER's claim; the solver only ever READS the public preimage to take the WBTC it
 * is owed. It cannot steal — it can only claim the leg the user already unlocked.
 *
 * Run:
 *   SOLVER_EVM_PK=0x... API_BASE=http://localhost:3000 \
 *     npx tsx src/htlc-solver-daemon.mts
 */
import {
  createPublicClient, createWalletClient, http, getContract,
  type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

import { HTLC_ESCROW_ABI } from "./htlc-abi.js";

const API_BASE = process.env.API_BASE ?? "http://localhost:3000";
const RPC = process.env.ORIGIN_RPC_URL ?? "https://sepolia.base.org";
const ESCROW = (process.env.HTLC_ESCROW_ADDRESS ?? "0x1b19a764ab35db1833ae2137544dd84ba5bf8cf1") as Address;
const POLL_MS = Number(process.env.SOLVER_POLL_MS ?? 4000);

function reqEnv(k: string): string { const v = process.env[k]; if (!v) throw new Error(`missing env ${k}`); return v; }
const norm = (k: string) => (k.startsWith("0x") ? k : `0x${k}`) as Hex;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Order {
  id: string; status: string; hashLock: Hex;
  wbtcAmount: string; userEvmAddress: string; solverEvmAddress: string;
  revealedPreimage?: Hex; mainClaimTx?: string;
}

async function jget(path: string) {
  const r = await fetch(`${API_BASE}${path}`);
  if (!r.ok) throw new Error(`GET ${path} ${r.status}`);
  return r.json();
}
async function jpost(path: string, body?: unknown) {
  const r = await fetch(`${API_BASE}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `POST ${path} ${r.status}`);
  return j;
}

async function main() {
  const account = privateKeyToAccount(norm(reqEnv("SOLVER_EVM_PK")));
  const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
  const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(RPC) });
  const escrow = getContract({ address: ESCROW, abi: HTLC_ESCROW_ABI, client: { public: pub, wallet } });

  console.log(`[solver] up. account=${account.address} escrow=${ESCROW} api=${API_BASE}`);
  console.log(`[solver] polling every ${POLL_MS}ms…`);

  // Track which orders we've acted on (avoid double-submits).
  const lockedCounter = new Set<string>();
  const claimedMain = new Set<string>();
  let lastSweep = 0;

  for (;;) {
    try {
      // AUTO-REFUND sweep (Cancore parity) — periodically refund counter-locked
      // swaps past their Canton timelock, freeing the solver's cBTC. Every ~60s.
      const nowMs = Date.now();
      if (nowMs - lastSweep > 60_000) {
        lastSweep = nowMs;
        try {
          const r = (await jpost("/api/htlc/auto-refund")) as { due?: number; refunded?: number };
          if (r.due && r.due > 0) console.log(`[solver] auto-refund swept ${r.refunded}/${r.due} expired swaps`);
        } catch (e) { console.error("[solver] auto-refund error:", e instanceof Error ? e.message : e); }
      }
      // The API has no list endpoint yet; the daemon learns order ids from a
      // shared ids feed. We poll the known-active set via /api/htlc/active.
      const { orders } = (await jget("/api/htlc/active")) as { orders: Order[] };

      for (const o of orders ?? []) {
        // STEP 4 — order is main_locked: verify the WBTC lock on-chain, lock counter.
        if (o.status === "main_locked" && !lockedCounter.has(o.id)) {
          const lock = (await escrow.read.locks([o.hashLock])) as readonly [bigint, bigint, Address, Address, Address];
          const amount = BigInt(o.wbtcAmount);
          if (lock[1] !== amount) { console.log(`[solver] ${o.id.slice(0,12)} lock not on-chain yet (have ${lock[1]})`); continue; }
          if (lock[4].toLowerCase() !== o.solverEvmAddress.toLowerCase()) { console.log(`[solver] ${o.id.slice(0,12)} lock receiver != solver — skip`); continue; }
          console.log(`[solver] ${o.id.slice(0,12)} WBTC lock verified on-chain → locking cBTC counter`);
          await jpost(`/api/htlc/${o.id}/lock-counter`);
          lockedCounter.add(o.id);
        }

        // STEP 7 — order is counter_claimed: the USER revealed the preimage. Read it
        // and ACTUALLY claim the WBTC on EVM.
        if (o.status === "counter_claimed" && !claimedMain.has(o.id)) {
          const { preimage } = (await jget(`/api/htlc/${o.id}/preimage`)) as { preimage: Hex };
          if (!preimage) { console.log(`[solver] ${o.id.slice(0,12)} no preimage yet`); continue; }
          // sanity: don't double-claim if already gone
          const lock = (await escrow.read.locks([o.hashLock])) as readonly [bigint, bigint, Address, Address, Address];
          if (lock[1] === 0n) { console.log(`[solver] ${o.id.slice(0,12)} lock already claimed/empty`); claimedMain.add(o.id); await jpost(`/api/htlc/${o.id}/main-claim`, { mainClaimTx: "already-claimed" }).catch(()=>{}); continue; }
          console.log(`[solver] ${o.id.slice(0,12)} preimage revealed → claiming WBTC on EVM…`);
          const tx = await escrow.write.claim([preimage], { account, chain: null });
          await pub.waitForTransactionReceipt({ hash: tx });
          console.log(`[solver] ${o.id.slice(0,12)} ✓ WBTC claimed tx=${tx.slice(0,14)}`);
          await jpost(`/api/htlc/${o.id}/main-claim`, { mainClaimTx: tx });
          claimedMain.add(o.id);
        }
      }
    } catch (e) {
      console.error(`[solver] loop error:`, e instanceof Error ? e.message : e);
    }
    await sleep(POLL_MS);
  }
}

main().catch((e) => { console.error("[solver] fatal:", e); process.exit(1); });

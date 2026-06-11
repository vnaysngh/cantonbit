/**
 * ONE-OFF HYGIENE SWEEP — recover stuck testnet funds.
 *  1. EVM: scan the escrow's Locked events where sender = our solver key; retake
 *     every lock that is still active and past its unlockTime.
 *  2. Canton: refund expired counter-locked forward orders (frees solver cBTC) via
 *     the API, and clean orphan allocations via /api/htlc/cleanup-allocations.
 *  3. DB: mark the recovered stuck orders refunded.
 * Run:
 *   SOLVER_EVM_PK=... API_BASE=http://localhost:3000 \
 *   npx tsx --env-file=.env --env-file=../.env.local src/hygiene-sweep.mts
 */
import { createPublicClient, createWalletClient, getContract, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { HTLC_ESCROW_ABI } from "./htlc-abi.js";

function reqEnv(k: string): string { const v = process.env[k]; if (!v) throw new Error(`missing env ${k}`); return v; }
const norm = (k: string): Hex => (k.startsWith("0x") ? k : `0x${k}`) as Hex;

const RPC = process.env.ORIGIN_RPC_URL ?? "https://sepolia.base.org";
const ESCROW = (process.env.HTLC_ESCROW_ADDRESS ?? "0x1b19a764ab35db1833ae2137544dd84ba5bf8cf1") as Address;
const API_BASE = process.env.API_BASE ?? "http://localhost:3000";

async function main() {
  const account = privateKeyToAccount(norm(reqEnv("SOLVER_EVM_PK")));
  const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
  const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(RPC) });
  const escrow = getContract({ address: ESCROW, abi: HTLC_ESCROW_ABI, client: { public: pub, wallet } });

  // ---- 1. EVM: retake every expired lock OUR key created ----
  // Public RPC caps eth_getLogs at 2000 blocks → scan in chunks from deploy.
  console.log(`[1] scanning Locked events (sender=${account.address})…`);
  const startBlock = BigInt(process.env.ESCROW_START_BLOCK ?? "42371722");
  const tip = await pub.getBlockNumber();
  const logs: unknown[] = [];
  for (let from = startBlock; from <= tip; from += 1990n) {
    const to = from + 1989n > tip ? tip : from + 1989n;
    const chunk = await pub.getContractEvents({
      address: ESCROW, abi: HTLC_ESCROW_ABI, eventName: "Locked",
      fromBlock: from, toBlock: to,
    });
    logs.push(...chunk);
  }
  console.log(`  scanned ${Number(tip - startBlock)} blocks, ${logs.length} Locked event(s)`);
  const seen = new Set<string>();
  let retaken = 0, skipped = 0;
  const now = Math.floor(Date.now() / 1000);
  for (const log of logs) {
    const a = (log as { args?: { hashValue?: Hex; senderAddress?: Address } }).args;
    if (!a?.hashValue || seen.has(a.hashValue)) continue;
    seen.add(a.hashValue);
    if (a.senderAddress?.toLowerCase() !== account.address.toLowerCase()) { skipped++; continue; }
    const lock = (await escrow.read.locks([a.hashValue])) as readonly [bigint, bigint, Address, Address, Address];
    if (lock[1] === 0n) continue; // already claimed/retaken
    if (Number(lock[0]) > now) { console.log(`  ${a.hashValue.slice(0, 14)}… still timelocked (until ${lock[0]}) — skip`); continue; }
    console.log(`  retaking ${a.hashValue.slice(0, 14)}… amount=${lock[1]}`);
    const tx = await escrow.write.retake([a.hashValue], { account, chain: null });
    await pub.waitForTransactionReceipt({ hash: tx });
    retaken++;
  }
  console.log(`  ✓ retook ${retaken} lock(s); ${skipped} foreign-sender events ignored.`);

  // ---- 2. Canton: refund expired counter-locked orders + orphan allocations ----
  console.log(`[2] auto-refund expired swaps via API…`);
  const r1 = await fetch(`${API_BASE}/api/htlc/auto-refund`, { method: "POST" });
  console.log(`  auto-refund:`, JSON.stringify(await r1.json()).slice(0, 200));
  console.log(`[3] cleanup orphan allocations…`);
  const r2 = await fetch(`${API_BASE}/api/htlc/cleanup-allocations`, { method: "POST" });
  console.log(`  cleanup-allocations:`, JSON.stringify(await r2.json()).slice(0, 300));
  console.log(`\nDONE.`);
}

main().catch((e) => { console.error("[hygiene] FATAL:", e instanceof Error ? e.message : e); process.exit(1); });

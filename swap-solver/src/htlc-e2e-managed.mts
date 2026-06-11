/**
 * R3 END-TO-END: participant-managed swap, HANDS-OFF via the daemon + backend.
 *
 * Does ONLY the user's part:
 *   1. create order (participant-managed receiver = an onboarded warpx party)
 *   2. real WBTC lock on Base Sepolia (the user's MetaMask action, here scripted)
 *   3. wait for the DAEMON to auto-lock the cBTC counter (allocate + HtlcLock)
 *   4. claim-managed (backend signs the cBTC claim via CanActAs — the "press Claim")
 *   5. wait for the DAEMON to auto-claim the WBTC on EVM
 *   → full swap, no manual solver steps.
 *
 * Requires: the dev server (:3000) + the solver daemon both running.
 *
 * Run:
 *   RECV_PARTY=party-…  npx tsx --env-file=.env --env-file=../.env.local src/htlc-e2e-managed.mts
 */
import {
  createPublicClient, createWalletClient, getContract, http, parseUnits,
  type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

import { HTLC_ESCROW_ABI } from "./htlc-abi.js";

const API = process.env.API_BASE ?? "http://localhost:3000";
const RPC = process.env.ORIGIN_RPC_URL!;
const ESCROW = (process.env.HTLC_ESCROW_ADDRESS ?? "0x1b19a764ab35db1833ae2137544dd84ba5bf8cf1") as Address;
const WBTC = process.env.WBTC_ADDRESS as Address;
const SOLVER_EVM = process.env.SOLVER_EVM ?? "0x0B95ec21579aee6Ef7b712976bD86689D68b5A08";
const SOLVER_CANTON = process.env.SOLVER_CANTON_PARTY!;
const RECV = process.env.RECV_PARTY!;

const norm = (k: string) => (k.startsWith("0x") ? k : `0x${k}`) as Hex;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PRE = "7468652d63726f73732d636861696e2d7365637265742d333262797465732121";
const H = "0x94277b389401042e35f8709846050797955e2b321bee500555c2fbdc2f4e9903";

const ERC20 = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

async function jpost(p: string, b?: unknown) {
  const r = await fetch(`${API}${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `POST ${p} ${r.status}`);
  return j;
}
async function jget(p: string) { const r = await fetch(`${API}${p}`); return r.json(); }

async function main() {
  if (!RECV) throw new Error("set RECV_PARTY to an onboarded participant-managed party");
  const user = privateKeyToAccount(norm(process.env.USER_PRIVATE_KEY!));
  const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
  const w = createWalletClient({ account: user, chain: baseSepolia, transport: http(RPC) });
  const wbtcUnits = parseUnits("0.0001", 8);
  const now = Math.floor(Date.now() / 1000);
  const id = "0xr3e2e" + Date.now();

  console.log(`\n=== R3 hands-off participant-managed swap ===`);
  console.log(`user EVM ${user.address} → receiver ${RECV.slice(0, 28)}…\n`);

  // 1. create order
  await jpost("/api/htlc", {
    id, direction: "evm-to-canton", hashLock: H,
    userEvmAddress: user.address, solverEvmAddress: SOLVER_EVM,
    wbtcAmount: wbtcUnits.toString(), userTimelock: now + 14400,
    userCantonParty: RECV, solverCantonParty: SOLVER_CANTON,
    cbtcAmount: "0.0001", solverTimelock: now + 10800,
  });
  await jpost(`/api/htlc/${id}/accept`);
  console.log("[1] order created + accepted");

  // 2. real WBTC lock (the user's MetaMask action)
  const wbtc = getContract({ address: WBTC, abi: ERC20, client: { public: pub, wallet: w } });
  const apv = await wbtc.write.approve([ESCROW, wbtcUnits * 5n], { account: user, chain: null });
  await pub.waitForTransactionReceipt({ hash: apv });
  const escrow = getContract({ address: ESCROW, abi: HTLC_ESCROW_ABI, client: { public: pub, wallet: w } });
  const lockTx = await escrow.write.lock([H, BigInt(now + 14400), wbtcUnits, WBTC, SOLVER_EVM as Address], { account: user, chain: null });
  await pub.waitForTransactionReceipt({ hash: lockTx });
  await jpost(`/api/htlc/${id}/main-lock`, { mainLockTx: lockTx });
  console.log(`[2] WBTC locked on-chain (tx ${lockTx.slice(0, 14)}…) → status main_locked`);

  // 3. wait for the DAEMON to auto-lock the cBTC counter
  console.log("[3] waiting for the daemon to lock the cBTC counter…");
  let locked = false;
  for (let i = 0; i < 30; i++) {
    await sleep(3000);
    const { order } = await jget(`/api/htlc/${id}`);
    if (order?.status === "counter_locked") { locked = true; console.log("    ✓ daemon locked the cBTC counter (allocate + HtlcLock)"); break; }
    if (order?.status === "counter_claimed" || order?.status === "main_claimed") { locked = true; break; }
  }
  if (!locked) throw new Error("daemon did not lock the counter — is the daemon running with R3 code?");

  // 4. claim-managed (backend signs the cBTC claim via CanActAs — the user's "Claim")
  console.log("[4] claim-managed: backend claims cBTC for the user (CanActAs)…");
  const claim = await jpost(`/api/htlc/${id}/claim-managed`, { preimage: PRE });
  console.log(`    ✓ cBTC claimed on-ledger (updateId ${String(claim.updateId).slice(0, 14)}…)`);

  // 5. wait for the DAEMON to claim the WBTC on EVM
  console.log("[5] waiting for the daemon to claim the WBTC on EVM…");
  let done = false;
  for (let i = 0; i < 30; i++) {
    await sleep(3000);
    const { order } = await jget(`/api/htlc/${id}`);
    if (order?.status === "main_claimed") { done = true; console.log(`    ✓ daemon claimed WBTC (tx ${String(order.mainClaimTx).slice(0, 14)}…)`); break; }
  }
  if (!done) throw new Error("daemon did not claim the WBTC");

  console.log(`\n✅✅ R3 COMPLETE — hands-off participant-managed swap. User signed ONE thing (the WBTC lock).`);
  console.log(`   Daemon: locked cBTC + claimed WBTC. Backend: claimed cBTC for the user. cBTC delivered to ${RECV.slice(0, 20)}….`);
}

main().catch((e) => { console.error("\n[r3-e2e] FAILED:", e instanceof Error ? e.message : e); process.exit(1); });

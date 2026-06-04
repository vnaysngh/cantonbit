/**
 * REFUND / EXPIRY E2E — the user safety valve, LIVE on Base Sepolia.
 *   node --import tsx src/e2e-refund.ts
 *
 * Proves the path that protects the USER when a solver never delivers:
 *   1. Base: user openFor → WBTC locked in the escrow (short expiry)
 *   2. Solver does NOTHING (no deliver, no finalise) — simulates a stalled solver
 *   3. Wait until order.expires passes
 *   4. refund(order) → the locked WBTC returns to order.user
 *
 * This is Canton-free on purpose: refund is a pure Base-side guarantee. It was
 * proven in Foundry (EscrowReleasePath.t.sol) but never on a live network — this
 * is that live drill.
 *
 * Cost: tiny. Uses a short expiry so we don't wait hours. fillDeadline < expires
 * is required by the escrow (_validateFillDeadlineBeforeExpiry), so both are set
 * small with fillDeadline strictly before expires.
 */

import {
  createWalletClient, createPublicClient, http, getContract, parseAbi, pad,
  type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import assert from "node:assert/strict";

import { ESCROW_ABI, ORDER_STATUS } from "./abi.js";
import { signOpenFor, PERMIT2_ADDRESS } from "./open-for.js";
import { cantonPartyToRecipient } from "./order.js";
import type { StandardOrder } from "./encoding.js";

const RECIPIENT = "8f5ca108eb208e8826f868952ede00a5::12200fe103931833a6cb6f080dff41df997dbb9abd8d06384e6405434a04efcf8e2b";
const WBTC_LOCK = 1n * 10n ** 4n; // 0.0001 WBTC (8dp)

// Short windows so the test runs in minutes, not hours.
const EXPIRES_IN = 120;       // order.expires = now + 120s
const FILL_DEADLINE_IN = 60;  // fillDeadline = now + 60s (must be < expires)

function env(k: string): string { const v = process.env[k]; if (!v) throw new Error(`missing env ${k}`); return v; }
function key(): Hex { const r = env("PRIVATE_KEY"); return (r.startsWith("0x") ? r : `0x${r}`) as Hex; }
const log = (s: string) => console.log(`\n=== ${s} ===`);
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const RPC = process.env.ORIGIN_RPC_URL ?? "https://sepolia.base.org";
  const escrow = env("ESCROW_ADDRESS") as Address;
  const oracle = env("ORACLE_ADDRESS") as Address;
  const wbtc = env("WBTC_ADDRESS") as Address;

  const account = privateKeyToAccount(key());
  const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(RPC) });
  const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
  const chainId = await pub.getChainId();

  const balOf = async (who: Address) => (await pub.readContract({ address: wbtc, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [who] })) as bigint;
  const waitBal = async (who: Address, want: bigint, label: string) => { for (let i = 0; i < 25; i++) { if ((await balOf(who)) === want) return; await sleep(1500); } throw new Error(`${label}: ${who} balance never reached ${want}`); };

  const summary: Record<string, string> = {};

  // === 1. Base: user openFor locks WBTC (short expiry) ===
  log("1. BASE: user locks WBTC via openFor (short expiry)");
  const allowance = (await pub.readContract({ address: wbtc, abi: parseAbi(["function allowance(address,address) view returns (uint256)"]), functionName: "allowance", args: [account.address, PERMIT2_ADDRESS] })) as bigint;
  if (allowance < 10n ** 18n) await pub.waitForTransactionReceipt({ hash: await getContract({ address: wbtc, abi: parseAbi(["function approve(address,uint256) returns (bool)"]), client: wallet }).write.approve([PERMIT2_ADDRESS, 2n ** 256n - 1n]) });
  if ((await balOf(account.address)) < WBTC_LOCK) {
    // MockWBTC only — on mainnet the user already holds real WBTC.
    await pub.waitForTransactionReceipt({ hash: await getContract({ address: wbtc, abi: parseAbi(["function mint(address,uint256)"]), client: wallet }).write.mint([account.address, WBTC_LOCK]) }).catch(() => { throw new Error("user has no WBTC and token is not mintable"); });
  }

  const now = Math.floor(Date.now() / 1000);
  const expires = now + EXPIRES_IN;
  const order: StandardOrder = {
    user: account.address, nonce: BigInt(now), originChainId: BigInt(chainId),
    expires, fillDeadline: now + FILL_DEADLINE_IN, inputOracle: oracle,
    inputs: [[BigInt(wbtc), WBTC_LOCK]],
    outputs: [{
      oracle: pad(oracle, { size: 32 }), settler: pad("0xca470", { size: 32 }),
      chainId: 1_000_000_000_000_001n, token: pad("0xc87c", { size: 32 }),
      amount: WBTC_LOCK, recipient: cantonPartyToRecipient(RECIPIENT),
      callbackData: "0x", context: "0x",
    }],
  };
  const sig = await signOpenFor({ account, order, escrow, chainId });
  const escrowC = getContract({ address: escrow, abi: ESCROW_ABI, client: wallet });
  const userStart = await balOf(account.address);
  const escrowBefore = await balOf(escrow);
  const openTx = await escrowC.write.openFor([order, account.address, sig]);
  await pub.waitForTransactionReceipt({ hash: openTx });
  await waitBal(escrow, escrowBefore + WBTC_LOCK, "lock");
  const orderId = (await escrowC.read.orderIdentifier([order])) as Hex;
  console.log(`WBTC locked ✓  openFor tx: ${openTx}`);
  console.log(`orderId: ${orderId}  expires in ${EXPIRES_IN}s`);
  summary["1. openFor (Base)"] = openTx;
  summary["orderId"] = orderId;

  // status should be Deposited
  const stAfterOpen = Number(await escrowC.read.orderStatus([orderId]));
  assert.equal(stAfterOpen, ORDER_STATUS.Deposited, `expected Deposited after open, got ${stAfterOpen}`);
  console.log("orderStatus = Deposited ✓");

  // === 2. Solver does nothing — refund before expiry must REVERT ===
  log("2. NEGATIVE: refund() before expiry must revert");
  let revertedEarly = false;
  try {
    await escrowC.simulate.refund([order]);
  } catch {
    revertedEarly = true;
  }
  assert.ok(revertedEarly, "refund BEFORE expiry should have reverted but did not");
  console.log("refund before expiry correctly reverts ✓");

  // === 3. Wait past expiry ===
  log("3. WAIT: until order.expires passes");
  while (Math.floor(Date.now() / 1000) <= expires) {
    process.stdout.write(`  waiting for expiry… ${expires - Math.floor(Date.now() / 1000)}s left\r`);
    await sleep(3000);
  }
  // chain time can lag wall-clock slightly; give the block timestamp a moment
  await sleep(3000);
  console.log("\nexpiry passed ✓");

  // === 4. refund(order) → WBTC returns to user ===
  log("4. REFUND: user reclaims the locked WBTC");
  const refundTx = await escrowC.write.refund([order]);
  await pub.waitForTransactionReceipt({ hash: refundTx });
  await waitBal(account.address, userStart, "refund"); // back to where we started
  console.log(`WBTC refunded ✓  refund tx: ${refundTx}`);
  summary["4. refund (Base)"] = refundTx;

  const stAfterRefund = Number(await escrowC.read.orderStatus([orderId]));
  assert.equal(stAfterRefund, ORDER_STATUS.Refunded, `expected Refunded, got ${stAfterRefund}`);
  console.log("orderStatus = Refunded ✓");

  // === 5. Double-refund must revert (idempotency / no drain) ===
  log("5. NEGATIVE: second refund() must revert");
  let doubleReverted = false;
  try { await escrowC.simulate.refund([order]); } catch { doubleReverted = true; }
  assert.ok(doubleReverted, "second refund should have reverted but did not");
  console.log("double refund correctly reverts ✓");

  console.log(`\n\n========== ✓ REFUND / EXPIRY E2E PASSED ==========`);
  for (const [k, v] of Object.entries(summary)) console.log(`  ${k.padEnd(20)} ${v}`);
  console.log(`==================================================`);
}

main().catch((e) => { console.error("\n✗ REFUND E2E FAILED:", e instanceof Error ? e.message : e); process.exit(1); });

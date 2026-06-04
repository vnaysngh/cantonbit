/**
 * Proves the REFUND ENDPOINT end-to-end against the live API + chain:
 *   1. open a short-expiry order on Base (via openFor, browser-style signature)
 *   2. register it in the API store with the SHORT expiry (so we don't wait 24h)
 *   3. wait past expiry
 *   4. POST /orders/:id/refund → API submits refund() on-chain
 *   5. assert WBTC returned to the user + order marked refunded
 *
 *   node --env-file=../.env.local --env-file=.env --import tsx src/api-refund.smoke.ts
 *
 * This exercises the user-facing "Refund my WBTC" button's backend.
 */

import {
  createPublicClient, createWalletClient, http, getContract, parseAbi, pad,
  hashTypedData, type Hex, type Address,
} from "viem";
import { privateKeyToAccount, sign } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import assert from "node:assert/strict";

import { ESCROW_ABI } from "./abi.js";
import { buildOpenForTypedData, PERMIT2_ADDRESS } from "./open-for.js";
import { cantonPartyToRecipient } from "./order.js";
import { OrderStore } from "./store.js";
import { serializeOrder } from "./convert.js";
import type { StandardOrder } from "./encoding.js";

const API = process.env.API_BASE ?? "http://localhost:8787";
const STORE_PATH = process.env.STORE_PATH ?? ".oranj-swap/orders.json";
const RECIPIENT = "8f5ca108eb208e8826f868952ede00a5::12200fe103931833a6cb6f080dff41df997dbb9abd8d06384e6405434a04efcf8e2b";
const WBTC_LOCK = 1n * 10n ** 4n; // 0.0001
const EXPIRES_IN = 90, FILL_IN = 45;

function key(): Hex { const r = process.env.PRIVATE_KEY!; return (r.startsWith("0x") ? r : `0x${r}`) as Hex; }
function env(k: string): string { const v = process.env[k]; if (!v) throw new Error(`missing ${k}`); return v; }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const RPC = process.env.ORIGIN_RPC_URL ?? "https://sepolia.base.org";
  const escrow = env("ESCROW_ADDRESS") as Address;
  const oracle = env("ORACLE_ADDRESS") as Address;
  const wbtc = env("WBTC_ADDRESS") as Address;
  const account = privateKeyToAccount(key());
  const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
  const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(RPC) });
  const chainId = await pub.getChainId();

  const balOf = async (a: Address) => (await pub.readContract({ address: wbtc, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [a] })) as bigint;

  // ensure funds + allowance
  if ((await balOf(account.address)) < WBTC_LOCK) await pub.waitForTransactionReceipt({ hash: await getContract({ address: wbtc, abi: parseAbi(["function mint(address,uint256)"]), client: wallet }).write.mint([account.address, WBTC_LOCK]) });
  const allowance = (await pub.readContract({ address: wbtc, abi: parseAbi(["function allowance(address,address) view returns (uint256)"]), functionName: "allowance", args: [account.address, PERMIT2_ADDRESS] })) as bigint;
  if (allowance < WBTC_LOCK) await pub.waitForTransactionReceipt({ hash: await getContract({ address: wbtc, abi: parseAbi(["function approve(address,uint256) returns (bool)"]), client: wallet }).write.approve([PERMIT2_ADDRESS, 2n ** 256n - 1n]) });

  // === 1. build a SHORT-expiry order ===
  const now = Math.floor(Date.now() / 1000);
  const order: StandardOrder = {
    user: account.address, nonce: BigInt(now), originChainId: BigInt(chainId),
    expires: now + EXPIRES_IN, fillDeadline: now + FILL_IN, inputOracle: oracle,
    inputs: [[BigInt(wbtc), WBTC_LOCK]],
    outputs: [{
      oracle: pad(oracle, { size: 32 }), settler: pad("0xca470", { size: 32 }),
      chainId: 1_000_000_000_000_001n, token: pad("0xc87c", { size: 32 }),
      amount: WBTC_LOCK, recipient: cantonPartyToRecipient(RECIPIENT),
      callbackData: "0x", context: "0x",
    }],
  };

  // sign (browser-style raw sig; API prepends 0x00)
  const typed = buildOpenForTypedData({ order, escrow, chainId });
  const digest = hashTypedData({
    domain: typed.domain,
    types: typed.types,
    primaryType: typed.primaryType,
    message: typed.message,
  } as Parameters<typeof hashTypedData>[0]);
  const s = await sign({ hash: digest, privateKey: key() });
  const rawSig = (s.r + s.s.slice(2) + (s.v === 27n ? "1b" : "1c")) as Hex;

  // === 2. open directly + register in the store with the SHORT expiry ===
  console.log("=== 1. lock WBTC (openFor) with short expiry ===");
  const escrowC = getContract({ address: escrow, abi: ESCROW_ABI, client: wallet });
  const userStart = await balOf(account.address);
  const sigPrefixed = ("0x00" + rawSig.slice(2)) as Hex;
  const openTx = await escrowC.write.openFor([order, account.address, sigPrefixed]);
  await pub.waitForTransactionReceipt({ hash: openTx });
  const orderId = (await escrowC.read.orderIdentifier([order])) as Hex;
  console.log(`locked ✓ order ${orderId}`);

  const store = new OrderStore(STORE_PATH);
  const block = await pub.getBlockNumber().catch(() => 0n);
  store.insertSeen(orderId, Number(block), serializeOrder(order));
  store.update(orderId, { cantonParty: RECIPIENT, note: "refund-smoke" });

  // === 3. wait past expiry ===
  console.log(`=== 2. wait ${EXPIRES_IN}s for expiry ===`);
  while (Math.floor(Date.now() / 1000) <= now + EXPIRES_IN) {
    process.stdout.write(`  ${now + EXPIRES_IN - Math.floor(Date.now() / 1000)}s left\r`);
    await sleep(3000);
  }
  await sleep(4000); // chain-time slack
  console.log("\nexpired ✓");

  // === 4. POST /refund ===
  console.log("=== 3. POST /orders/:id/refund ===");
  const res = await fetch(`${API}/orders/${orderId}/refund`, { method: "POST" });
  const out = await res.json() as { refundTx?: string; status?: string; error?: string };
  console.log("response:", res.status, JSON.stringify(out));
  assert.equal(res.status, 200, `refund failed: ${out.error}`);
  assert.equal(out.status, "refunded");
  assert.ok(out.refundTx, "no refundTx");

  // === 5. assert WBTC back ===
  for (let i = 0; i < 20; i++) { if ((await balOf(account.address)) >= userStart) break; await sleep(1500); }
  assert.ok((await balOf(account.address)) >= userStart, "WBTC not returned");
  console.log(`\n✓ REFUND ENDPOINT PROVEN — WBTC returned, refundTx ${out.refundTx}`);
}

main().catch((e) => { console.error("\n✗ FAILED:", e instanceof Error ? e.message : e); process.exit(1); });

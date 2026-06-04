/**
 * Proves the BROWSER signing path end-to-end against the live API + chain:
 *   1. POST /quote  → get order + permit2 typed data
 *   2. sign the typed data the way a wallet's eth_signTypedData_v4 does — i.e.
 *      hash the FULL typed data WITH EIP712Domain in `types` (the fix), produce
 *      a raw 65-byte sig (NO 0x00 prefix — the API adds it)
 *   3. POST /orders → API prepends 0x00 + submits openFor on Base
 *   4. assert it does NOT revert InvalidSigner / SignatureNotSupported
 *
 * Uses the agent key as the "user" so it has WBTC + can be funded. This is the
 * exact path the /swap page takes, minus the actual MetaMask popup.
 *
 *   node --env-file=../.env.local --env-file=.env --import tsx src/api-sign.smoke.ts
 */

import {
  createPublicClient, createWalletClient, http, getContract, parseAbi,
  hashTypedData, type Hex, type Address,
} from "viem";
import { privateKeyToAccount, sign } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import assert from "node:assert/strict";

import { PERMIT2_ADDRESS } from "./open-for.js";

const API = process.env.API_BASE ?? "http://localhost:8787";
const RECIPIENT = "8f5ca108eb208e8826f868952ede00a5::12200fe103931833a6cb6f080dff41df997dbb9abd8d06384e6405434a04efcf8e2b";

function key(): Hex { const r = process.env.PRIVATE_KEY!; return (r.startsWith("0x") ? r : `0x${r}`) as Hex; }

async function main() {
  const account = privateKeyToAccount(key());
  const RPC = process.env.ORIGIN_RPC_URL ?? "https://sepolia.base.org";
  const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
  const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(RPC) });

  // === 1. quote ===
  console.log("=== 1. POST /quote ===");
  const q = await (await fetch(`${API}/quote`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ user: account.address, wbtcAmount: "10000", cantonParty: RECIPIENT }),
  })).json() as any;
  assert.ok(q.orderId, "no orderId");
  console.log("orderId:", q.orderId);

  // ensure user has WBTC + permit2 allowance (a real user would already)
  const wbtc = q.wbtc as Address;
  const bal = await pub.readContract({ address: wbtc, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [account.address] }) as bigint;
  if (bal < 10000n) await pub.waitForTransactionReceipt({ hash: await getContract({ address: wbtc, abi: parseAbi(["function mint(address,uint256)"]), client: wallet }).write.mint([account.address, 10000n]) });
  const allowance = await pub.readContract({ address: wbtc, abi: parseAbi(["function allowance(address,address) view returns (uint256)"]), functionName: "allowance", args: [account.address, PERMIT2_ADDRESS] }) as bigint;
  if (allowance < 10000n) await pub.waitForTransactionReceipt({ hash: await getContract({ address: wbtc, abi: parseAbi(["function approve(address,uint256) returns (bool)"]), client: wallet }).write.approve([PERMIT2_ADDRESS, 2n ** 256n - 1n]) });

  // === 2. sign EXACTLY like the browser (raw v4 hash WITH EIP712Domain) ===
  console.log("=== 2. sign (browser eth_signTypedData_v4 path) ===");
  const typesWithDomain = {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
    ...q.permit2.types,
  };
  // hashTypedData reproduces what a wallet hashes for eth_signTypedData_v4.
  const digest = hashTypedData({
    domain: q.permit2.domain,
    types: typesWithDomain,
    primaryType: q.permit2.primaryType,
    message: q.permit2.message,
  });
  const sigObj = await sign({ hash: digest, privateKey: key() });
  // serialize to a raw 65-byte 0x sig (r||s||v), NO type prefix — API adds 0x00.
  const rawSig = (sigObj.r + sigObj.s.slice(2) + (sigObj.v === 27n ? "1b" : "1c")) as Hex;
  assert.equal(rawSig.length - 2, 130, "raw sig must be 65 bytes");
  console.log("raw sig (65 bytes), API will prepend 0x00 ✓");

  // === 3. submit ===
  console.log("=== 3. POST /orders ===");
  const res = await fetch(`${API}/orders`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ order: q.order, signature: rawSig, cantonParty: RECIPIENT }),
  });
  const out = await res.json() as any;
  console.log("status", res.status, JSON.stringify(out));

  // === 4. assert openFor succeeded ===
  assert.equal(res.status, 201, `expected 201, got ${res.status}: ${out.error ?? ""}`);
  assert.ok(out.openTx, "no openTx — openFor did not submit");
  console.log(`\n✓ openFor SUCCEEDED via browser-style signature. tx: ${out.openTx}`);
  console.log(`✓ orderId ${out.orderId} registered as '${out.status}'`);
  console.log("\n========== ✓ BROWSER SIGNING PATH PROVEN ==========");
}

main().catch((e) => { console.error("\n✗ FAILED:", e instanceof Error ? e.message : e); process.exit(1); });

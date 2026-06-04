/**
 * Base Sepolia E2E — the full WBTC-side loop against the LIVE deployed
 * contracts, with the Canton delivery simulated (we mark `delivered` directly).
 *
 *   node --import tsx src/e2e-base.ts
 *
 * Proves on real testnet: user signs Permit2 → openFor locks WBTC → watcher
 * sees it → (Canton delivery simulated) → Settler attests + finalises → WBTC
 * released. Records every tx hash.
 *
 * This is the happy path minus the live Canton leg (which needs DevNet float +
 * a user accept). It validates everything that touches Base on real infra.
 */

import { createWalletClient, createPublicClient, http, getContract, parseAbi, pad, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { readFileSync, rmSync } from "node:fs";
import assert from "node:assert/strict";

import { ESCROW_ABI } from "./abi.js";
import { OrderStore, type SerializedOrder } from "./store.js";
import { OpenWatcher } from "./watcher.js";
import { signOpenFor, PERMIT2_ADDRESS } from "./open-for.js";
import { Settler } from "./settle.js";
import type { StandardOrder } from "./encoding.js";

function env(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
}
function key(): Hex {
  const raw = env("PRIVATE_KEY");
  return (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
}

async function main() {
  const RPC = process.env.ORIGIN_RPC_URL ?? "https://sepolia.base.org";
  const escrow = env("ESCROW_ADDRESS") as Address;
  const oracle = env("ORACLE_ADDRESS") as Address;
  const wbtc = env("WBTC_ADDRESS") as Address;
  const startBlock = BigInt(env("ESCROW_START_BLOCK"));

  const account = privateKeyToAccount(key());
  const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(RPC) });
  const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
  const chainId = await pub.getChainId();
  console.log(`actor ${account.address} on chain ${chainId}`);

  const balOf = async (who: Address) =>
    (await pub.readContract({ address: wbtc, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [who] })) as bigint;

  // Public RPCs are load-balanced and eventually-consistent: a read right after
  // a confirmed write can hit a lagging node. Poll until the balance reaches the
  // expected value (or time out) instead of asserting on a single stale read.
  const waitForBalance = async (who: Address, expected: bigint, label: string) => {
    for (let i = 0; i < 20; i++) {
      if ((await balOf(who)) === expected) return;
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error(`${label}: balance of ${who} never reached ${expected}`);
  };

  // ensure permit2 approval (one-time max)
  const mock = getContract({ address: wbtc, abi: parseAbi(["function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)"]), client: wallet });
  const allowance = (await pub.readContract({ address: wbtc, abi: parseAbi(["function allowance(address,address) view returns (uint256)"]), functionName: "allowance", args: [account.address, PERMIT2_ADDRESS] })) as bigint;
  if (allowance < 10n ** 18n) {
    console.log("approving Permit2…");
    await pub.waitForTransactionReceipt({ hash: await mock.write.approve([PERMIT2_ADDRESS, 2n ** 256n - 1n]) });
  }

  // build + sign + openFor
  const LOCK = 1n * 10n ** 4n; // 0.0001 WBTC
  const now = Math.floor(Date.now() / 1000);
  const order: StandardOrder = {
    user: account.address,
    nonce: BigInt(now),
    originChainId: BigInt(chainId),
    expires: now + 6 * 3600,
    fillDeadline: now + 3 * 3600,
    inputOracle: oracle,
    inputs: [[BigInt(wbtc), LOCK]],
    outputs: [
      {
        oracle: pad(oracle, { size: 32 }),
        settler: pad("0xca470", { size: 32 }),
        chainId: 1_000_000_000_000_002n, // testnet canton id
        token: pad("0xc87c", { size: 32 }),
        amount: LOCK,
        recipient: pad("0x44", { size: 32 }), // would be keccak(cantonParty) in prod
        callbackData: "0x",
        context: "0x",
      },
    ],
  };
  const sig = await signOpenFor({ account, order, escrow, chainId });
  const escrowC = getContract({ address: escrow, abi: ESCROW_ABI, client: wallet });
  const beforeEscrow = await balOf(escrow);
  console.log("submitting openFor…");
  const openTx = await escrowC.write.openFor([order, account.address, sig]);
  await pub.waitForTransactionReceipt({ hash: openTx });
  console.log(`openFor tx: ${openTx}`);
  await waitForBalance(escrow, beforeEscrow + LOCK, "lock");
  console.log("WBTC locked in escrow ✓");

  // watcher sees it
  const storePath = "/tmp/oranj-e2e-base.json";
  rmSync(storePath, { force: true });
  const store = new OrderStore(storePath);
  await new OpenWatcher({ rpcUrl: RPC, escrow, startBlock }, store, () => {}).backfill();
  const orderId = (await escrowC.read.orderIdentifier([order])) as Hex;
  assert.ok(store.has(orderId), "watcher should have decoded the order");
  console.log(`watcher saw order ${orderId}`);

  // SIMULATE Canton delivery: mark delivered with a fill timestamp <= fillDeadline.
  store.update(orderId, { status: "delivered", fillTimestamp: now, cantonParty: "cbtc-user-sim::1220", cantonDeliveryRef: "sim-offer" });
  console.log("(simulated Canton delivery — marked delivered)");

  // settle: attest + finalise on the LIVE oracle + escrow
  const settler = new Settler({ rpcUrl: RPC, escrow, oracle, account });
  const beforeUser = await balOf(account.address);
  const outcome = await settler.settleOne(store, orderId);
  console.log("settle outcome:", outcome);
  assert.equal(outcome.kind, "finalised", "should finalise");

  await waitForBalance(account.address, beforeUser + LOCK, "release");
  console.log("WBTC released back to actor ✓");
  console.log(`\n✓ BASE E2E PASSED on Base Sepolia`);
  console.log(`  openFor:  ${openTx}`);
  if (outcome.kind === "finalised") {
    console.log(`  attest:   ${outcome.attestTxHash}`);
    console.log(`  finalise: ${outcome.finaliseTxHash}`);
  }
  rmSync(storePath, { force: true });
}

main().catch((e) => { console.error("✗ BASE E2E FAILED:", e); process.exit(1); });

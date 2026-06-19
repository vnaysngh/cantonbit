#!/usr/bin/env npx tsx
/**
 * Devnet smoke: all managed (email) swap paths — C2C both directions + HTLC forward/reverse.
 *
 *   bash scripts/with-env.sh devnet npx tsx scripts/smoke-managed-swaps-devnet.mts
 *
 * Optional:
 *   AUDIT_USER_CANTON_PARTY=party-…
 *   TEST_C2C_CBTC=0.0001   TEST_C2C_CC=50
 *   TEST_HTLC_CBTC=0.0001
 *   SMOKE_SKIP_HTLC=1      (C2C only)
 *   SMOKE_SKIP_C2C=1       (HTLC only — retry after C2C passed)
 */
import { config as loadEnv } from "dotenv";
import Module from "node:module";
import { randomUUID } from "node:crypto";

import {
  createPublicClient,
  createWalletClient,
  getContract,
  http,
  parseUnits,
  type Address,
  type Hex
} from "../swap-solver/node_modules/viem/index.js";
import { privateKeyToAccount } from "../swap-solver/node_modules/viem/accounts/index.js";
import { baseSepolia } from "../swap-solver/node_modules/viem/chains/index.js";

loadEnv({ path: "swap-solver/.env.htlc-devnet" });

const origRequire = Module.prototype.require;
Module.prototype.require = function (id: string, ...rest: unknown[]) {
  if (id === "server-only") return {};
  return origRequire.call(this, id, ...rest);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const user =
  process.env.AUDIT_USER_CANTON_PARTY?.trim() ||
  "party-de08bc18-d724-4acb-a653-d4383cd82df5::1220231c1885f289f90e0d08b448579c31a655b5826802c6d885258a27371039fba9";
const solver =
  process.env.CANTON_SWAP_SETTLEMENT_PARTY?.trim() ||
  process.env.NEXT_PUBLIC_CANTON_SWAP_SETTLEMENT_PARTY?.trim() ||
  process.env.SOLVER_CANTON_PARTY?.trim() ||
  process.env.NEXT_PUBLIC_SOLVER_CANTON?.trim() ||
  "";
const c2cCbtc = process.env.TEST_C2C_CBTC?.trim() || "0.0001";
const c2cCc = process.env.TEST_C2C_CC?.trim() || "50";
const htlcCbtc = process.env.TEST_HTLC_CBTC?.trim() || "0.0001";
const skipHtlc = process.env.SMOKE_SKIP_HTLC === "1";
const skipC2c = process.env.SMOKE_SKIP_C2C === "1";
const skipHtlcForward = process.env.SMOKE_SKIP_HTLC_FORWARD === "1";
const skipHtlcReverse = process.env.SMOKE_SKIP_HTLC_REVERSE === "1";

type Result = { name: string; pass: boolean; detail: string; ms: number };

const results: Result[] = [];

async function runCase(name: string, fn: () => Promise<string>) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, pass: true, detail, ms: Date.now() - t0 });
    console.log(`PASS | ${name} | ${detail} (${Date.now() - t0}ms)`);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    results.push({ name, pass: false, detail, ms: Date.now() - t0 });
    console.error(`FAIL | ${name} | ${detail} (${Date.now() - t0}ms)`);
  }
}

async function preflight() {
  const { expectedCantonSwapParty } = await import("../lib/htlc-auth.js");
  const { getAmuletBalance, getHoldings } = await import("../lib/canton.js");
  const vault = expectedCantonSwapParty();
  if (!vault) throw new Error("CANTON_SWAP_SETTLEMENT_PARTY not set");
  if (!solver) throw new Error("CANTON_SWAP_SETTLEMENT_PARTY not set");

  const cc = await getAmuletBalance(user);
  const holdings = await getHoldings(user);
  const cbtc = holdings.reduce(
    (s, h) => s + Number.parseFloat(String(h.payload?.amount ?? "0")),
    0
  );
  console.log("preflight:", {
    user: `${user.slice(0, 28)}…`,
    vault: `${vault.slice(0, 28)}…`,
    solver: `${solver.slice(0, 28)}…`,
    ccBalance: cc,
    cbtcBalance: cbtc.toFixed(8),
    networkFee: process.env.NETWORK_FEE_ENABLED
  });
  if (Number.parseFloat(cc) < 20) {
    console.warn("WARN: low CC — CC→CBTC or fee legs may fail");
  }
  if (cbtc < Number.parseFloat(c2cCbtc)) {
    throw new Error(`user CBTC ${cbtc} < test amount ${c2cCbtc}`);
  }
}

async function smokeC2c(fromAsset: "CBTC" | "CC", toAsset: "CBTC" | "CC") {
  const { quoteMvpCantonSwap } = await import("../lib/canton-swap-quote.js");
  const { cantonSwapService } = await import("../lib/canton-swap-service.js");
  const amount = fromAsset === "CC" ? c2cCc : c2cCbtc;
  const q = await quoteMvpCantonSwap(fromAsset, toAsset, amount);
  const order = await cantonSwapService().submitManaged({
    fromAsset,
    toAsset,
    inAmount: q.inAmount,
    outAmount: q.outAmount,
    userParty: user,
    orderId: `smoke-c2c-${fromAsset}-${randomUUID().slice(0, 8)}`
  });
  if (order.status !== "filled") {
    throw new Error(`expected filled, got ${order.status}`);
  }
  return `order=${order.id.slice(0, 12)}… ${fromAsset}→${toAsset} in=${order.inAmount} out=${order.outAmount}`;
}

function evmEnv() {
  const pk =
    process.env.SOLVER_EVM_PK?.trim() ||
    process.env.PRIVATE_KEY?.trim() ||
    process.env.DEVNET_LOOP_PRIVATE_KEY?.trim();
  if (!pk) throw new Error("SOLVER_EVM_PK missing (swap-solver/.env.htlc-devnet)");
  const rpc = process.env.ORIGIN_RPC_URL?.trim() || "https://sepolia.base.org";
  const wbtc = (process.env.WBTC_ADDRESS || process.env.NEXT_PUBLIC_WBTC_ADDRESS || "").trim();
  const escrow = (
    process.env.HTLC_ESCROW_ADDRESS || process.env.NEXT_PUBLIC_HTLC_ESCROW || ""
  ).trim();
  const solverEvm = (
    process.env.SOLVER_EVM || process.env.NEXT_PUBLIC_SOLVER_EVM || ""
  ).trim();
  if (!wbtc || !escrow || !solverEvm) {
    throw new Error("WBTC / HTLC escrow / SOLVER_EVM env missing");
  }
  const account = privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`) as Hex);
  const pub = createPublicClient({ chain: baseSepolia, transport: http(rpc) });
  const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(rpc) });
  return { account, pub, wallet, wbtc, escrow, solverEvm, rpc };
}

async function bindHtlcFee(direction: "evm-to-canton" | "canton-to-evm", cbtc: string) {
  const { isNetworkFeeEnabled } = await import("../lib/canton-network-fee-math.js");
  if (!isNetworkFeeEnabled()) {
    return { networkFeeCc: undefined, networkFeeExpiresAt: undefined };
  }
  const { estimateHtlcManagedFee } = await import("../lib/canton-network-fee.js");
  const { computeHtlcSwapNotionalUsd } = await import("../lib/canton-network-fee.js");
  const { QUOTE_TTL_SECONDS } = await import("../lib/htlc-quote.js");
  const action = direction === "canton-to-evm" ? "htlc-lock" : "htlc-claim";
  const nf = await estimateHtlcManagedFee({
    action,
    userParty: user,
    solverParty: solver,
    cbtcAmount: cbtc,
    notionalUsd: await computeHtlcSwapNotionalUsd(cbtc)
  });
  return {
    networkFeeCc: nf.feeCc,
    networkFeeExpiresAt: Math.floor(Date.now() / 1000) + QUOTE_TTL_SECONDS
  };
}

async function smokeHtlcForward() {
  const { generateSecret, secretToPreimage } = await import("../lib/htlc-client.js");
  const { quoteWbtcToCbtc } = await import("../lib/htlc-quote.js");
  const { timelocksFromExpiration, DEFAULT_EXPIRATION_SECONDS } = await import(
    "../lib/htlc-timelock.js"
  );
  const { htlcService } = await import("../lib/htlc-service-singleton.js");
  const evm = evmEnv();

  const { secret, hashLock } = generateSecret();
  const preimage = secretToPreimage(secret);
  const now = Math.floor(Date.now() / 1000);
  const { userTimelock, solverTimelock } = timelocksFromExpiration(
    now,
    DEFAULT_EXPIRATION_SECONDS
  );
  const wbtcUnits = parseUnits(htlcCbtc, 8);
  const q = await quoteWbtcToCbtc(wbtcUnits);
  const outCbtc = (Number(q.outUnits) / 1e8).toFixed(8);
  const fee = await bindHtlcFee("evm-to-canton", outCbtc);
  const orderId = `smoke-fwd-${randomUUID().slice(0, 8)}`;

  await htlcService().createOrder({
    id: orderId,
    direction: "evm-to-canton",
    hashLock: hashLock as `0x${string}`,
    userTimelock,
    solverTimelock,
    userCantonParty: user,
    solverCantonParty: solver,
    userEvmAddress: evm.account.address,
    solverEvmAddress: evm.solverEvm,
    wbtcAmount: wbtcUnits.toString(),
    cbtcAmount: outCbtc,
    counterMode: "managed",
    networkFeeCc: fee.networkFeeCc,
    networkFeeExpiresAt: fee.networkFeeExpiresAt,
    createdAt: Date.now()
  });
  await htlcService().accept(orderId);

  const ERC20_ABI = [
    {
      type: "function",
      name: "approve",
      stateMutability: "nonpayable",
      inputs: [
        { name: "s", type: "address" },
        { name: "a", type: "uint256" }
      ],
      outputs: [{ type: "bool" }]
    }
  ] as const;
  const HTLC_ABI = [
    {
      type: "function",
      name: "lock",
      stateMutability: "nonpayable",
      inputs: [
        { name: "hashValue", type: "bytes32" },
        { name: "unlockTime", type: "uint64" },
        { name: "amount", type: "uint256" },
        { name: "token", type: "address" },
        { name: "receiver", type: "address" }
      ],
      outputs: []
    }
  ] as const;

  const wbtc = getContract({
    address: evm.wbtc as Address,
    abi: ERC20_ABI,
    client: { public: evm.pub, wallet: evm.wallet }
  });
  const escrow = getContract({
    address: evm.escrow as Address,
    abi: HTLC_ABI,
    client: { public: evm.pub, wallet: evm.wallet }
  });
  const approveTx = await wbtc.write.approve([evm.escrow, wbtcUnits * 10n], {
    account: evm.account,
    chain: null
  });
  await evm.pub.waitForTransactionReceipt({ hash: approveTx });
  const lockTx = await escrow.write.lock(
    [
      hashLock as `0x${string}`,
      BigInt(userTimelock),
      wbtcUnits,
      evm.wbtc as Address,
      evm.solverEvm as Address
    ],
    { account: evm.account, chain: null }
  );
  await evm.pub.waitForTransactionReceipt({ hash: lockTx });

  await htlcService().recordMainLock(orderId, lockTx);
  await sleep(3000);
  await htlcService().lockCounter(orderId);
  const { order } = await htlcService().claimCounterAsBackend(orderId, preimage);
  if (order.status !== "counter_claimed") {
    throw new Error(`expected counter_claimed, got ${order.status}`);
  }
  return `order=${orderId} wbtc=${htlcCbtc} cbtc=${outCbtc} status=${order.status}`;
}

async function smokeHtlcReverse() {
  const { generateSecret, secretToPreimage } = await import("../lib/htlc-client.js");
  const { quoteCbtcToWbtc } = await import("../lib/htlc-quote.js");
  const { timelocksFromExpiration, DEFAULT_EXPIRATION_SECONDS } = await import(
    "../lib/htlc-timelock.js"
  );
  const { htlcService } = await import("../lib/htlc-service-singleton.js");
  const evm = evmEnv();

  const { secret, hashLock } = generateSecret();
  const preimage = secretToPreimage(secret);
  const now = Math.floor(Date.now() / 1000);
  const { userTimelock, solverTimelock } = timelocksFromExpiration(
    now,
    DEFAULT_EXPIRATION_SECONDS
  );
  const cbtcUnits = parseUnits(htlcCbtc, 8);
  const q = await quoteCbtcToWbtc(cbtcUnits);
  const wbtcOut = q.outUnits;
  const fee = await bindHtlcFee("canton-to-evm", htlcCbtc);
  const orderId = `smoke-rev-${randomUUID().slice(0, 8)}`;

  await htlcService().createOrder({
    id: orderId,
    direction: "canton-to-evm",
    hashLock: hashLock as `0x${string}`,
    userTimelock,
    solverTimelock,
    userCantonParty: user,
    solverCantonParty: solver,
    userEvmAddress: evm.account.address,
    solverEvmAddress: evm.solverEvm,
    wbtcAmount: wbtcOut.toString(),
    cbtcAmount: htlcCbtc,
    counterMode: "managed",
    networkFeeCc: fee.networkFeeCc,
    networkFeeExpiresAt: fee.networkFeeExpiresAt,
    createdAt: Date.now()
  });
  await htlcService().accept(orderId);

  const locked = await htlcService().lockMainCanton(orderId);
  if (locked.status !== "main_locked" || !locked.htlcCid) {
    throw new Error(`lock-main failed: ${locked.status}`);
  }

  const HTLC_ABI = [
    {
      type: "function",
      name: "lock",
      stateMutability: "nonpayable",
      inputs: [
        { name: "hashValue", type: "bytes32" },
        { name: "unlockTime", type: "uint64" },
        { name: "amount", type: "uint256" },
        { name: "token", type: "address" },
        { name: "receiver", type: "address" }
      ],
      outputs: []
    },
    {
      type: "function",
      name: "claim",
      stateMutability: "nonpayable",
      inputs: [{ name: "preImage", type: "bytes" }],
      outputs: []
    }
  ] as const;
  const ERC20_ABI = [
    {
      type: "function",
      name: "approve",
      stateMutability: "nonpayable",
      inputs: [
        { name: "s", type: "address" },
        { name: "a", type: "uint256" }
      ],
      outputs: [{ type: "bool" }]
    }
  ] as const;

  const wbtc = getContract({
    address: evm.wbtc as Address,
    abi: ERC20_ABI,
    client: { public: evm.pub, wallet: evm.wallet }
  });
  const escrow = getContract({
    address: evm.escrow as Address,
    abi: HTLC_ABI,
    client: { public: evm.pub, wallet: evm.wallet }
  });

  const approveTx = await wbtc.write.approve([evm.escrow, wbtcOut * 10n], {
    account: evm.account,
    chain: null
  });
  await evm.pub.waitForTransactionReceipt({ hash: approveTx });
  const counterLockTx = await escrow.write.lock(
    [
      hashLock as `0x${string}`,
      BigInt(solverTimelock),
      wbtcOut,
      evm.wbtc as Address,
      evm.account.address
    ],
    { account: evm.account, chain: null }
  );
  await evm.pub.waitForTransactionReceipt({ hash: counterLockTx });

  const { verifyReverseCounterLockTx } = await import("../lib/htlc-evm-counter-lock.js");
  await verifyReverseCounterLockTx(counterLockTx, {
    hashLock: hashLock as `0x${string}`,
    wbtcAmount: wbtcOut.toString(),
    userEvmAddress: evm.account.address,
    solverTimelock,
    expectedWbtcAddress: evm.wbtc
  });
  const { readEvmLockMapping } = await import("../lib/htlc-evm-counter-lock.js");
  const onChain = await readEvmLockMapping(hashLock as `0x${string}`);
  if (onChain.amount !== wbtcOut) {
    throw new Error(
      `EVM locks() amount mismatch after counter-lock (${onChain.amount} != ${wbtcOut})`
    );
  }

  await htlcService().recordCounterLocked(orderId, counterLockTx);

  const bytes = preimage.startsWith("0x") ? preimage.slice(2) : preimage;
  const claimTx = await escrow.write.claim([`0x${bytes}` as Hex], {
    account: evm.account,
    chain: null
  });
  await evm.pub.waitForTransactionReceipt({ hash: claimTx });
  await htlcService().recordCounterClaimed(orderId, preimage, claimTx);

  const { order } = await htlcService().claimMainAsSolver(orderId, preimage);
  if (order.status !== "main_claimed") {
    throw new Error(`expected main_claimed, got ${order.status}`);
  }
  return `order=${orderId} cbtc=${htlcCbtc} status=${order.status}`;
}

async function main() {
  console.log("\n=== Managed swap smoke (devnet) ===\n");
  await preflight();

  if (!skipC2c) {
    await runCase("C2C managed CBTC→CC", () => smokeC2c("CBTC", "CC"));
    await runCase("C2C managed CC→CBTC", () => smokeC2c("CC", "CBTC"));
  }

  if (!skipHtlc) {
    if (!skipHtlcForward) {
      await runCase("HTLC managed EVM→Canton (WBTC→CBTC)", () => smokeHtlcForward());
    }
    if (!skipHtlcReverse) {
      await runCase("HTLC managed Canton→EVM (CBTC→WBTC)", () => smokeHtlcReverse());
    }
  }

  console.log("\n=== Summary ===\n");
  for (const r of results) {
    console.log(`${r.pass ? "PASS" : "FAIL"} | ${r.name} | ${r.detail} (${r.ms}ms)`);
  }
  const failed = results.filter((r) => !r.pass);
  if (failed.length) {
    console.log(`\n${failed.length}/${results.length} failed.`);
    process.exit(1);
  }
  console.log(`\nAll ${results.length} managed swap smoke tests passed.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

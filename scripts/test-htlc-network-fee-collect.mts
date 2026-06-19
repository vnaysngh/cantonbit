#!/usr/bin/env npx tsx
/**
 * Live E2E: managed HTLC cross-chain swaps with NETWORK_FEE_ENABLED — verify CC fee collection.
 *
 *   AUDIT_USER_CANTON_PARTY='party-…' bash scripts/with-env.sh devnet npx tsx scripts/test-htlc-network-fee-collect.mts
 *
 * Env:
 *   TEST_HTLC_CBTC=0.001          (~$100 notional — passes 250 bps guard)
 *   TEST_HTLC_DIRECTION=both|forward|reverse
 *   SOLVER_EVM_PK                   from swap-solver/.env.htlc-devnet (auto-loaded)
 */
import { config as loadEnv } from "dotenv";
import Module from "node:module";
import { randomUUID } from "node:crypto";

loadEnv({ path: "swap-solver/.env.htlc-devnet" });
import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  type Address,
  type Hex
} from "../swap-solver/node_modules/viem/index.js";
import { privateKeyToAccount } from "../swap-solver/node_modules/viem/accounts/index.js";
import { baseSepolia } from "../swap-solver/node_modules/viem/chains/index.js";

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
  process.env.SOLVER_CANTON_PARTY?.trim() ||
  process.env.NEXT_PUBLIC_SOLVER_CANTON?.trim() ||
  "";
const cbtcAmount = process.env.TEST_HTLC_CBTC?.trim() || "0.001";
const directionFilter =
  process.env.TEST_HTLC_DIRECTION?.trim().toLowerCase() || "both";

async function fetchLedgerRow(orderId: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const r = await fetch(
    `${url}/rest/v1/network_fee_ledger?order_id=eq.${encodeURIComponent(orderId)}&order_kind=eq.htlc&select=*`,
    {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      cache: "no-store"
    }
  );
  if (!r.ok) return null;
  const rows = (await r.json()) as Record<string, unknown>[];
  return rows[0] ?? null;
}

function evmEnv() {
  const pk =
    process.env.SOLVER_EVM_PK?.trim() ||
    process.env.PRIVATE_KEY?.trim() ||
    process.env.DEVNET_LOOP_PRIVATE_KEY?.trim();
  if (!pk) {
    throw new Error(
      "SOLVER_EVM_PK (or PRIVATE_KEY) required for EVM legs — see swap-solver/.env.htlc-devnet"
    );
  }
  const rpc =
    process.env.ORIGIN_RPC_URL?.trim() || "https://sepolia.base.org";
  const wbtc = (
    process.env.WBTC_ADDRESS ||
    process.env.NEXT_PUBLIC_WBTC_ADDRESS ||
    ""
  ).trim() as Address;
  const escrow = (
    process.env.HTLC_ESCROW_ADDRESS ||
    process.env.NEXT_PUBLIC_HTLC_ESCROW ||
    ""
  ).trim() as Address;
  const solverEvm = (
    process.env.SOLVER_EVM ||
    process.env.NEXT_PUBLIC_SOLVER_EVM ||
    ""
  ).trim();
  if (!wbtc || !escrow || !solverEvm) {
    throw new Error("WBTC + HTLC escrow + SOLVER_EVM env required");
  }
  const account = privateKeyToAccount(
    (pk.startsWith("0x") ? pk : `0x${pk}`) as Hex
  );
  const pub = createPublicClient({ chain: baseSepolia, transport: http(rpc) });
  const wallet = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(rpc)
  });
  return { account, pub, wallet, wbtc, escrow, solverEvm, rpc };
}

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
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "o", type: "address" },
      { name: "s", type: "address" }
    ],
    outputs: [{ type: "uint256" }]
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
  },
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [{ name: "preImage", type: "bytes" }],
    outputs: []
  }
] as const;

async function lockWbtc(params: {
  hashLock: `0x${string}`;
  unlockTime: number;
  wbtcUnits: bigint;
  receiver: Address;
}) {
  const evm = evmEnv();
  const { getContract } = await import("../swap-solver/node_modules/viem/index.js");
  const wbtc = getContract({
    address: evm.wbtc,
    abi: ERC20_ABI,
    client: { public: evm.pub, wallet: evm.wallet }
  });
  const escrow = getContract({
    address: evm.escrow,
    abi: HTLC_ABI,
    client: { public: evm.pub, wallet: evm.wallet }
  });
  const approveTx = await wbtc.write.approve([evm.escrow, params.wbtcUnits * 10n], {
    account: evm.account,
    chain: null
  });
  await evm.pub.waitForTransactionReceipt({ hash: approveTx });
  const lockTx = await escrow.write.lock(
    [params.hashLock, BigInt(params.unlockTime), params.wbtcUnits, evm.wbtc, params.receiver],
    { account: evm.account, chain: null }
  );
  await evm.pub.waitForTransactionReceipt({ hash: lockTx });
  return lockTx;
}

async function claimWbtc(preimageHex: string) {
  const evm = evmEnv();
  const { getContract } = await import("../swap-solver/node_modules/viem/index.js");
  const escrow = getContract({
    address: evm.escrow,
    abi: HTLC_ABI,
    client: { public: evm.pub, wallet: evm.wallet }
  });
  const bytes = preimageHex.startsWith("0x") ? preimageHex.slice(2) : preimageHex;
  const claimTx = await escrow.write.claim([`0x${bytes}` as Hex], {
    account: evm.account,
    chain: null
  });
  await evm.pub.waitForTransactionReceipt({ hash: claimTx });
  return claimTx;
}

async function bindNetworkFee(params: {
  direction: "evm-to-canton" | "canton-to-evm";
  userParty: string;
  cbtc: string;
}) {
  const {
    estimateHtlcManagedFee,
    computeHtlcSwapNotionalUsd
  } = await import("../lib/canton-network-fee.js");
  const { QUOTE_TTL_SECONDS } = await import("../lib/htlc-quote.js");
  const action = params.direction === "canton-to-evm" ? "htlc-lock" : "htlc-claim";
  const notionalUsd = await computeHtlcSwapNotionalUsd(params.cbtc);
  const nf = await estimateHtlcManagedFee({
    action,
    userParty: params.userParty,
    solverParty: solver,
    cbtcAmount: params.cbtc,
    notionalUsd
  });
  return {
    networkFeeCc: nf.feeCc,
    networkFeeExpiresAt: Math.floor(Date.now() / 1000) + QUOTE_TTL_SECONDS,
    estimate: nf
  };
}

async function assertFeeCollected(params: {
  label: string;
  orderId: string;
  boundFeeCc: string;
  receiverBefore: string;
  receiverAfter: string;
}) {
  const ledger = await fetchLedgerRow(params.orderId);
  const collectedCc =
    ledger?.fee_cc != null ? String(ledger.fee_cc) : "";
  const collectedNum = Number.parseFloat(collectedCc);
  const boundNum = Number.parseFloat(params.boundFeeCc);
  const receiverDelta =
    Number.parseFloat(params.receiverAfter) - Number.parseFloat(params.receiverBefore);
  const ledgerOk = ledger != null && collectedNum > 0;
  const boundOk = collectedNum <= boundNum * 1.001;
  const receiverGotOk = receiverDelta >= collectedNum * 0.99;

  console.log(`\n=== ${params.label} collection audit ===`);
  console.log(
    JSON.stringify(
      {
        orderId: params.orderId,
        boundFeeCc: params.boundFeeCc,
        collectedFeeCc: collectedCc,
        receiverCcDelta: receiverDelta.toFixed(6),
        ledgerRow: ledger
          ? { fee_cc: ledger.fee_cc, settlement_update_id: ledger.settlement_update_id }
          : null
      },
      null,
      2
    )
  );

  if (!ledgerOk) throw new Error(`${params.label}: network_fee_ledger row missing`);
  if (!boundOk) {
    throw new Error(
      `${params.label}: collected fee ${collectedCc} CC exceeds bound ${params.boundFeeCc} CC`
    );
  }
  if (!receiverGotOk) {
    throw new Error(
      `${params.label}: fee receiver CC did not increase by bound fee (${receiverDelta} vs ${feeNum})`
    );
  }
  console.log(`PASS: ${params.label} — fee collected (ledger + receiver CC inflow)`);
}

async function testForwardEvmToCanton() {
  const { generateSecret, secretToPreimage } = await import("../lib/htlc-client.js");
  const { quoteWbtcToCbtc } = await import("../lib/htlc-quote.js");
  const { timelocksFromExpiration, DEFAULT_EXPIRATION_SECONDS } = await import(
    "./../lib/htlc-timelock.js"
  );
  const { htlcService } = await import("../lib/htlc-service-singleton.js");
  const { getAmuletBalance } = await import("../lib/canton.js");
  const { networkFeeReceiverParty } = await import("../lib/canton-network-fee-math.js");
  const evm = evmEnv();

  const { secret, hashLock } = generateSecret();
  const preimage = secretToPreimage(secret);
  const now = Math.floor(Date.now() / 1000);
  const { userTimelock, solverTimelock } = timelocksFromExpiration(
    now,
    DEFAULT_EXPIRATION_SECONDS
  );

  const wbtcUnits = parseUnits(cbtcAmount, 8);
  const q = await quoteWbtcToCbtc(wbtcUnits);
  const outCbtc = (Number(q.outUnits) / 1e8).toFixed(8);

  const fee = await bindNetworkFee({
    direction: "evm-to-canton",
    userParty: user,
    cbtc: outCbtc
  });

  const orderId = `nf-htlc-fwd-${randomUUID().slice(0, 8)}`;
  console.log("\n--- Forward EVM→Canton ---");
  console.log({ orderId, wbtcIn: cbtcAmount, cbtcOut: outCbtc, networkFeeCc: fee.networkFeeCc });

  const receiverBefore = await getAmuletBalance(networkFeeReceiverParty());

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

  const lockTx = await lockWbtc({
    hashLock: hashLock as `0x${string}`,
    unlockTime: userTimelock,
    wbtcUnits,
    receiver: evm.solverEvm as Address
  });
  await htlcService().recordMainLock(orderId, lockTx);
  await sleep(3000);
  await htlcService().lockCounter(orderId);

  const { order, updateId } = await htlcService().claimCounterAsBackend(
    orderId,
    preimage
  );
  console.log("claim:", { status: order.status, updateId: updateId.slice(0, 18) });

  const receiverAfter = await getAmuletBalance(networkFeeReceiverParty());
  await assertFeeCollected({
    label: "HTLC forward (fee on claim)",
    orderId,
    boundFeeCc: fee.networkFeeCc,
    receiverBefore,
    receiverAfter
  });
}

async function testReverseCantonToEvm() {
  const { generateSecret, secretToPreimage } = await import("../lib/htlc-client.js");
  const { quoteCbtcToWbtc } = await import("../lib/htlc-quote.js");
  const { timelocksFromExpiration, DEFAULT_EXPIRATION_SECONDS } = await import(
    "./../lib/htlc-timelock.js"
  );
  const { htlcService } = await import("../lib/htlc-service-singleton.js");
  const { getAmuletBalance } = await import("../lib/canton.js");
  const { networkFeeReceiverParty } = await import("../lib/canton-network-fee-math.js");
  const evm = evmEnv();

  const { secret, hashLock } = generateSecret();
  const preimage = secretToPreimage(secret);
  const now = Math.floor(Date.now() / 1000);
  const { userTimelock, solverTimelock } = timelocksFromExpiration(
    now,
    DEFAULT_EXPIRATION_SECONDS
  );

  const cbtcUnits = parseUnits(cbtcAmount, 8);
  const q = await quoteCbtcToWbtc(cbtcUnits);
  const wbtcOut = q.outUnits;

  const fee = await bindNetworkFee({
    direction: "canton-to-evm",
    userParty: user,
    cbtc: cbtcAmount
  });

  const orderId = `nf-htlc-rev-${randomUUID().slice(0, 8)}`;
  console.log("\n--- Reverse Canton→EVM ---");
  console.log({ orderId, cbtcIn: cbtcAmount, wbtcOut: wbtcOut.toString(), networkFeeCc: fee.networkFeeCc });

  const receiverBefore = await getAmuletBalance(networkFeeReceiverParty());

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
    cbtcAmount: cbtcAmount,
    counterMode: "managed",
    networkFeeCc: fee.networkFeeCc,
    networkFeeExpiresAt: fee.networkFeeExpiresAt,
    createdAt: Date.now()
  });
  await htlcService().accept(orderId);

  const locked = await htlcService().lockMainCanton(orderId);
  console.log("lock-main:", {
    status: locked.status,
    allocationCid: locked.allocationCid?.slice(0, 18),
    htlcCid: locked.htlcCid?.slice(0, 18)
  });

  const receiverAfterLock = await getAmuletBalance(networkFeeReceiverParty());
  await assertFeeCollected({
    label: "HTLC reverse (fee on lock-main)",
    orderId,
    boundFeeCc: fee.networkFeeCc,
    receiverBefore,
    receiverAfter: receiverAfterLock
  });

  // Complete cross-chain leg: solver WBTC lock → user EVM claim → solver Canton claim
  const counterLockTx = await lockWbtc({
    hashLock: hashLock as `0x${string}`,
    unlockTime: solverTimelock,
    wbtcUnits: wbtcOut,
    receiver: evm.account.address
  });
  await htlcService().recordCounterLocked(orderId, counterLockTx);
  const claimTx = await claimWbtc(preimage);
  await htlcService().recordCounterClaimed(orderId, preimage, claimTx);
  const { order } = await htlcService().claimMainAsSolver(orderId, preimage);
  console.log("full reverse swap complete:", { status: order.status, evmClaim: claimTx.slice(0, 18) });
}

async function main() {
  const { isNetworkFeeEnabled } = await import("../lib/canton-network-fee-math.js");
  if (!isNetworkFeeEnabled()) {
    throw new Error("NETWORK_FEE_ENABLED must be 1 for this test");
  }
  if (!solver) throw new Error("SOLVER_CANTON_PARTY missing");

  const runForward = directionFilter === "both" || directionFilter === "forward";
  const runReverse = directionFilter === "both" || directionFilter === "reverse";

  if (runForward) await testForwardEvmToCanton();
  if (runReverse) await testReverseCantonToEvm();

  console.log("\nAll HTLC network-fee collection tests passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

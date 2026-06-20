#!/usr/bin/env npx tsx
/**
 * Devnet smoke: Loop wallet — C2C both directions + HTLC cross-chain both directions.
 * Verifies delivery to respective parties and Loop HTLC network fee collection.
 *
 *   bash scripts/with-env.sh devnet npx tsx scripts/smoke-loop-swaps-devnet.mts
 *
 * Requires in .env.devnet:
 *   DEVNET_LOOP_PRIVATE_KEY
 *   CANTON_SWAP_SETTLEMENT_PARTY
 *   NETWORK_FEE_ENABLED=1
 *
 * Requires swap-solver/.env.htlc-devnet with SOLVER_EVM_PK for EVM legs.
 *
 * Optional:
 *   DEVNET_LOOP_PARTY / DEVNET_LOOP_PARTY_ID
 *   TEST_C2C_CBTC=0.0001   TEST_C2C_CC=50   TEST_HTLC_CBTC=0.0001
 *   SMOKE_SKIP_C2C=1   SMOKE_SKIP_HTLC=1
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

const c2cCbtc = process.env.TEST_C2C_CBTC?.trim() || "0.0001";
const c2cCc = process.env.TEST_C2C_CC?.trim() || "50";
const htlcCbtc = process.env.TEST_HTLC_CBTC?.trim() || "0.0001";
const skipC2c = process.env.SMOKE_SKIP_C2C === "1";
const skipHtlc = process.env.SMOKE_SKIP_HTLC === "1";

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

async function fetchFeeLedger(orderId: string) {
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
    process.env.AGENT_PRIVATE_KEY?.trim();
  if (!pk) {
    throw new Error("SOLVER_EVM_PK required in swap-solver/.env.htlc-devnet");
  }
  const rpc = process.env.ORIGIN_RPC_URL?.trim() || "https://sepolia.base.org";
  const wbtc = (
    process.env.WBTC_ADDRESS || process.env.NEXT_PUBLIC_WBTC_ADDRESS || ""
  ).trim();
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

async function preflight(loopParty: string, solver: string) {
  const { readLoopCbtcBalance, readLoopCcBalance } = await import(
    "../lib/loop-holdings.js"
  );
  const { connectLoopServer, ensureLoopGasPaid } = await import(
    "../lib/loop-server-signer.js"
  );
  const { sdk, provider } = await connectLoopServer();
  await ensureLoopGasPaid(sdk);
  const cbtc = await readLoopCbtcBalance(provider);
  const cc = await readLoopCcBalance(provider);
  console.log("preflight:", {
    loopParty: `${loopParty.slice(0, 28)}…`,
    solver: `${solver.slice(0, 28)}…`,
    cbtc: cbtc.total,
    cc,
    networkFee: process.env.NETWORK_FEE_ENABLED
  });
  if (Number.parseFloat(cbtc.total) < Number.parseFloat(c2cCbtc)) {
    throw new Error(`Loop CBTC ${cbtc.total} < test amount ${c2cCbtc}`);
  }
  if (Number.parseFloat(cc) < 20) {
    console.warn("WARN: low Loop CC — fee legs may fail");
  }
}

async function loopCtx() {
  const { connectLoopServer, loopSubmitAndWait } = await import(
    "../lib/loop-server-signer.js"
  );
  const { listLoopCcHoldingCids, listLoopCbtcHoldingCids } = await import(
    "../lib/loop-holdings.js"
  );
  const { sdk, provider, partyId } = await connectLoopServer();
  return {
    sdk,
    provider,
    partyId,
    ccCids: () => listLoopCcHoldingCids(provider),
    cbtcCids: () => listLoopCbtcHoldingCids(provider),
    submit: (payload: import("../lib/loop-server-signer.js").LoopSubmitPayload) =>
      loopSubmitAndWait(sdk, partyId, payload)
  };
}

async function assetHoldingCids(
  loop: Awaited<ReturnType<typeof loopCtx>>,
  asset: "CBTC" | "CC"
): Promise<string[]> {
  return asset === "CC" ? loop.ccCids() : loop.cbtcCids();
}

async function smokeC2c(fromAsset: "CBTC" | "CC", toAsset: "CBTC" | "CC") {
  const loop = await loopCtx();
  const { quoteMvpCantonSwap } = await import("../lib/canton-swap-quote.js");
  const { cantonSwapService } = await import("../lib/canton-swap-service.js");
  const { readLoopInstrumentBalance } = await import("../lib/loop-holdings.js");
  const { CC_ASSET, getSwapAsset } = await import("../lib/canton-assets.js");
  const { resolveSwapInstrumentId } = await import("../lib/canton-swap-holdings.js");

  const amount = fromAsset === "CC" ? c2cCc : c2cCbtc;
  const q = await quoteMvpCantonSwap(fromAsset, toAsset, amount);
  const outAsset = getSwapAsset(toAsset);
  const inInst =
    fromAsset === "CC"
      ? CC_ASSET.instrumentId
      : await resolveSwapInstrumentId(fromAsset);
  const outInst =
    toAsset === "CC"
      ? CC_ASSET.instrumentId
      : await resolveSwapInstrumentId(toAsset);

  const beforeIn = await readLoopInstrumentBalance(loop.provider, inInst);
  const beforeOut = await readLoopInstrumentBalance(loop.provider, outInst);

  const order = await cantonSwapService().createOrder({
    fromAsset,
    toAsset,
    inAmount: q.inAmount,
    outAmount: q.outAmount,
    userParty: loop.partyId,
    walletMode: "loop",
    orderId: `smoke-loop-c2c-${fromAsset}-${randomUUID()}`
  });
  if (order.status !== "open") {
    throw new Error(`expected open, got ${order.status}`);
  }

  const prep = await cantonSwapService().prepareUserLeg(order.id, {
    inputHoldingCids: await assetHoldingCids(loop, fromAsset)
  });
  const submit = await loop.submit({
    commands: [prep.command],
    disclosedContracts: prep.disclosedContracts,
    synchronizerId: prep.synchronizerId
  });
  const locked = await cantonSwapService().confirmUserLeg(order.id, {
    submitUpdateId: submit.updateId || undefined
  });
  if (locked.status !== "user_locked") {
    throw new Error(`expected user_locked, got ${locked.status}`);
  }

  const filled = await cantonSwapService().fillLoop(order.id);
  if (filled.status === "user_locked" && filled.counterLegOfferCid) {
    const acceptPrep = await (
      await import("../lib/transfer.js")
    ).prepareAcceptCommand({
      offerContractId: filled.counterLegOfferCid,
      registrarAdmin: await (
        await import("../lib/canton-swap-holdings.js")
      ).registrarAdminForAsset(toAsset),
      registryKind: (await import("../lib/canton-swap-holdings.js")).registryKindForAsset(
        toAsset
      )
    });
    await loop.submit({
      commands: [acceptPrep.command],
      disclosedContracts: acceptPrep.disclosedContracts,
      synchronizerId: acceptPrep.synchronizerId
    });
    await cantonSwapService().markCounterAccepted(order.id);
  }

  const final = await cantonSwapService().must(order.id);
  if (final.status !== "filled") {
    throw new Error(`expected filled, got ${final.status}`);
  }

  await sleep(3000);
  const afterIn = await readLoopInstrumentBalance(loop.provider, inInst);
  const afterOut = await readLoopInstrumentBalance(loop.provider, outInst);
  const inDelta =
    Number.parseFloat(beforeIn.total) - Number.parseFloat(afterIn.total);
  const outDelta =
    Number.parseFloat(afterOut.total) - Number.parseFloat(beforeOut.total);
  if (inDelta + 1e-9 < Number.parseFloat(amount) * 0.99) {
    throw new Error(`input not debited enough: delta ${inDelta} expected ~${amount}`);
  }
  if (outDelta + 1e-9 < Number.parseFloat(q.outAmount) * 0.99) {
    throw new Error(
      `output not credited enough: delta ${outDelta} expected ~${q.outAmount}`
    );
  }

  return `order=${final.id.slice(0, 16)}… ${fromAsset}→${toAsset} inΔ=${inDelta.toFixed(8)} outΔ=${outDelta.toFixed(outAsset.decimals)}`;
}

async function bindLoopHtlcFee(
  direction: "evm-to-canton" | "canton-to-evm",
  cbtc: string
) {
  const { isNetworkFeeEnabled } = await import("../lib/canton-network-fee-math.js");
  if (!isNetworkFeeEnabled()) {
    return { networkFeeCc: undefined, networkFeeExpiresAt: undefined };
  }
  const { estimateHtlcLoopFee } = await import("../lib/canton-network-fee.js");
  const { computeHtlcSwapNotionalUsd } = await import("../lib/canton-network-fee.js");
  const { QUOTE_TTL_SECONDS } = await import("../lib/htlc-quote.js");
  const action =
    direction === "canton-to-evm" ? "htlc-loop-lock" : "htlc-loop-claim";
  const nf = await estimateHtlcLoopFee({
    action,
    userParty: "",
    cbtcAmount: cbtc,
    notionalUsd: await computeHtlcSwapNotionalUsd(cbtc)
  });
  return {
    networkFeeCc: nf.feeCc,
    networkFeeExpiresAt: Math.floor(Date.now() / 1000) + QUOTE_TTL_SECONDS
  };
}

async function smokeHtlcForward(_loop: Awaited<ReturnType<typeof loopCtx>>, solver: string) {
  const loop = await loopCtx();
  const { generateSecret, secretToPreimage } = await import("../lib/htlc-client.js");
  const { quoteWbtcToCbtc } = await import("../lib/htlc-quote.js");
  const { timelocksFromExpiration, DEFAULT_EXPIRATION_SECONDS } = await import(
    "../lib/htlc-timelock.js"
  );
  const { htlcService } = await import("../lib/htlc-service-singleton.js");
  const { readLoopCbtcBalance } = await import("../lib/loop-holdings.js");
  const { hasNetworkFeeLedgerEntry } = await import("../lib/network-fee-ledger.js");
  const { isNetworkFeeEnabled } = await import("../lib/canton-network-fee-math.js");
  const evm = evmEnv();

  const beforeCbtc = await readLoopCbtcBalance(loop.provider);
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
  const fee = await bindLoopHtlcFee("evm-to-canton", outCbtc);
  const orderId = `smoke-loop-fwd-${randomUUID().slice(0, 8)}`;

  await htlcService().createOrder({
    id: orderId,
    direction: "evm-to-canton",
    hashLock: hashLock as `0x${string}`,
    userTimelock,
    solverTimelock,
    userCantonParty: loop.partyId,
    solverCantonParty: solver,
    userEvmAddress: evm.account.address,
    solverEvmAddress: evm.solverEvm,
    wbtcAmount: wbtcUnits.toString(),
    cbtcAmount: outCbtc,
    counterMode: "loop",
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
    },
    {
      type: "function",
      name: "claim",
      stateMutability: "nonpayable",
      inputs: [{ name: "preImage", type: "bytes" }],
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

  if (
    isNetworkFeeEnabled() &&
    !(await hasNetworkFeeLedgerEntry(orderId, "htlc"))
  ) {
    const ccCids = await loop.ccCids();
    const feePrep = await htlcService().prepareLoopNetworkFee(orderId, ccCids);
    const { updateId: feeUpdateId } = await loop.submit({
      commands: feePrep.commands,
      disclosedContracts: feePrep.disclosedContracts,
      synchronizerId: feePrep.synchronizerId,
      actAs: feePrep.actAs
    });
    await htlcService().recordLoopNetworkFeeCollected(orderId, feeUpdateId);
  }

  const reveal = await htlcService().claimCounter(orderId, preimage);
  let claimUpdateId = reveal.updateId;
  if (!reveal.delivered) {
    const prep = await htlcService().prepareLoopAcceptWithFee(
      orderId,
      await loop.ccCids()
    );
    const { updateId } = await loop.submit({
      commands: [prep.command],
      disclosedContracts: prep.disclosedContracts,
      synchronizerId: prep.synchronizerId,
      actAs: prep.actAs
    });
    claimUpdateId = updateId;
    if (
      isNetworkFeeEnabled() &&
      !(await hasNetworkFeeLedgerEntry(orderId, "htlc"))
    ) {
      await htlcService().recordLoopNetworkFeeCollected(orderId, updateId);
    }
  }
  await htlcService().recordCounterClaimed(orderId, preimage, claimUpdateId);

  const bytes = preimage.startsWith("0x") ? preimage.slice(2) : preimage;
  const solverClaimTx = await escrow.write.claim([`0x${bytes}` as Hex], {
    account: evm.account,
    chain: null
  });
  await evm.pub.waitForTransactionReceipt({ hash: solverClaimTx });
  await htlcService().recordMainClaim(orderId, solverClaimTx);

  const final = await htlcService().getOrder(orderId);
  if (final?.status !== "main_claimed") {
    throw new Error(`expected main_claimed, got ${final?.status}`);
  }

  await sleep(3000);
  const afterCbtc = await readLoopCbtcBalance(loop.provider);
  const delta =
    Number.parseFloat(afterCbtc.total) - Number.parseFloat(beforeCbtc.total);
  if (delta + 1e-9 < Number.parseFloat(outCbtc) * 0.99) {
    throw new Error(`CBTC not delivered: delta ${delta} expected ~${outCbtc}`);
  }

  const ledger = await fetchFeeLedger(orderId);
  if (isNetworkFeeEnabled() && !ledger) {
    throw new Error("network fee ledger row missing for HTLC forward");
  }

  return `order=${orderId} cbtcΔ=${delta.toFixed(8)} fee=${ledger?.fee_cc ?? "n/a"}`;
}

async function smokeHtlcReverse(_loop: Awaited<ReturnType<typeof loopCtx>>, solver: string) {
  const loop = await loopCtx();
  const { generateSecret, secretToPreimage } = await import("../lib/htlc-client.js");
  const { quoteCbtcToWbtc } = await import("../lib/htlc-quote.js");
  const { timelocksFromExpiration, DEFAULT_EXPIRATION_SECONDS } = await import(
    "../lib/htlc-timelock.js"
  );
  const { htlcService } = await import("../lib/htlc-service-singleton.js");
  const { readLoopCbtcBalance } = await import("../lib/loop-holdings.js");
  const { hasNetworkFeeLedgerEntry } = await import("../lib/network-fee-ledger.js");
  const { isNetworkFeeEnabled } = await import("../lib/canton-network-fee-math.js");
  const evm = evmEnv();

  const beforeCbtc = await readLoopCbtcBalance(loop.provider);
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
  const fee = await bindLoopHtlcFee("canton-to-evm", htlcCbtc);
  const orderId = `smoke-loop-rev-${randomUUID().slice(0, 8)}`;

  await htlcService().createOrder({
    id: orderId,
    direction: "canton-to-evm",
    hashLock: hashLock as `0x${string}`,
    userTimelock,
    solverTimelock,
    userCantonParty: loop.partyId,
    solverCantonParty: solver,
    userEvmAddress: evm.account.address,
    solverEvmAddress: evm.solverEvm,
    wbtcAmount: wbtcOut.toString(),
    cbtcAmount: htlcCbtc,
    counterMode: "loop",
    networkFeeCc: fee.networkFeeCc,
    networkFeeExpiresAt: fee.networkFeeExpiresAt,
    createdAt: Date.now()
  });
  await htlcService().accept(orderId);

  if (
    isNetworkFeeEnabled() &&
    !(await hasNetworkFeeLedgerEntry(orderId, "htlc"))
  ) {
    const feePrep = await htlcService().prepareLoopSellerNetworkFee(
      orderId,
      await loop.ccCids()
    );
    const { updateId: feeUpdateId } = await loop.submit({
      commands: feePrep.commands,
      disclosedContracts: feePrep.disclosedContracts,
      synchronizerId: feePrep.synchronizerId,
      actAs: feePrep.actAs
    });
    await htlcService().recordLoopNetworkFeeCollected(orderId, feeUpdateId);
  }

  const cbtcCids = await loop.cbtcCids();
  if (!cbtcCids.length) throw new Error("No Loop CBTC holdings for lock");
  const prep = await htlcService().prepareLoopSellerLock(orderId, cbtcCids);
  const { updateId: lockUpdateId } = await loop.submit({
    commands: [prep.command],
    disclosedContracts: prep.disclosedContracts,
    synchronizerId: prep.synchronizerId
  });
  void lockUpdateId;

  const locked = await htlcService().confirmLoopSellerLock(orderId);
  if (locked.status !== "main_locked") {
    throw new Error(`expected main_locked, got ${locked.status}`);
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
    },
    {
      type: "function",
      name: "balanceOf",
      stateMutability: "view",
      inputs: [{ name: "a", type: "address" }],
      outputs: [{ type: "uint256" }]
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

  const wbtcBefore = (await wbtc.read.balanceOf([evm.account.address])) as bigint;
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

  const wbtcAfter = (await wbtc.read.balanceOf([evm.account.address])) as bigint;
  if (wbtcAfter - wbtcBefore < wbtcOut) {
    throw new Error("WBTC not delivered to user EVM address");
  }

  await sleep(2000);
  const afterCbtc = await readLoopCbtcBalance(loop.provider);
  const cbtcDelta =
    Number.parseFloat(beforeCbtc.total) - Number.parseFloat(afterCbtc.total);
  if (cbtcDelta + 1e-9 < Number.parseFloat(htlcCbtc) * 0.99) {
    throw new Error(`CBTC not debited: delta ${cbtcDelta} expected ~${htlcCbtc}`);
  }

  const ledger = await fetchFeeLedger(orderId);
  if (process.env.NETWORK_FEE_ENABLED === "1" && !ledger) {
    throw new Error("network fee ledger row missing for HTLC reverse");
  }

  return `order=${orderId} wbtc=${htlcCbtc} cbtcΔ=-${cbtcDelta.toFixed(8)} fee=${ledger?.fee_cc ?? "n/a"}`;
}

async function main() {
  console.log("\n=== Loop wallet smoke (devnet) ===\n");
  const { connectLoopServer } = await import("../lib/loop-server-signer.js");
  const { partyId } = await connectLoopServer();
  const solver =
    process.env.CANTON_SWAP_SETTLEMENT_PARTY?.trim() ||
    process.env.NEXT_PUBLIC_CANTON_SWAP_SETTLEMENT_PARTY?.trim() ||
    "";
  if (!solver) throw new Error("CANTON_SWAP_SETTLEMENT_PARTY not set");
  await preflight(partyId, solver);

  const loop = await loopCtx();

  if (!skipC2c) {
    await runCase("C2C Loop CBTC→CC", () => smokeC2c("CBTC", "CC"));
    await runCase("C2C Loop CC→CBTC", () => smokeC2c("CC", "CBTC"));
  }

  if (!skipHtlc) {
    await runCase("HTLC Loop EVM→Canton (WBTC→CBTC)", () =>
      smokeHtlcForward(loop, solver)
    );
    await runCase("HTLC Loop Canton→EVM (CBTC→WBTC)", () =>
      smokeHtlcReverse(loop, solver)
    );
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
  console.log(`\nAll ${results.length} Loop wallet smoke tests passed.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

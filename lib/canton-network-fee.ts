/**
 * Canton network (traffic) fee estimation, gating, and CC collection helpers.
 */
import "server-only";

import { getLedgerJwt } from "./auth";
import { getAmuletBalance, getHoldings } from "./canton";
import { isDirectTransferKind } from "./canton-swap-preapproval";
import {
  capNetworkFeeAtOrder,
  compareCcBalanceGte,
  isNetworkFeeEnabled,
  isNetworkFeeQuotePreview,
  minCcRequiredForNetworkFee,
  networkFeeBufferBps,
  networkFeeReceiverParty,
  NetworkFeeBalanceError,
  shouldQuoteNetworkFee,
  trafficBytesToFeeCc,
  type NetworkFeeTxLeg
} from "./canton-network-fee-math";
import { selectHoldingsForAmount } from "./transfer-holdings";
import { expectedSettlementParty } from "./htlc-auth";
import {
  buildAllocatePrepare,
  buildCreateHtlcLockCommand,
  prepareClaimCommand
} from "./htlc-onledger";
import {
  fetchAmuletPriceUsd,
  fetchExtraTrafficPriceUsdPerMb
} from "./canton-price-scan";
import { getSwapAsset } from "./canton-assets";
import { fetchBtcUsdReference } from "./canton-quote-sanity";
import {
  holdingsForSwapAsset,
  registrarAdminForAsset,
  registryKindForAsset,
  resolveSwapInstrumentId
} from "./canton-swap-holdings";
import type { CantonSwapMvpAssetId, CantonSwapOrder } from "./canton-swap-types";
import type { SwapOrder } from "./htlc-types";
import { managedFillActAsParties, swapParty } from "./canton-swap-types";
import { QUOTE_GRACE_SECONDS } from "./canton-swap-order-logic";
import { getDsoPartyId } from "./cc-registry";
import { NETWORK, type InstrumentId } from "./constants";
import {
  assertSameSynchronizer,
  buildAcceptExercise,
  buildTransferExercise,
  listOutgoingOffers,
  prepareLedgerCommands
} from "./transfer";

export {
  isNetworkFeeEnabled,
  isNetworkFeeQuotePreview,
  shouldQuoteNetworkFee,
  networkFeeReceiverParty,
  networkFeeBufferBps,
  minCcRequiredForNetworkFee,
  capNetworkFeeAtOrder,
  NetworkFeeBalanceError
} from "./canton-network-fee-math";

const TAG = "[canton-network-fee]";

/** USD notional for fee guardrails; undefined when reference price unavailable. */
export async function computeC2cSwapNotionalUsd(params: {
  fromAsset: CantonSwapMvpAssetId;
  inAmount: string;
}): Promise<number | undefined> {
  const amount = Number(params.inAmount);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  try {
    if (params.fromAsset === "CBTC") {
      const btcUsd = await fetchBtcUsdReference();
      return amount * btcUsd;
    }
    const ccUsd = await fetchAmuletPriceUsd();
    return amount * ccUsd;
  } catch (e) {
    console.warn(
      `${TAG} C2C notional unavailable:`,
      e instanceof Error ? e.message : e
    );
    return undefined;
  }
}

/** HTLC notional from CBTC leg (1:1 BTC). */
export async function computeHtlcSwapNotionalUsd(
  cbtcAmount: string
): Promise<number | undefined> {
  const amount = Number(cbtcAmount);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  try {
    const btcUsd = await fetchBtcUsdReference();
    return amount * btcUsd;
  } catch (e) {
    console.warn(
      `${TAG} HTLC notional unavailable:`,
      e instanceof Error ? e.message : e
    );
    return undefined;
  }
}

export type NetworkFeeSource = "prepare" | "fallback" | "disabled";

export type { NetworkFeeTxLeg } from "./canton-network-fee-math";

export interface NetworkFeeEstimate {
  feeCc: string;
  feeUsd: number;
  trafficBytes: number;
  minCcRequired: string;
  networkFeeSource: NetworkFeeSource;
  extraTrafficPriceUsdPerMb?: number;
  amuletPriceUsd?: number;
  /** Per-submit byte breakdown (charged legs sum to trafficBytes). */
  transactions?: NetworkFeeTxLeg[];
}

export class NetworkFeePrepareError extends Error {
  readonly userMessage: string;
  constructor(userMessage: string) {
    super(userMessage);
    this.name = "NetworkFeePrepareError";
    this.userMessage = userMessage;
  }
}

export interface NetworkFeeQuoteFields {
  networkFeeCc: string;
  networkFeeUsd: number;
  minCcRequired: string;
  networkFeeSource: NetworkFeeSource;
  trafficBytes: number;
  networkFeeTransactions?: NetworkFeeTxLeg[];
  /** True when NETWORK_FEE_ENABLED collects CC at settle/lock/claim. */
  networkFeeCharged: boolean;
  /** True when preview-only (estimate shown, not collected). */
  networkFeePreview: boolean;
}

export function logNetworkFeeEstimate(
  label: string,
  estimate: NetworkFeeEstimate
): void {
  console.info(
    `[network-fee] ${label}`,
    JSON.stringify({
      feeCc: estimate.feeCc,
      feeUsd: estimate.feeUsd,
      trafficBytes: estimate.trafficBytes,
      minCcRequired: estimate.minCcRequired,
      networkFeeSource: estimate.networkFeeSource,
      networkFeeCharged: isNetworkFeeEnabled(),
      networkFeePreview: isNetworkFeeQuotePreview() && !isNetworkFeeEnabled()
    })
  );
}

/** Ops-only: solver daemon counter-lock traffic (not shown in user UI). */
export interface SolverNodeTrafficLeg {
  id: "solver-allocate" | "solver-create-htlc";
  label: string;
  trafficBytes: number;
  feeCc: string;
  feeUsd: number;
}

export interface SolverNodeTrafficCost {
  context: string;
  orderId?: string;
  direction: "evm-to-canton-counter-lock";
  solverParty: string;
  userParty: string;
  cbtcAmount: string;
  legs: SolverNodeTrafficLeg[];
  totalTrafficBytes: number;
  totalFeeCc: string;
  totalFeeUsd: number;
  extraTrafficPriceUsdPerMb: number;
  amuletPriceUsd: number;
  /** List Scan price × bytes; no user fee buffer. */
  pricingNote: "list-price-no-buffer";
}

function solverLegListPrice(params: {
  trafficBytes: number;
  extraTrafficPriceUsdPerMb: number;
  amuletPriceUsd: number;
}): { feeCc: string; feeUsd: number } {
  return trafficBytesToFeeCc({
    trafficBytes: params.trafficBytes,
    extraTrafficPriceUsdPerMb: params.extraTrafficPriceUsdPerMb,
    amuletPriceUsd: params.amuletPriceUsd,
    bufferBps: 0
  });
}

/** Prepare-measured solver counter-lock bytes (allocate + optional HtlcLock create). */
export async function measureSolverCounterLockTraffic(params: {
  context: string;
  orderId?: string;
  solverParty: string;
  userParty: string;
  cbtcAmount: string;
  allocationCid?: string;
  hashLockHex?: string;
  unlockTime?: Date;
}): Promise<SolverNodeTrafficCost | null> {
  try {
    const [extraTrafficPriceUsdPerMb, amuletPriceUsd] = await Promise.all([
      fetchExtraTrafficPriceUsdPerMb(),
      fetchAmuletPriceUsd()
    ]);
    const legs: SolverNodeTrafficLeg[] = [];

    const allocatePrep = await buildHtlcClaimQuoteProxyLeg({
      userParty: params.userParty,
      solverParty: params.solverParty,
      cbtcAmount: params.cbtcAmount
    });
    const allocateBytes = await prepareTrafficBytes({
      actAs: [params.solverParty],
      commands: [allocatePrep.command],
      disclosedContracts: allocatePrep.disclosedContracts,
      synchronizerId: allocatePrep.synchronizerId || undefined,
      label: "solver-counter-allocate"
    });
    const allocPrice = solverLegListPrice({
      trafficBytes: allocateBytes,
      extraTrafficPriceUsdPerMb,
      amuletPriceUsd
    });
    legs.push({
      id: "solver-allocate",
      label: "AllocationFactory_Allocate (solver CBTC lock)",
      trafficBytes: allocateBytes,
      feeCc: allocPrice.feeCc,
      feeUsd: allocPrice.feeUsd
    });

    if (params.allocationCid && params.hashLockHex && params.unlockTime) {
      const { command, actAs } = buildCreateHtlcLockCommand({
        solverParty: params.solverParty,
        receiverParty: params.userParty,
        allocationCid: params.allocationCid,
        amountBtc: params.cbtcAmount,
        hashLock: params.hashLockHex,
        unlockTime: params.unlockTime
      });
      const createBytes = await prepareTrafficBytes({
        actAs,
        commands: [command],
        disclosedContracts: [],
        synchronizerId: allocatePrep.synchronizerId || undefined,
        label: "solver-counter-create-htlc"
      });
      const createPrice = solverLegListPrice({
        trafficBytes: createBytes,
        extraTrafficPriceUsdPerMb,
        amuletPriceUsd
      });
      legs.push({
        id: "solver-create-htlc",
        label: "Create HtlcLock",
        trafficBytes: createBytes,
        feeCc: createPrice.feeCc,
        feeUsd: createPrice.feeUsd
      });
    }

    const totalTrafficBytes = legs.reduce((s, l) => s + l.trafficBytes, 0);
    const totalPrice = solverLegListPrice({
      trafficBytes: totalTrafficBytes,
      extraTrafficPriceUsdPerMb,
      amuletPriceUsd
    });
    return {
      context: params.context,
      orderId: params.orderId,
      direction: "evm-to-canton-counter-lock",
      solverParty: params.solverParty,
      userParty: params.userParty,
      cbtcAmount: params.cbtcAmount,
      legs,
      totalTrafficBytes,
      totalFeeCc: totalPrice.feeCc,
      totalFeeUsd: totalPrice.feeUsd,
      extraTrafficPriceUsdPerMb,
      amuletPriceUsd,
      pricingNote: "list-price-no-buffer"
    };
  } catch (e) {
    console.warn(
      `[solver-node-traffic] measure failed (${params.context}):`,
      e instanceof Error ? e.message : e
    );
    return null;
  }
}

export function logSolverNodeTrafficCost(cost: SolverNodeTrafficCost): void {
  console.info("[solver-node-traffic]", JSON.stringify(cost));
}

export async function measureAndLogSolverCounterLockTraffic(
  params: Parameters<typeof measureSolverCounterLockTraffic>[0]
): Promise<void> {
  const cost = await measureSolverCounterLockTraffic(params);
  if (cost) logSolverNodeTrafficCost(cost);
}

export interface NetworkFeeCollection {
  feeCc: string;
  networkFeeSource?: NetworkFeeSource;
  trafficBytes?: number;
  feeUsd?: number;
}

let feeReceiverReady: boolean | undefined;

async function assertFeeReceiverCcPreapproval(): Promise<void> {
  if (feeReceiverReady) return;
  const receiver = networkFeeReceiverParty();
  if (!receiver) {
    throw new Error("NETWORK_FEE_RECEIVER_PARTY not configured");
  }
  const jwt = await getLedgerJwt();
  const r = await fetch(
    `${NETWORK.validatorHost}/api/validator/v0/scan-proxy/transfer-preapprovals/by-party/${encodeURIComponent(receiver)}`,
    { headers: { Authorization: `Bearer ${jwt}` }, cache: "no-store" }
  );
  const ok =
    r.ok &&
    !!((
      (await r.json().catch(() => null)) as {
        transfer_preapproval?: unknown;
      } | null
    )?.transfer_preapproval);
  if (!ok) {
    throw new Error(
      "NETWORK_FEE_RECEIVER_PARTY must have CC TransferPreapproval for direct fee collection"
    );
  }
  feeReceiverReady = true;
}

function inputHoldingCidsFromTransferCommand(command: unknown): string[] {
  const transfer = (
    command as {
      ExerciseCommand?: {
        choiceArgument?: { transfer?: { inputHoldingCids?: string[] } };
      };
    }
  )?.ExerciseCommand?.choiceArgument?.transfer;
  return transfer?.inputHoldingCids ?? [];
}

/**
 * Unified network-fee quote: business-command bytes only (+ buffer).
 * Never include the CC fee-transfer command in the meter — platform absorbs that traffic.
 */
function priceUserChargedTrafficBytes(params: {
  trafficBytes: number;
  extraTrafficPriceUsdPerMb: number;
  amuletPriceUsd: number;
}): { feeCc: string; feeUsd: number } {
  return trafficBytesToFeeCc({
    trafficBytes: params.trafficBytes,
    extraTrafficPriceUsdPerMb: params.extraTrafficPriceUsdPerMb,
    amuletPriceUsd: params.amuletPriceUsd,
    bufferBps: networkFeeBufferBps()
  });
}

const ABSORBED_FEE_COLLECTION_LEG: NetworkFeeTxLeg = {
  id: "network-fee-collection",
  label: "Fee CC transfer (platform absorbs bytes)",
  trafficBytes: 0,
  charged: false
};

export async function buildCcFeeTransferLeg(params: {
  senderParty: string;
  amountCc: string;
  memo?: string;
  /** CC UTXOs already used in the same atomic submit (e.g. CC sell offer). */
  excludeHoldingCids?: string[];
}) {
  await assertFeeReceiverCcPreapproval();
  const receiver = networkFeeReceiverParty();
  const dso = await getDsoPartyId();
  const instrumentId = { admin: dso, id: "Amulet" as const };
  let holdings = await holdingsForSwapAsset(params.senderParty, "CC");
  if (params.excludeHoldingCids?.length) {
    const exclude = new Set(params.excludeHoldingCids);
    holdings = holdings.filter((h) => !exclude.has(h.contractId));
  }
  const built = await buildTransferExercise({
    senderParty: params.senderParty,
    receiverParty: receiver,
    amount: params.amountCc,
    inputHoldings: holdings,
    instrumentId,
    registrarAdmin: dso,
    registryKind: "cc",
    assetSymbol: "CC",
    memo: params.memo ?? "OranjSwap network fee",
    expirationSeconds: 600
  });
  if (!isDirectTransferKind(built.transferKind)) {
    throw new Error(
      "network fee requires direct CC transfer — fee receiver must have TransferPreapproval"
    );
  }
  return built;
}

async function prepareTrafficBytes(params: {
  actAs: string[];
  commands: unknown[];
  disclosedContracts: Awaited<
    ReturnType<typeof buildTransferExercise>
  >["disclosedContracts"];
  synchronizerId?: string;
  label: string;
}): Promise<number> {
  const prep = await prepareLedgerCommands({
    actAs: params.actAs,
    commands: params.commands,
    disclosedContracts: params.disclosedContracts,
    synchronizerId: params.synchronizerId,
    commandId: `nf-est-${params.label}-${Date.now()}`
  });
  if (prep.totalTrafficBytes <= 0) {
    throw new NetworkFeePrepareError(
      `Could not measure Canton traffic for ${params.label} — ledger prepare returned 0 bytes`
    );
  }
  return prep.totalTrafficBytes;
}

/** Measured on WarpX devnet (per-command prepare); used when no live offer validates. */
const C2C_OFFER_FALLBACK_BYTES: Record<CantonSwapMvpAssetId, number> = {
  CBTC: 8834,
  CC: 8285
};
const C2C_ACCEPT_FALLBACK_BYTES: Record<CantonSwapMvpAssetId, number> = {
  CBTC: 5578,
  CC: 8090
};
/** HTLC quote fallbacks (devnet prepare, June 2026). */
const HTLC_CLAIM_FALLBACK_BYTES = 8545;
const HTLC_LOCK_ALLOCATE_FALLBACK_BYTES = 8910;
const HTLC_LOCK_CREATE_FALLBACK_BYTES = 3010;

function offerMatchesInstrument(
  offerInst: InstrumentId | undefined,
  want: InstrumentId
): boolean {
  if (!offerInst?.id || !offerInst.admin) return false;
  return offerInst.id === want.id && offerInst.admin === want.admin;
}

function offerExecuteBeforeMs(offer: { executeBefore?: string }): number | null {
  if (!offer.executeBefore) return null;
  const t = Date.parse(offer.executeBefore);
  return Number.isFinite(t) ? t : null;
}

async function listAcceptOfferCandidates(params: {
  userParty: string;
  vaultParty: string;
  fromAsset: CantonSwapMvpAssetId;
}): Promise<string[]> {
  const wantInstrument = await resolveSwapInstrumentId(params.fromAsset);
  const minDeadline = Date.now() + 120_000;
  const outgoing = await listOutgoingOffers(params.userParty);
  return outgoing
    .filter((o) => offerMatchesInstrument(o.instrumentId, wantInstrument))
    .filter((o) => {
      const deadline = offerExecuteBeforeMs(o);
      return deadline == null || deadline > minDeadline;
    })
    .sort((a, b) => {
      const av = a.receiver === params.vaultParty ? 0 : 1;
      const bv = b.receiver === params.vaultParty ? 0 : 1;
      return av - bv;
    })
    .map((o) => o.contractId);
}

async function measureAcceptTrafficBytes(params: {
  userParty: string;
  vaultParty: string;
  fromAsset: CantonSwapMvpAssetId;
  actAs: string[];
  synchronizerId?: string;
}): Promise<number> {
  const registrarAdmin = await registrarAdminForAsset(params.fromAsset);
  const registryKind = registryKindForAsset(params.fromAsset);
  const candidates = await listAcceptOfferCandidates({
    userParty: params.userParty,
    vaultParty: params.vaultParty,
    fromAsset: params.fromAsset
  });

  for (const offerContractId of candidates) {
    try {
      const acceptLeg = await buildAcceptExercise({
        offerContractId,
        registrarAdmin,
        registryKind
      });
      return await prepareTrafficBytes({
        actAs: params.actAs,
        commands: [acceptLeg.command],
        disclosedContracts: acceptLeg.disclosedContracts,
        synchronizerId: params.synchronizerId,
        label: "c2c-accept"
      });
    } catch {
      // Stale / expired offer in ACS, or prepare rejected — try next.
    }
  }

  return C2C_ACCEPT_FALLBACK_BYTES[params.fromAsset];
}

async function measureOfferTrafficBytes(params: {
  userParty: string;
  vaultParty: string;
  fromAsset: CantonSwapMvpAssetId;
  inAmount: string;
}): Promise<number> {
  try {
    const userLeg = await buildSwapTransferLeg({
      senderParty: params.userParty,
      receiverParty: params.vaultParty,
      assetId: params.fromAsset,
      amount: params.inAmount,
      expirationSeconds: 600
    });
    return await prepareTrafficBytes({
      actAs: [params.userParty],
      commands: [userLeg.command],
      disclosedContracts: userLeg.disclosedContracts,
      synchronizerId: userLeg.synchronizerId || undefined,
      label: "c2c-user-offer"
    });
  } catch {
    return C2C_OFFER_FALLBACK_BYTES[params.fromAsset];
  }
}

/** User-charged C2C bytes: sell offer + vault accept only (deliver + fee cmd = platform). */
async function measureUserChargedC2cTrafficBytes(params: {
  userParty: string;
  vaultParty: string;
  fromAsset: CantonSwapMvpAssetId;
  inAmount: string;
  /** Live ledger prepare (settle revalidate). Quotes use calibrated fallbacks for speed. */
  livePrepare?: boolean;
}): Promise<{ offerBytes: number; acceptBytes: number; total: number }> {
  if (!params.livePrepare) {
    const offerBytes = C2C_OFFER_FALLBACK_BYTES[params.fromAsset];
    const acceptBytes = C2C_ACCEPT_FALLBACK_BYTES[params.fromAsset];
    return { offerBytes, acceptBytes, total: offerBytes + acceptBytes };
  }
  const actAs = [params.userParty, params.vaultParty];
  const [offerBytes, acceptBytes] = await Promise.all([
    measureOfferTrafficBytes(params),
    measureAcceptTrafficBytes({
      userParty: params.userParty,
      vaultParty: params.vaultParty,
      fromAsset: params.fromAsset,
      actAs,
      synchronizerId: undefined
    })
  ]);
  return { offerBytes, acceptBytes, total: offerBytes + acceptBytes };
}

/** WarpX cannot prepare multi-command batches; sum single-command prepares. */
async function measureC2cFillTrafficBytes(params: {
  userParty: string;
  vaultParty: string;
  fromAsset: CantonSwapMvpAssetId;
  deliverLeg: Awaited<ReturnType<typeof buildSwapTransferLeg>>;
  includeFeeCommand: boolean;
  feeCc: string;
}): Promise<{ acceptBytes: number; deliverBytes: number; feeBytes: number; total: number }> {
  const actAs = [params.userParty, params.vaultParty];
  const sync = params.deliverLeg.synchronizerId || undefined;

  const acceptBytes = await measureAcceptTrafficBytes({
    userParty: params.userParty,
    vaultParty: params.vaultParty,
    fromAsset: params.fromAsset,
    actAs,
    synchronizerId: sync
  });

  const deliverBytes = await prepareTrafficBytes({
    actAs,
    commands: [params.deliverLeg.command],
    disclosedContracts: params.deliverLeg.disclosedContracts,
    synchronizerId: sync,
    label: "c2c-deliver"
  });

  let feeBytes = 0;
  if (
    params.includeFeeCommand &&
    Number.parseFloat(params.feeCc) > 0
  ) {
    try {
      const feeLeg = await buildCcFeeTransferLeg({
        senderParty: params.userParty,
        amountCc: params.feeCc
      });
      feeBytes = await prepareTrafficBytes({
        actAs,
        commands: [feeLeg.command],
        disclosedContracts: feeLeg.disclosedContracts,
        synchronizerId: sync,
        label: "c2c-fee"
      });
    } catch {
      // user may lack CC during estimate — omit fee leg bytes
    }
  }

  return {
    acceptBytes,
    deliverBytes,
    feeBytes,
    total: acceptBytes + deliverBytes + feeBytes
  };
}

async function buildHtlcLockAllocateLeg(params: {
  userParty: string;
  solverParty: string;
  cbtcAmount: string;
}) {
  const holdings = await getHoldings(params.userParty);
  if (holdings.length === 0) {
    throw new NetworkFeePrepareError(
      "Insufficient CBTC balance to prepare lock traffic estimate"
    );
  }
  const picked = selectHoldingsForAmount(holdings, params.cbtcAmount, 8, "CBTC");
  const now = Date.now();
  const settleBeforeMs = now + 24 * 60 * 60 * 1000;
  const holdingCids = picked.map((h) => h.contractId);
  return buildAllocatePrepare({
    senderParty: params.userParty,
    solverParty: params.solverParty,
    receiverParty: params.solverParty,
    amountBtc: params.cbtcAmount,
    inputHoldings: picked,
    inputHoldingCids: holdingCids,
    settlementId: `nf-probe-${now}`,
    settleBefore: new Date(settleBeforeMs),
    allocateBefore: new Date(Math.min(now + 10 * 60 * 1000, settleBeforeMs - 30_000))
  });
}

/** Forward-path quote proxy: solver counter-lock allocate (prepare succeeds without preimage). */
async function buildHtlcClaimQuoteProxyLeg(params: {
  userParty: string;
  solverParty: string;
  cbtcAmount: string;
}) {
  const holdings = await getHoldings(params.solverParty);
  if (holdings.length === 0) {
    throw new NetworkFeePrepareError(
      "Solver has no CBTC holdings to prepare claim traffic proxy"
    );
  }
  const picked = selectHoldingsForAmount(holdings, params.cbtcAmount, 8, "CBTC");
  const now = Date.now();
  const settleBeforeMs = now + 24 * 60 * 60 * 1000;
  const holdingCids = picked.map((h) => h.contractId);
  return buildAllocatePrepare({
    senderParty: params.solverParty,
    solverParty: params.solverParty,
    receiverParty: params.userParty,
    amountBtc: params.cbtcAmount,
    inputHoldings: picked,
    inputHoldingCids: holdingCids,
    settlementId: `nf-claim-proxy-${now}`,
    settleBefore: new Date(settleBeforeMs),
    allocateBefore: new Date(Math.min(now + 10 * 60 * 1000, settleBeforeMs - 30_000))
  });
}

async function prepareHtlcClaimChargedSubmit(params: {
  userParty: string;
  solverParty: string;
  cbtcAmount: string;
  htlcCid?: string;
  allocationCid?: string;
  htlcBlob?: string;
  preimageHex?: string;
  includeFeeCommand: boolean;
  extraTrafficPriceUsdPerMb: number;
  amuletPriceUsd: number;
}): Promise<{
  trafficBytes: number;
  feeCc: string;
  feeUsd: number;
  claimLabel: string;
  actAs: string[];
}> {
  const useRealClaim =
    !!params.htlcCid &&
    !!params.allocationCid &&
    !!params.preimageHex?.trim();

  let claimBytes = HTLC_CLAIM_FALLBACK_BYTES;

  if (useRealClaim) {
    try {
      const claimPrep = await prepareClaimCommand({
        htlcCid: params.htlcCid!,
        htlcBlob: params.htlcBlob,
        allocationCid: params.allocationCid!,
        solverParty: params.solverParty,
        preimageHex: params.preimageHex!
      });
      claimBytes = await prepareTrafficBytes({
        actAs: [params.userParty],
        commands: [claimPrep.command],
        disclosedContracts: claimPrep.disclosedContracts,
        synchronizerId: claimPrep.synchronizerId || undefined,
        label: "htlc-claim"
      });
    } catch {
      // fall back to calibrated bytes
    }
  } else {
    try {
      const proxy = await buildHtlcClaimQuoteProxyLeg({
        userParty: params.userParty,
        solverParty: params.solverParty,
        cbtcAmount: params.cbtcAmount ?? "0.0001"
      });
      claimBytes = await prepareTrafficBytes({
        actAs: [params.solverParty],
        commands: [proxy.command],
        disclosedContracts: proxy.disclosedContracts,
        synchronizerId: proxy.synchronizerId || undefined,
        label: "htlc-claim-proxy"
      });
    } catch {
      // fall back to calibrated bytes
    }
  }

  const priced = priceUserChargedTrafficBytes({
    trafficBytes: claimBytes,
    extraTrafficPriceUsdPerMb: params.extraTrafficPriceUsdPerMb,
    amuletPriceUsd: params.amuletPriceUsd
  });

  return {
    trafficBytes: claimBytes,
    feeCc: priced.feeCc,
    feeUsd: priced.feeUsd,
    claimLabel: "Claim CBTC",
    actAs: [params.userParty]
  };
}

async function buildSwapTransferLeg(params: {
  senderParty: string;
  receiverParty: string;
  assetId: CantonSwapMvpAssetId;
  amount: string;
  expirationSeconds?: number;
}) {
  const asset = getSwapAsset(params.assetId);
  const holdings = await holdingsForSwapAsset(params.senderParty, params.assetId);
  const instrumentId = await resolveSwapInstrumentId(params.assetId);
  const registrarAdmin = await registrarAdminForAsset(params.assetId);
  return buildTransferExercise({
    senderParty: params.senderParty,
    receiverParty: params.receiverParty,
    amount: params.amount,
    inputHoldings: holdings,
    expirationSeconds: params.expirationSeconds ?? 600,
    instrumentId,
    registrarAdmin,
    registryKind: registryKindForAsset(params.assetId),
    assetSymbol: asset.symbol,
    memo: "OranjSwap"
  });
}

function disabledEstimate(): NetworkFeeEstimate {
  return {
    feeCc: "0",
    feeUsd: 0,
    trafficBytes: 0,
    minCcRequired: "0",
    networkFeeSource: "disabled",
    transactions: []
  };
}

/** Managed C2C — user fee = offer + accept traffic; deliver + fee-cmd traffic absorbed by platform. */
export async function estimateManagedC2cSettleFee(params: {
  userParty: string;
  vaultParty: string;
  fromAsset: CantonSwapMvpAssetId;
  toAsset: CantonSwapMvpAssetId;
  inAmount: string;
  outAmount: string;
  includeFeeCommand?: boolean;
  notionalUsd?: number;
  /** Set true at settle revalidate; quotes use instant fallback bytes. */
  livePrepare?: boolean;
}): Promise<NetworkFeeEstimate> {
  if (!shouldQuoteNetworkFee()) {
    return disabledEstimate();
  }
  if (isNetworkFeeEnabled() && !networkFeeReceiverParty()) {
    throw new Error("NETWORK_FEE_RECEIVER_PARTY not configured");
  }

  const [extraTrafficPriceUsdPerMb, amuletPriceUsd] = await Promise.all([
    fetchExtraTrafficPriceUsdPerMb(),
    fetchAmuletPriceUsd()
  ]);

  const measured = await measureUserChargedC2cTrafficBytes({
    userParty: params.userParty,
    vaultParty: params.vaultParty,
    fromAsset: params.fromAsset,
    inAmount: params.inAmount,
    livePrepare: params.livePrepare
  });

  const priced = trafficBytesToFeeCc({
    trafficBytes: measured.total,
    extraTrafficPriceUsdPerMb,
    amuletPriceUsd,
    bufferBps: networkFeeBufferBps()
  });

  return {
    feeCc: priced.feeCc,
    feeUsd: priced.feeUsd,
    trafficBytes: measured.total,
    minCcRequired: minCcRequiredForNetworkFee(priced.feeCc),
    networkFeeSource: params.livePrepare ? "prepare" : "fallback",
    extraTrafficPriceUsdPerMb,
    amuletPriceUsd,
    transactions: [
      {
        id: "c2c-user-offer",
        label: "Send offer (Canton)",
        trafficBytes: measured.offerBytes,
        charged: true
      },
      {
        id: "c2c-vault-accept",
        label: "Vault accept your offer",
        trafficBytes: measured.acceptBytes,
        charged: true
      },
      {
        id: "c2c-vault-deliver",
        label: "Vault deliver counter (platform)",
        trafficBytes: 0,
        charged: false
      },
      ABSORBED_FEE_COLLECTION_LEG
    ]
  };
}

/** HTLC managed paths — prepare-based bytes on the user's charged Canton submit. */
export async function estimateHtlcManagedFee(params: {
  action: "htlc-claim" | "htlc-lock";
  userParty: string;
  solverParty?: string;
  cbtcAmount?: string;
  htlcCid?: string;
  allocationCid?: string;
  htlcBlob?: string;
  preimageHex?: string;
  notionalUsd?: number;
}): Promise<NetworkFeeEstimate> {
  if (!shouldQuoteNetworkFee()) return disabledEstimate();
  if (isNetworkFeeEnabled() && !networkFeeReceiverParty()) {
    throw new Error("NETWORK_FEE_RECEIVER_PARTY not configured");
  }

  const userParty = params.userParty;
  const solverParty = params.solverParty?.trim() || expectedSettlementParty();
  if (!solverParty) {
    throw new Error("CANTON_SWAP_SETTLEMENT_PARTY not configured for HTLC fee estimate");
  }

  const [extraTrafficPriceUsdPerMb, amuletPriceUsd] = await Promise.all([
    fetchExtraTrafficPriceUsdPerMb(),
    fetchAmuletPriceUsd()
  ]);

  const includeFee = isNetworkFeeEnabled() || isNetworkFeeQuotePreview();
  const contextLegs: NetworkFeeTxLeg[] = [
    {
      id: "solver-counter-lock",
      label: "Solver locks CBTC counter (Canton)",
      trafficBytes: 0,
      charged: false
    }
  ];

  if (params.action === "htlc-claim") {
    contextLegs.unshift({
      id: "evm-wbtc-lock",
      label: "Lock WBTC (EVM gas — not Canton CC)",
      trafficBytes: 0,
      charged: false
    });
    const cbtcAmount = params.cbtcAmount?.trim() || "0.0001";
    const charged = await prepareHtlcClaimChargedSubmit({
      userParty,
      solverParty,
      cbtcAmount,
      htlcCid: params.htlcCid,
      allocationCid: params.allocationCid,
      htlcBlob: params.htlcBlob,
      preimageHex: params.preimageHex,
      includeFeeCommand: includeFee,
      extraTrafficPriceUsdPerMb,
      amuletPriceUsd
    });
    return {
      feeCc: charged.feeCc,
      feeUsd: charged.feeUsd,
      trafficBytes: charged.trafficBytes,
      minCcRequired: minCcRequiredForNetworkFee(charged.feeCc),
      networkFeeSource: "prepare",
      extraTrafficPriceUsdPerMb,
      amuletPriceUsd,
      transactions: [
        ...contextLegs,
        {
          id: "htlc-claim",
          label: charged.claimLabel,
          trafficBytes: charged.trafficBytes,
          charged: true
        },
        ABSORBED_FEE_COLLECTION_LEG
      ]
    };
  }

  const cbtcAmount = params.cbtcAmount?.trim();
  if (!cbtcAmount || Number.parseFloat(cbtcAmount) <= 0) {
    throw new NetworkFeePrepareError(
      "cbtcAmount required for htlc-lock network fee estimate"
    );
  }
  contextLegs.unshift({
    id: "evm-wbtc-claim",
    label: "Claim WBTC on EVM (gas — not Canton CC)",
    trafficBytes: 0,
    charged: false
  });

  let allocateBytes = HTLC_LOCK_ALLOCATE_FALLBACK_BYTES;
  let createBytes = HTLC_LOCK_CREATE_FALLBACK_BYTES;
  try {
    const allocatePrep = await buildHtlcLockAllocateLeg({
      userParty,
      solverParty,
      cbtcAmount
    });
    allocateBytes = await prepareTrafficBytes({
      actAs: [userParty],
      commands: [allocatePrep.command],
      disclosedContracts: allocatePrep.disclosedContracts,
      synchronizerId: allocatePrep.synchronizerId || undefined,
      label: "htlc-lock-allocate"
    });
    const now = Date.now();
    const settleBeforeMs = now + 24 * 60 * 60 * 1000;
    const createCmd = buildCreateHtlcLockCommand({
      solverParty,
      receiverParty: solverParty,
      lockerParty: userParty,
      allocationCid: `${"00".repeat(68)}`,
      amountBtc: cbtcAmount,
      hashLock: "ab".repeat(32),
      unlockTime: new Date(settleBeforeMs - 60_000)
    });
    createBytes = await prepareTrafficBytes({
      actAs: createCmd.actAs,
      commands: [createCmd.command],
      disclosedContracts: [],
      synchronizerId: allocatePrep.synchronizerId || undefined,
      label: "htlc-lock-create"
    });
  } catch {
    // use calibrated fallbacks
  }

  const userChargedBytes = allocateBytes + createBytes;
  const priced = priceUserChargedTrafficBytes({
    trafficBytes: userChargedBytes,
    extraTrafficPriceUsdPerMb,
    amuletPriceUsd
  });

  return {
    feeCc: priced.feeCc,
    feeUsd: priced.feeUsd,
    trafficBytes: userChargedBytes,
    minCcRequired: minCcRequiredForNetworkFee(priced.feeCc),
    networkFeeSource: "prepare",
    extraTrafficPriceUsdPerMb,
    amuletPriceUsd,
    transactions: [
      ...contextLegs,
      {
        id: "solver-claim-cbtc",
        label: "Solver claim CBTC after reveal (platform)",
        trafficBytes: 0,
        charged: false
      },
      {
        id: "htlc-lock-allocate",
        label: "Lock CBTC: allocate",
        trafficBytes: allocateBytes,
        charged: true
      },
      {
        id: "htlc-lock-create",
        label: "Create HtlcLock",
        trafficBytes: createBytes,
        charged: true
      },
      ABSORBED_FEE_COLLECTION_LEG
    ]
  };
}

export function estimateToQuoteFields(e: NetworkFeeEstimate): NetworkFeeQuoteFields {
  return {
    networkFeeCc: e.feeCc,
    networkFeeUsd: e.feeUsd,
    minCcRequired: e.minCcRequired,
    networkFeeSource: e.networkFeeSource,
    trafficBytes: e.trafficBytes,
    networkFeeTransactions: e.transactions?.filter((t) => t.charged),
    networkFeeCharged: isNetworkFeeEnabled(),
    networkFeePreview: isNetworkFeeQuotePreview() && !isNetworkFeeEnabled()
  };
}

export async function appendNetworkFeeToUserOffer(params: {
  order: CantonSwapOrder;
  networkFeeCc: string;
  userLeg: Awaited<ReturnType<typeof buildSwapTransferLeg>>;
}): Promise<{
  commands: unknown[];
  disclosed: Awaited<ReturnType<typeof buildTransferExercise>>["disclosedContracts"];
  actAs: string[];
} | null> {
  if (!isNetworkFeeEnabled()) return null;
  const fee = Number.parseFloat(params.networkFeeCc);
  if (!Number.isFinite(fee) || fee <= 0) return null;

  const feeLeg = await buildCcFeeTransferLeg({
    senderParty: params.order.userParty,
    amountCc: params.networkFeeCc,
    excludeHoldingCids:
      params.order.fromAsset === "CC"
        ? inputHoldingCidsFromTransferCommand(params.userLeg.command)
        : undefined
  });
  assertSameSynchronizer([params.userLeg, feeLeg], "user offer with network fee");
  return {
    commands: [params.userLeg.command, feeLeg.command],
    disclosed: [
      ...params.userLeg.disclosedContracts,
      ...feeLeg.disclosedContracts
    ],
    actAs: [params.order.userParty]
  };
}

export async function assertUserNetworkFeeReady(params: {
  userParty: string;
  estimate: NetworkFeeEstimate;
}): Promise<void> {
  if (!isNetworkFeeEnabled()) return;
  const fee = Number.parseFloat(params.estimate.feeCc);
  if (!Number.isFinite(fee) || fee <= 0) return;

  const balanceCc = await getAmuletBalance(params.userParty);
  const minRequired = params.estimate.minCcRequired;
  if (!compareCcBalanceGte(balanceCc, minRequired)) {
    throw new NetworkFeeBalanceError({
      feeCc: params.estimate.feeCc,
      minCcRequired: minRequired,
      balanceCc
    });
  }
}

/** Re-estimate at settle; never charge above order-bound fee; gate CC balance. */
export async function revalidateOrderNetworkFee(
  order: CantonSwapOrder
): Promise<NetworkFeeEstimate> {
  if (!isNetworkFeeEnabled()) return disabledEstimate();

  const now = Math.floor(Date.now() / 1000);
  if (
    order.networkFeeExpiresAt != null &&
    now > order.networkFeeExpiresAt + QUOTE_GRACE_SECONDS
  ) {
    throw new Error("network fee quote expired — get a fresh quote");
  }

  const fresh = await estimateManagedC2cSettleFee({
    userParty: order.userParty,
    vaultParty: swapParty(order),
    fromAsset: order.fromAsset,
    toAsset: order.toAsset,
    inAmount: order.inAmount,
    outAmount: order.outAmount,
    livePrepare: true,
    notionalUsd: await computeC2cSwapNotionalUsd({
      fromAsset: order.fromAsset,
      inAmount: order.inAmount
    })
  });
  const cappedFeeCc = capNetworkFeeAtOrder(order.networkFeeCc, fresh.feeCc);
  const capped: NetworkFeeEstimate = {
    ...fresh,
    feeCc: cappedFeeCc,
    minCcRequired: minCcRequiredForNetworkFee(cappedFeeCc)
  };
  await assertUserNetworkFeeReady({ userParty: order.userParty, estimate: capped });
  return capped;
}

/** Re-estimate HTLC fee at execution; cap to order-bound quote.
 *  No separate fee TTL here — once networkFeeCc is stored on the order, that is the
 *  user's maximum charge until the swap completes or the order timelock passes.
 *  (Short RFQ TTL applies only to pre-order /api/htlc/quote previews.) */
export async function revalidateHtlcNetworkFee(params: {
  order: SwapOrder;
  action: "htlc-claim" | "htlc-lock";
  preimageHex?: string;
}): Promise<NetworkFeeEstimate> {
  if (!isNetworkFeeEnabled()) return disabledEstimate();

  const { order, action } = params;
  if (order.networkFeeCc == null || order.networkFeeCc === "") {
    throw new Error(
      "network fee not recorded on this order — contact support with your order id"
    );
  }

  const fresh = await estimateHtlcManagedFee({
    action,
    userParty: order.userCantonParty,
    solverParty: order.solverCantonParty,
    cbtcAmount: order.cbtcAmount,
    htlcCid: order.htlcCid,
    allocationCid: order.allocationCid,
    htlcBlob: order.htlcBlob,
    preimageHex: params.preimageHex,
    notionalUsd: await computeHtlcSwapNotionalUsd(order.cbtcAmount ?? "0")
  });
  const cappedFeeCc = capNetworkFeeAtOrder(order.networkFeeCc, fresh.feeCc);
  const capped: NetworkFeeEstimate = {
    ...fresh,
    feeCc: cappedFeeCc,
    minCcRequired: minCcRequiredForNetworkFee(cappedFeeCc)
  };
  await assertUserNetworkFeeReady({
    userParty: order.userCantonParty,
    estimate: capped
  });
  return capped;
}

export async function appendNetworkFeeToFill(params: {
  order: CantonSwapOrder;
  networkFeeCc: string;
  acceptLeg: Awaited<ReturnType<typeof buildAcceptExercise>>;
  deliverLeg: Awaited<ReturnType<typeof buildSwapTransferLeg>>;
}): Promise<{
  commands: unknown[];
  disclosed: Awaited<ReturnType<typeof buildTransferExercise>>["disclosedContracts"];
  actAs: string[];
} | null> {
  if (!isNetworkFeeEnabled()) return null;
  const fee = Number.parseFloat(params.networkFeeCc);
  if (!Number.isFinite(fee) || fee <= 0) return null;

  const feeLeg = await buildCcFeeTransferLeg({
    senderParty: params.order.userParty,
    amountCc: params.networkFeeCc
  });
  assertSameSynchronizer(
    [params.acceptLeg, params.deliverLeg, feeLeg],
    "fill with network fee"
  );
  return {
    commands: [
      params.acceptLeg.command,
      params.deliverLeg.command,
      feeLeg.command
    ],
    disclosed: [
      ...params.acceptLeg.disclosedContracts,
      ...params.deliverLeg.disclosedContracts,
      ...feeLeg.disclosedContracts
    ],
    actAs: managedFillActAsParties(params.order, true)
  };
}

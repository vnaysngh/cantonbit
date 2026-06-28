import { fromBaseUnits, toBaseUnitsFloor } from "../../../lib/amount-units";
import { CBTC_ASSET, CC_ASSET } from "../../../lib/canton-assets";
import { partyBalancesSummary } from "./float";
import { isUtxoOverAcsCap } from "./utxo-guard";
import { quoteFarmSwap } from "./quote";
import {
  isVaultCbtcCacheParty,
  refreshVaultCbtcCacheIfEmpty,
  reconcileVaultCbtcInFloat,
  vaultCbtcCachedBalance,
  vaultCbtcCacheSpendable
} from "./vault-cbtc-holdings";
import type { FarmAsset, FarmFleetConfig, OrganicPick, PacingConfig } from "./types";

/** Ledger-measured average (2 txs/swap). Used when Lighthouse traffic is unavailable. */
export const MEASURED_BYTES_PER_SWAP = 24_500;

/** Keep this much above swap size so parties don't drain to zero. */
const RESERVE_CBTC = "0.000005";
const RESERVE_CC = "10";

export interface PlannerState {
  lastDirection?: "CBTC→CC" | "CC→CBTC";
  lastTraderParty?: string;
}

export interface FleetFloatSnapshot {
  vault: { cbtc: string; cc: string };
  traders: Array<{
    hint: string;
    party: string;
    cbtc: string;
    cc: string;
    utxoCbtc: number;
    utxoCc: number;
  }>;
}

export interface DirectionQuotes {
  cbtcToCcOut: string;
  ccToCbtcOut: string;
}

function dirKey(from: FarmAsset, to: FarmAsset): "CBTC→CC" | "CC→CBTC" {
  return from === "CBTC" ? "CBTC→CC" : "CC→CBTC";
}

function parseAmt(s: string): number {
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

function hasReserve(
  balance: string,
  need: string,
  reserve: string,
  decimals: number
): boolean {
  const bal = toBaseUnitsFloor(balance, decimals);
  const req = toBaseUnitsFloor(need, decimals) + toBaseUnitsFloor(reserve, decimals);
  return bal >= req;
}

function bumpBalance(
  current: string,
  delta: string,
  decimals: number,
  sign: 1 | -1
): string {
  const deltaUnits = toBaseUnitsFloor(delta, decimals);
  const signed = sign === 1 ? deltaUnits : -deltaUnits;
  const next = toBaseUnitsFloor(current, decimals) + signed;
  return fromBaseUnits(next >= 0n ? next : 0n, decimals);
}

/** Update cached float from a settled swap (avoids re-reading vault CBTC via truncated ACS). */
export function applySwapToFloat(
  float: FleetFloatSnapshot,
  swap: {
    traderParty: string;
    fromAsset: FarmAsset;
    inAmount: string;
    outAmount: string;
  }
): FleetFloatSnapshot {
  const traders = float.traders.map((t) => ({ ...t }));
  const vault = { ...float.vault };
  const trader = traders.find((t) => t.party === swap.traderParty);
  if (!trader) return float;

  if (swap.fromAsset === "CBTC") {
    trader.cbtc = bumpBalance(
      trader.cbtc,
      swap.inAmount,
      CBTC_ASSET.decimals,
      -1
    );
    trader.cc = bumpBalance(trader.cc, swap.outAmount, CC_ASSET.decimals, 1);
    vault.cc = bumpBalance(vault.cc, swap.outAmount, CC_ASSET.decimals, -1);
  } else {
    trader.cc = bumpBalance(trader.cc, swap.inAmount, CC_ASSET.decimals, -1);
    trader.cbtc = bumpBalance(
      trader.cbtc,
      swap.outAmount,
      CBTC_ASSET.decimals,
      1
    );
    vault.cc = bumpBalance(vault.cc, swap.inAmount, CC_ASSET.decimals, 1);
  }

  const next: FleetFloatSnapshot = { vault, traders };
  return reconcileVaultCbtcInFloat(next);
}

export function applyVaultFundToFloat(
  float: FleetFloatSnapshot,
  fund: { cbtc?: string; cc?: string }
): FleetFloatSnapshot {
  const vault = { ...float.vault };
  if (fund.cbtc && parseFloat(fund.cbtc) > 0) {
    vault.cbtc = bumpBalance(vault.cbtc, fund.cbtc, CBTC_ASSET.decimals, 1);
  }
  if (fund.cc && parseFloat(fund.cc) > 0) {
    vault.cc = bumpBalance(vault.cc, fund.cc, CC_ASSET.decimals, 1);
  }
  return reconcileVaultCbtcInFloat({ ...float, vault });
}

export function applyTraderCbtcFundToFloat(
  float: FleetFloatSnapshot,
  amountPerTrader: string
): FleetFloatSnapshot {
  const per = toBaseUnitsFloor(amountPerTrader, CBTC_ASSET.decimals);
  const totalDebit = fromBaseUnits(
    per * BigInt(float.traders.length),
    CBTC_ASSET.decimals
  );
  return reconcileVaultCbtcInFloat({
    vault: {
      ...float.vault,
      cbtc: bumpBalance(float.vault.cbtc, totalDebit, CBTC_ASSET.decimals, -1)
    },
    traders: float.traders.map((t) => ({
      ...t,
      cbtc: bumpBalance(t.cbtc, amountPerTrader, CBTC_ASSET.decimals, 1)
    }))
  });
}

export async function loadFleetFloat(
  jwt: string,
  fleet: FarmFleetConfig
): Promise<FleetFloatSnapshot> {
  const vaultBal = await partyBalancesSummary(jwt, fleet.vault, { countUtxo: false });
  const traders = await Promise.all(
    fleet.traders.map(async (t) => {
      const bal = await partyBalancesSummary(jwt, t.party);
      return {
        hint: t.hint,
        party: t.party,
        cbtc: bal.cbtc,
        cc: bal.cc,
        utxoCbtc: bal.utxoCbtc,
        utxoCc: bal.utxoCc
      };
    })
  );
  const float: FleetFloatSnapshot = {
    vault: { cbtc: vaultBal.cbtc, cc: vaultBal.cc },
    traders
  };
  if (isVaultCbtcCacheParty(fleet.vault) && vaultCbtcCacheSpendable()) {
    return reconcileVaultCbtcInFloat(float);
  }
  return float;
}

export async function loadDirectionQuotes(
  pacing: PacingConfig
): Promise<DirectionQuotes> {
  const [cbtcQ, ccQ] = await Promise.all([
    quoteFarmSwap({
      fromAsset: "CBTC",
      toAsset: "CC",
      inAmount: pacing.cbtcInAmount
    }),
    quoteFarmSwap({
      fromAsset: "CC",
      toAsset: "CBTC",
      inAmount: pacing.ccInAmount
    })
  ]);
  return { cbtcToCcOut: cbtcQ.outAmount, ccToCbtcOut: ccQ.outAmount };
}

interface Candidate {
  traderIndex: number;
  traderParty: string;
  fromAsset: FarmAsset;
  toAsset: FarmAsset;
  inAmount: string;
  direction: "CBTC→CC" | "CC→CBTC";
  score: number;
}

function traderCanSellCbtc(
  t: FleetFloatSnapshot["traders"][number],
  pacing: PacingConfig
): boolean {
  if (t.utxoCbtc >= 10 || isUtxoOverAcsCap(t.utxoCbtc)) return false;
  return hasReserve(
    t.cbtc,
    pacing.cbtcInAmount,
    RESERVE_CBTC,
    CBTC_ASSET.decimals
  );
}

function traderCanSellCc(
  t: FleetFloatSnapshot["traders"][number],
  pacing: PacingConfig
): boolean {
  if (t.utxoCc >= 10 || isUtxoOverAcsCap(t.utxoCc)) return false;
  return hasReserve(t.cc, pacing.ccInAmount, RESERVE_CC, CC_ASSET.decimals);
}

function vaultCanDeliverCc(
  vault: FleetFloatSnapshot["vault"],
  quotes: DirectionQuotes
): boolean {
  return parseAmt(vault.cc) >= parseAmt(quotes.cbtcToCcOut);
}

function vaultCanDeliverCachedCbtc(quotes: DirectionQuotes): boolean {
  if (!vaultCbtcCacheSpendable()) return false;
  return parseAmt(vaultCbtcCachedBalance()) >= parseAmt(quotes.ccToCbtcOut);
}

/** Traders are CBTC-starved but CC-rich — CC→CBTC closes the cycle without treasury. */
function shouldPrioritizeCcToCbtc(
  float: FleetFloatSnapshot,
  pacing: PacingConfig
): boolean {
  const n = float.traders.length;
  if (n === 0) return false;
  const cbtcStarved = float.traders.filter(
    (t) => !traderCanSellCbtc(t, pacing)
  ).length;
  const ccReady = float.traders.filter((t) => traderCanSellCc(t, pacing)).length;
  return cbtcStarved >= Math.ceil(n / 2) && ccReady > 0;
}

/** Score how much this swap rebalances a trader toward starting float (~120 CC, ~0.0003 CBTC). */
function rebalanceScore(
  t: FleetFloatSnapshot["traders"][number],
  direction: "CBTC→CC" | "CC→CBTC"
): number {
  const idealCbtc = 0.0003;
  const idealCc = 120;
  const cbtcExcess = parseAmt(t.cbtc) - idealCbtc;
  const ccExcess = parseAmt(t.cc) - idealCc;
  if (direction === "CBTC→CC") {
    return cbtcExcess * 100_000 - ccExcess;
  }
  return ccExcess - cbtcExcess * 100_000;
}

function directionAllowed(
  direction: "CBTC→CC" | "CC→CBTC",
  state: PlannerState
): boolean {
  if (!state.lastDirection) return true;
  return direction !== state.lastDirection;
}

function traderDirectionAllowed(
  traderParty: string,
  direction: "CBTC→CC" | "CC→CBTC",
  state: PlannerState
): boolean {
  if (state.lastTraderParty !== traderParty) return true;
  if (!state.lastDirection) return true;
  return direction !== state.lastDirection;
}

function buildCandidates(params: {
  float: FleetFloatSnapshot;
  fleet: FarmFleetConfig;
  pacing: PacingConfig;
  quotes: DirectionQuotes;
  state: PlannerState;
  vaultCbtcSpendable: boolean;
  prioritizeCcToCbtc: boolean;
}): Candidate[] {
  const out: Candidate[] = [];
  const ccBoost = params.prioritizeCcToCbtc ? 1_000_000 : 0;

  params.fleet.traders.forEach((trader, traderIndex) => {
    const snap = params.float.traders[traderIndex]!;

    if (
      !params.prioritizeCcToCbtc &&
      traderCanSellCbtc(snap, params.pacing) &&
      vaultCanDeliverCc(params.float.vault, params.quotes) &&
      directionAllowed("CBTC→CC", params.state) &&
      traderDirectionAllowed(trader.party, "CBTC→CC", params.state)
    ) {
      out.push({
        traderIndex,
        traderParty: trader.party,
        fromAsset: "CBTC",
        toAsset: "CC",
        inAmount: params.pacing.cbtcInAmount,
        direction: "CBTC→CC",
        score:
          rebalanceScore(snap, "CBTC→CC") -
          (params.state.lastTraderParty === trader.party ? 50 : 0)
      });
    }

    if (
      traderCanSellCc(snap, params.pacing) &&
      params.vaultCbtcSpendable &&
      vaultCanDeliverCachedCbtc(params.quotes) &&
      directionAllowed("CC→CBTC", params.state) &&
      traderDirectionAllowed(trader.party, "CC→CBTC", params.state)
    ) {
      out.push({
        traderIndex,
        traderParty: trader.party,
        fromAsset: "CC",
        toAsset: "CBTC",
        inAmount: params.pacing.ccInAmount,
        direction: "CC→CBTC",
        score:
          rebalanceScore(snap, "CC→CBTC") +
          ccBoost -
          (params.state.lastTraderParty === trader.party ? 50 : 0)
      });
    }
  });
  return out;
}

function pickScored(candidates: Candidate[]): Candidate {
  const maxScore = Math.max(...candidates.map((c) => c.score));
  const tier = candidates.filter((c) => c.score >= maxScore - 1e-6);
  return tier[Math.floor(Math.random() * tier.length)]!;
}

/**
 * Pick the next swap: balance-aware, alternates direction, avoids same trader+dir twice.
 */
export async function planNextSwap(params: {
  jwt: string;
  fleet: FarmFleetConfig;
  pacing: PacingConfig;
  state: PlannerState;
  /** Reuse between swaps — avoid re-querying ACS every plan (Canton State Service pattern). */
  float?: FleetFloatSnapshot;
}): Promise<{ pick: OrganicPick; state: PlannerState; float: FleetFloatSnapshot }> {
  const [rawFloat, quotes] = await Promise.all([
    params.float
      ? Promise.resolve(params.float)
      : loadFleetFloat(params.jwt, params.fleet),
    loadDirectionQuotes(params.pacing)
  ]);

  if (isVaultCbtcCacheParty(params.fleet.vault)) {
    await refreshVaultCbtcCacheIfEmpty(params.jwt, params.fleet.vault);
  }

  let float = isVaultCbtcCacheParty(params.fleet.vault)
    ? reconcileVaultCbtcInFloat(rawFloat)
    : rawFloat;

  const vaultCbtcSpendable =
    !isVaultCbtcCacheParty(params.fleet.vault) || vaultCbtcCacheSpendable();

  const prioritizeCcToCbtc = shouldPrioritizeCcToCbtc(float, params.pacing);

  // When CBTC-starved, pretend last leg was CBTC→CC so CC→CBTC is direction-allowed.
  const effectiveState: PlannerState = prioritizeCcToCbtc
    ? { ...params.state, lastDirection: "CBTC→CC" as const }
    : params.state;

  let candidates = buildCandidates({
    float,
    fleet: params.fleet,
    pacing: params.pacing,
    quotes,
    state: effectiveState,
    vaultCbtcSpendable,
    prioritizeCcToCbtc
  });

  if (candidates.length === 0) {
    candidates = buildCandidates({
      float,
      fleet: params.fleet,
      pacing: params.pacing,
      quotes,
      state: { ...effectiveState, lastDirection: undefined },
      vaultCbtcSpendable,
      prioritizeCcToCbtc
    });
  }

  if (candidates.length === 0) {
    throw new Error(
      formatPlanBlockers({
        float,
        pacing: params.pacing,
        quotes,
        state: params.state,
        vaultCbtcSpendable
      })
    );
  }

  const chosen = pickScored(candidates);
  const pick: OrganicPick = {
    traderIndex: chosen.traderIndex,
    traderParty: chosen.traderParty,
    fromAsset: chosen.fromAsset,
    toAsset: chosen.toAsset,
    inAmount: chosen.inAmount
  };
  return {
    pick,
    state: {
      lastDirection: chosen.direction,
      lastTraderParty: chosen.traderParty
    },
    float
  };
}

export function directionLabel(from: FarmAsset, to: FarmAsset): string {
  return dirKey(from, to);
}

/** Match CC→CBTC input to CBTC→CC quote output so alternating swaps don't drift float. */
export async function balancePacingAmounts(
  pacing: PacingConfig
): Promise<PacingConfig> {
  const q = await quoteFarmSwap({
    fromAsset: "CBTC",
    toAsset: "CC",
    inAmount: pacing.cbtcInAmount
  });
  return { ...pacing, ccInAmount: q.outAmount };
}

interface PlanBlockerReport {
  float: FleetFloatSnapshot;
  pacing: PacingConfig;
  quotes: DirectionQuotes;
  state: PlannerState;
  vaultCbtcSpendable?: boolean;
}

function countDirectionBlockers(
  report: PlanBlockerReport,
  direction: "CBTC→CC" | "CC→CBTC"
): {
  tradersOk: number;
  vaultOk: boolean;
  directionOk: boolean;
  sampleTraderIssue?: string;
} {
  const directionOk = directionAllowed(direction, report.state);
  let vaultOk =
    direction === "CBTC→CC"
      ? vaultCanDeliverCc(report.float.vault, report.quotes)
      : vaultCanDeliverCachedCbtc(report.quotes);
  if (direction === "CC→CBTC" && report.vaultCbtcSpendable === false) {
    vaultOk = false;
  }
  let tradersOk = 0;
  let sampleTraderIssue: string | undefined;

  for (const t of report.float.traders) {
    const canSell =
      direction === "CBTC→CC"
        ? traderCanSellCbtc(t, report.pacing)
        : traderCanSellCc(t, report.pacing);
    const traderOk =
      canSell && traderDirectionAllowed(t.party, direction, report.state);
    if (traderOk) {
      tradersOk++;
      continue;
    }
    if (!sampleTraderIssue) {
      if (
        direction === "CBTC→CC"
          ? t.utxoCbtc >= 10 || isUtxoOverAcsCap(t.utxoCbtc)
          : t.utxoCc >= 10 || isUtxoOverAcsCap(t.utxoCc)
      ) {
        sampleTraderIssue = `${t.hint}: UTXO cap`;
      } else if (!canSell) {
        sampleTraderIssue =
          direction === "CBTC→CC"
            ? `${t.hint}: CBTC ${t.cbtc} (need ${report.pacing.cbtcInAmount}+${RESERVE_CBTC})`
            : `${t.hint}: CC ${t.cc} (need ${report.pacing.ccInAmount}+${RESERVE_CC})`;
      } else {
        sampleTraderIssue = `${t.hint}: same trader+direction blocked`;
      }
    }
  }

  return { tradersOk, vaultOk, directionOk, sampleTraderIssue };
}

export function formatPlanBlockers(report: PlanBlockerReport): string {
  const cbtc = countDirectionBlockers(report, "CBTC→CC");
  const cc = countDirectionBlockers(report, "CC→CBTC");
  const vaultNeedCbtc = report.quotes.ccToCbtcOut;
  const vaultNeedCc = report.quotes.cbtcToCcOut;
  const cachedCbtc =
    report.vaultCbtcSpendable === false
      ? `${report.float.vault.cbtc} (cached spendable: 0)`
      : report.float.vault.cbtc;

  const lines = [
    "no viable swap — float/UTXO/direction blockers:",
    `  vault CBTC=${cachedCbtc} (need ≥${vaultNeedCbtc} spendable for CC→CBTC) CC=${report.float.vault.cc} (need ≥${vaultNeedCc} for CBTC→CC)`,
    `  CBTC→CC: traders=${cbtc.tradersOk}/${report.float.traders.length} vault=${cbtc.vaultOk ? "ok" : "low CC"} dir=${cbtc.directionOk ? "ok" : "blocked"}${cbtc.sampleTraderIssue ? ` e.g. ${cbtc.sampleTraderIssue}` : ""}`,
    `  CC→CBTC: traders=${cc.tradersOk}/${report.float.traders.length} vault=${cc.vaultOk ? "ok" : report.vaultCbtcSpendable === false ? "no spendable CBTC UTXO" : "low CBTC"} dir=${cc.directionOk ? "ok" : "blocked"}${cc.sampleTraderIssue ? ` e.g. ${cc.sampleTraderIssue}` : ""}`,
    "  fix: CC→CBTC returns CBTC to traders using vault CC; fund vault CBTC once (fund-swap-vault:mainnet) if cache empty; tune --cbtc-in / --cc-in"
  ];
  return lines.join("\n");
}

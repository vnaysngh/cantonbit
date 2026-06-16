import { toBaseUnitsFloor } from "../../../lib/amount-units";
import { CBTC_ASSET, CC_ASSET } from "../../../lib/canton-assets";
import { partyBalancesSummary } from "./float";
import { quoteFarmSwap } from "./quote";
import type { FarmAsset, FarmFleetConfig, OrganicPick, PacingConfig } from "./types";

/** Ledger-measured average (2 txs/swap). Used when Lighthouse traffic is unavailable. */
export const MEASURED_BYTES_PER_SWAP = 24_500;

/** Keep this much above swap size so parties don't drain to zero. */
const RESERVE_CBTC = "0.00005";
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

export async function loadFleetFloat(
  jwt: string,
  fleet: FarmFleetConfig
): Promise<FleetFloatSnapshot> {
  const vaultBal = await partyBalancesSummary(jwt, fleet.vault);
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
  return {
    vault: { cbtc: vaultBal.cbtc, cc: vaultBal.cc },
    traders
  };
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
  if (t.utxoCbtc >= 10) return false;
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
  if (t.utxoCc >= 10) return false;
  return hasReserve(t.cc, pacing.ccInAmount, RESERVE_CC, CC_ASSET.decimals);
}

function vaultCanDeliver(
  vault: FleetFloatSnapshot["vault"],
  toAsset: FarmAsset,
  quotes: DirectionQuotes
): boolean {
  if (toAsset === "CC") {
    return parseAmt(vault.cc) >= parseAmt(quotes.cbtcToCcOut);
  }
  return parseAmt(vault.cbtc) >= parseAmt(quotes.ccToCbtcOut);
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
}): Candidate[] {
  const out: Candidate[] = [];
  params.fleet.traders.forEach((trader, traderIndex) => {
    const snap = params.float.traders[traderIndex]!;
    if (
      traderCanSellCbtc(snap, params.pacing) &&
      vaultCanDeliver(params.float.vault, "CC", params.quotes) &&
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
      vaultCanDeliver(params.float.vault, "CBTC", params.quotes) &&
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
          rebalanceScore(snap, "CC→CBTC") -
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
}): Promise<{ pick: OrganicPick; state: PlannerState }> {
  const [float, quotes] = await Promise.all([
    loadFleetFloat(params.jwt, params.fleet),
    loadDirectionQuotes(params.pacing)
  ]);

  let candidates = buildCandidates({
    float,
    fleet: params.fleet,
    pacing: params.pacing,
    quotes,
    state: params.state
  });

  if (candidates.length === 0) {
    // Relax global direction alternation but keep per-trader same-dir guard.
    candidates = buildCandidates({
      float,
      fleet: params.fleet,
      pacing: params.pacing,
      quotes,
      state: { ...params.state, lastDirection: undefined }
    });
  }

  if (candidates.length === 0) {
    throw new Error(
      "no viable swap — check trader/vault float, UTXO caps, or fund from treasury"
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
    }
  };
}

export function directionLabel(from: FarmAsset, to: FarmAsset): string {
  return dirKey(from, to);
}

import "server-only";

import { getAmuletBalance } from "./canton";
import { MIN_CC_TO_ENABLE, NETWORK } from "./constants";
import type { CantonSwapOrder } from "./canton-swap-types";
import { hasCcEnabled } from "./enable-cc";
import { hasCbtcPreapproval } from "./enable-cbtc-preapproval";
import { expectedSolverCanton, expectedSettlementParty } from "./htlc-auth";
import { buildTransferExercise } from "./transfer";
import {
  holdingsForSwapAsset,
  registrarAdminForAsset,
  registryKindForAsset,
  resolveSwapInstrumentId
} from "./canton-swap-holdings";
import { getSwapAsset } from "./canton-assets";

export function isDirectTransferKind(kind: string): boolean {
  const k = kind.toLowerCase();
  return k === "direct" || k === "self" || k.includes("direct");
}

export interface ManagedPreapprovalStatus {
  party: string;
  ccEnabled: boolean;
  cbtcEnabled: boolean;
  ccTotal: string;
  ccMinToEnable: number;
  ccReadyForEnable: boolean;
  ccSubsidizedOnDevnet: boolean;
  cbtcInstrumentAdmin: string;
}

export async function getManagedPreapprovalStatus(
  party: string
): Promise<ManagedPreapprovalStatus> {
  const ccTotal = await getAmuletBalance(party);
  const ccNum = parseFloat(ccTotal);
  const ccReadyForEnable =
    Number.isFinite(ccNum) && ccNum >= MIN_CC_TO_ENABLE;
  const ccSubsidizedOnDevnet =
    NETWORK.name === "devnet" && !ccReadyForEnable;
  const ccEnabled = await hasCcEnabled(party);
  const cbtcEnabled = await hasCbtcPreapproval(party);
  return {
    party,
    ccEnabled,
    cbtcEnabled,
    ccTotal,
    ccMinToEnable: MIN_CC_TO_ENABLE,
    ccReadyForEnable: ccReadyForEnable || ccSubsidizedOnDevnet,
    ccSubsidizedOnDevnet,
    cbtcInstrumentAdmin: NETWORK.decentralizedPartyId
  };
}

async function previewLeg(params: {
  senderParty: string;
  receiverParty: string;
  assetId: CantonSwapOrder["fromAsset"] | CantonSwapOrder["toAsset"];
  amount: string;
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
    expirationSeconds: 600,
    instrumentId,
    registrarAdmin,
    registryKind: registryKindForAsset(params.assetId),
    assetSymbol: asset.symbol,
    memo: "OranjSwap"
  });
}

export interface ManagedSwapReadiness {
  ready: boolean;
  userLegKind: string;
  solverLegKind: string;
  userLegDirect: boolean;
  solverLegDirect: boolean;
  issues: string[];
}

function preapprovalIssue(params: {
  leg: "user" | "solver";
  asset: CantonSwapOrder["fromAsset"] | CantonSwapOrder["toAsset"];
  receiverParty: string;
}): string {
  const who = params.leg === "user" ? "Your account" : "Solver";
  const partyHint = params.receiverParty.slice(0, 28) + "…";
  if (params.asset === "CC") {
    return `${who} must auto-accept incoming CC — run Enable CC (Splice TransferPreapproval) on ${partyHint}`;
  }
  return `${who} must auto-accept incoming CBTC — tap Enable CBTC in the app (utility preapproval on ${partyHint})`;
}

export async function previewManagedSwapReadiness(params: {
  userParty: string;
  solverParty?: string;
  fromAsset: CantonSwapOrder["fromAsset"];
  toAsset: CantonSwapOrder["toAsset"];
  inAmount: string;
  outAmount: string;
}): Promise<ManagedSwapReadiness> {
  const solverParty = params.solverParty ?? expectedSolverCanton();
  const issues: string[] = [];
  let userLegKind = "";
  let solverLegKind = "";
  let userLegDirect = false;
  let solverLegDirect = false;

  try {
    const userLeg = await previewLeg({
      senderParty: params.userParty,
      receiverParty: solverParty,
      assetId: params.fromAsset,
      amount: params.inAmount
    });
    userLegKind = userLeg.transferKind;
    userLegDirect = isDirectTransferKind(userLeg.transferKind);
    if (!userLegDirect) {
      issues.push(
        preapprovalIssue({
          leg: "solver",
          asset: params.fromAsset,
          receiverParty: solverParty
        })
      );
    }
  } catch (e) {
    issues.push(e instanceof Error ? e.message : String(e));
  }

  try {
    const solverLeg = await previewLeg({
      senderParty: solverParty,
      receiverParty: params.userParty,
      assetId: params.toAsset,
      amount: params.outAmount
    });
    solverLegKind = solverLeg.transferKind;
    solverLegDirect = isDirectTransferKind(solverLeg.transferKind);
    if (!solverLegDirect) {
      issues.push(
        preapprovalIssue({
          leg: "user",
          asset: params.toAsset,
          receiverParty: params.userParty
        })
      );
    }
  } catch (e) {
    issues.push(e instanceof Error ? e.message : String(e));
  }

  return {
    ready: userLegDirect && solverLegDirect && issues.length === 0,
    userLegKind,
    solverLegKind,
    userLegDirect,
    solverLegDirect,
    issues
  };
}

export interface LoopSwapReadiness {
  ready: boolean;
  userLegKind: string;
  userLegOffer: boolean;
  counterLegKind: string;
  counterLegDirect: boolean;
  counterRequiresAccept: boolean;
  settlementParty: string;
  issues: string[];
}

/** Loop C2C: user leg must be offer (settlement receiver); counter may be direct or offer. */
export async function previewLoopSwapReadiness(params: {
  userParty: string;
  solverParty?: string;
  settlementParty?: string;
  fromAsset: CantonSwapOrder["fromAsset"];
  toAsset: CantonSwapOrder["toAsset"];
  inAmount: string;
  outAmount: string;
}): Promise<LoopSwapReadiness> {
  const solverParty = params.solverParty ?? expectedSolverCanton();
  const settlementParty =
    params.settlementParty ?? (expectedSettlementParty() || solverParty);
  const issues: string[] = [];
  let userLegKind = "";
  let userLegOffer = false;
  let counterLegKind = "";
  let counterLegDirect = false;
  let counterNote: string | undefined;

  if (!expectedSettlementParty() && settlementParty === solverParty) {
    issues.push(
      "Set CANTON_SWAP_SETTLEMENT_PARTY to a party without TransferPreapproval for Loop swaps"
    );
  }

  try {
    const userLeg = await previewLeg({
      senderParty: params.userParty,
      receiverParty: settlementParty,
      assetId: params.fromAsset,
      amount: params.inAmount
    });
    userLegKind = userLeg.transferKind;
    userLegOffer = !isDirectTransferKind(userLeg.transferKind);
    if (!userLegOffer) {
      issues.push(
        `User sell leg would auto-settle (transferKind=${userLegKind}) — settlement receiver ${settlementParty.slice(0, 28)}… must not have TransferPreapproval`
      );
    }
  } catch (e) {
    issues.push(e instanceof Error ? e.message : String(e));
  }

  try {
    const counterLeg = await previewLeg({
      senderParty: solverParty,
      receiverParty: params.userParty,
      assetId: params.toAsset,
      amount: params.outAmount
    });
    counterLegKind = counterLeg.transferKind;
    counterLegDirect = isDirectTransferKind(counterLeg.transferKind);
    if (!counterLegDirect) {
      counterNote =
        "After solver fill you must Accept incoming CC in Loop (enable CC auto-accept for instant delivery)";
    }
  } catch (e) {
    issues.push(e instanceof Error ? e.message : String(e));
  }

  const allIssues = counterNote ? [...issues, counterNote] : issues;

  return {
    ready: userLegOffer && issues.length === 0,
    userLegKind,
    userLegOffer,
    counterLegKind,
    counterLegDirect,
    counterRequiresAccept: !counterLegDirect,
    settlementParty,
    issues: allIssues
  };
}

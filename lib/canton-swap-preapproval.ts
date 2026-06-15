import "server-only";

import { getAmuletBalance } from "./canton";
import { MIN_CC_TO_ENABLE, NETWORK } from "./constants";
import type { CantonSwapOrder } from "./canton-swap-types";
import { hasCcEnabled } from "./enable-cc";
import { hasCbtcPreapproval } from "./enable-cbtc-preapproval";
import { expectedCantonSwapParty } from "./htlc-auth";
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
  settlementParty: string;
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

function userCounterPreapprovalIssue(params: {
  asset: CantonSwapOrder["fromAsset"] | CantonSwapOrder["toAsset"];
  receiverParty: string;
}): string {
  const partyHint = params.receiverParty.slice(0, 28) + "…";
  if (params.asset === "CC") {
    return `Enable CC auto-accept (Splice TransferPreapproval) on ${partyHint} for instant counter delivery`;
  }
  return `Enable CBTC auto-accept in the app on ${partyHint} for instant counter delivery`;
}

async function previewCantonSwapReadiness(params: {
  userParty: string;
  settlementParty?: string;
  fromAsset: CantonSwapOrder["fromAsset"];
  toAsset: CantonSwapOrder["toAsset"];
  inAmount: string;
  outAmount: string;
}): Promise<LoopSwapReadiness & { userLegDirect: boolean; solverLegDirect: boolean }> {
  const vault =
    params.settlementParty ?? expectedCantonSwapParty();
  const issues: string[] = [];
  let userLegKind = "";
  let userLegOffer = false;
  let userLegDirect = false;
  let counterLegKind = "";
  let counterLegDirect = false;
  let counterNote: string | undefined;

  if (!vault) {
    issues.push(
      "Set CANTON_SWAP_SETTLEMENT_PARTY — required for all C2C swaps"
    );
  }

  if (vault) {
    try {
      const userLeg = await previewLeg({
        senderParty: params.userParty,
        receiverParty: vault,
        assetId: params.fromAsset,
        amount: params.inAmount
      });
      userLegKind = userLeg.transferKind;
      userLegOffer = !isDirectTransferKind(userLeg.transferKind);
      userLegDirect = !userLegOffer;
      if (!userLegOffer) {
        issues.push(
          `User sell leg would auto-settle (transferKind=${userLegKind}) — settlement vault ${vault.slice(0, 28)}… must not have TransferPreapproval`
        );
      }
    } catch (e) {
      issues.push(e instanceof Error ? e.message : String(e));
    }

    try {
      const counterLeg = await previewLeg({
        senderParty: vault,
        receiverParty: params.userParty,
        assetId: params.toAsset,
        amount: params.outAmount
      });
      counterLegKind = counterLeg.transferKind;
      counterLegDirect = isDirectTransferKind(counterLeg.transferKind);
      if (!counterLegDirect) {
        counterNote = userCounterPreapprovalIssue({
          asset: params.toAsset,
          receiverParty: params.userParty
        });
      }
    } catch (e) {
      issues.push(e instanceof Error ? e.message : String(e));
    }
  }

  const allIssues = counterNote ? [...issues, counterNote] : issues;

  return {
    ready: userLegOffer && issues.length === 0,
    userLegKind,
    userLegOffer,
    userLegDirect,
    solverLegDirect: counterLegDirect,
    counterLegKind,
    counterLegDirect,
    counterRequiresAccept: !counterLegDirect,
    settlementParty: vault,
    issues: allIssues
  };
}

/** Managed C2C: user offer to vault + vault counter (same model as Loop). */
export async function previewManagedSwapReadiness(params: {
  userParty: string;
  solverParty?: string;
  fromAsset: CantonSwapOrder["fromAsset"];
  toAsset: CantonSwapOrder["toAsset"];
  inAmount: string;
  outAmount: string;
}): Promise<ManagedSwapReadiness> {
  const preview = await previewCantonSwapReadiness({
    userParty: params.userParty,
    settlementParty: params.solverParty ?? expectedCantonSwapParty(),
    fromAsset: params.fromAsset,
    toAsset: params.toAsset,
    inAmount: params.inAmount,
    outAmount: params.outAmount
  });
  return {
    ready: preview.ready,
    userLegKind: preview.userLegKind,
    solverLegKind: preview.counterLegKind,
    userLegDirect: preview.userLegDirect,
    solverLegDirect: preview.solverLegDirect,
    issues: preview.issues,
    settlementParty: preview.settlementParty
  };
}

/** Loop C2C: user leg must be offer (settlement vault); counter from vault float. */
export async function previewLoopSwapReadiness(params: {
  userParty: string;
  solverParty?: string;
  settlementParty?: string;
  fromAsset: CantonSwapOrder["fromAsset"];
  toAsset: CantonSwapOrder["toAsset"];
  inAmount: string;
  outAmount: string;
}): Promise<LoopSwapReadiness> {
  const preview = await previewCantonSwapReadiness({
    userParty: params.userParty,
    settlementParty:
      params.settlementParty ?? params.solverParty ?? expectedCantonSwapParty(),
    fromAsset: params.fromAsset,
    toAsset: params.toAsset,
    inAmount: params.inAmount,
    outAmount: params.outAmount
  });
  return {
    ready: preview.ready,
    userLegKind: preview.userLegKind,
    userLegOffer: preview.userLegOffer,
    counterLegKind: preview.counterLegKind,
    counterLegDirect: preview.counterLegDirect,
    counterRequiresAccept: preview.counterRequiresAccept,
    settlementParty: preview.settlementParty,
    issues: preview.issues
  };
}

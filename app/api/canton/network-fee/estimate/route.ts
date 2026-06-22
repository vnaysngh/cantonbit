/**
 * POST /api/canton/network-fee/estimate — live traffic fee estimate (prepare-based).
 */
import { NextResponse } from "next/server";

import { clientIpFromRequest } from "@/lib/canton-swap-rate-limit";
import { distributedRateLimitOk } from "@/lib/api-rate-limit";
import {
  estimateHtlcManagedFee,
  estimateLoopC2cSettleFee,
  estimateManagedC2cSettleFee,
  estimateToQuoteFields,
  logNetworkFeeEstimate,
  NetworkFeePrepareError,
  shouldQuoteNetworkFee
} from "@/lib/canton-network-fee";
import type { CantonSwapMvpAssetId } from "@/lib/canton-swap-types";
import {
  authorizeQuoteParty,
  expectedCantonSwapParty,
  expectedSettlementParty,
  requirePartyOwner
} from "@/lib/htlc-auth";

export const dynamic = "force-dynamic";

type EstimateAction =
  | "c2c-managed-settle"
  | "c2c-loop-settle"
  | "htlc-claim"
  | "htlc-lock"
  | "htlc-loop-claim"
  | "htlc-loop-lock";

function parseAsset(raw: unknown): CantonSwapMvpAssetId | null {
  if (raw === "CBTC" || raw === "CC") return raw;
  return null;
}

export async function POST(req: Request) {
  try {
    if (
      !(await distributedRateLimitOk({
        scope: "network-fee-estimate",
        key: clientIpFromRequest(req),
        limit: 30
      }))
    ) {
      return NextResponse.json({ error: "rate limit exceeded" }, { status: 429 });
    }

    if (!shouldQuoteNetworkFee()) {
      const disabled = estimateToQuoteFields({
        feeCc: "0",
        feeUsd: 0,
        trafficBytes: 0,
        minCcRequired: "0",
        networkFeeSource: "disabled"
      });
      return NextResponse.json({
        feeCc: disabled.networkFeeCc,
        feeUsd: disabled.networkFeeUsd,
        ...disabled
      });
    }

    const body = await req.json();
    const action = body.action as EstimateAction;
    if (!action) {
      return NextResponse.json({ error: "missing action" }, { status: 400 });
    }

    if (action === "c2c-managed-settle") {
      const fromAsset = parseAsset(body.fromAsset);
      const toAsset = parseAsset(body.toAsset);
      const userParty = String(body.userParty ?? "");
      const inAmount = String(body.inAmount ?? body.amount ?? "");
      const outAmount = String(body.outAmount ?? "");
      const vaultParty =
        String(body.vaultParty ?? "") || expectedCantonSwapParty() || "";
      if (!fromAsset || !toAsset || !userParty || !inAmount || !outAmount) {
        return NextResponse.json(
          { error: "missing fromAsset/toAsset/userParty/inAmount/outAmount" },
          { status: 400 }
        );
      }
      const auth = await requirePartyOwner(userParty);
      if (auth.error) return auth.error;

      const estimate = await estimateManagedC2cSettleFee({
        userParty,
        vaultParty,
        fromAsset,
        toAsset,
        inAmount,
        outAmount,
        notionalUsd:
          body.notionalUsd != null ? Number(body.notionalUsd) : undefined
      });
      logNetworkFeeEstimate("estimate c2c-managed-settle", estimate);
      return NextResponse.json({
        ...estimate,
        ...estimateToQuoteFields(estimate)
      });
    }

    if (action === "c2c-loop-settle") {
      const fromAsset = parseAsset(body.fromAsset);
      const userParty = String(body.userParty ?? "");
      const inAmount = String(body.inAmount ?? body.amount ?? "");
      if (!fromAsset || !userParty || !inAmount) {
        return NextResponse.json(
          { error: "missing fromAsset/userParty/inAmount" },
          { status: 400 }
        );
      }
      const auth = await authorizeQuoteParty(userParty);
      if (auth.error) return auth.error;

      const estimate = await estimateLoopC2cSettleFee({
        userParty,
        fromAsset,
        inAmount
      });
      logNetworkFeeEstimate("estimate c2c-loop-settle", estimate);
      return NextResponse.json({
        ...estimate,
        ...estimateToQuoteFields(estimate)
      });
    }

    if (action === "htlc-claim" || action === "htlc-lock") {
      const userParty = String(body.userParty ?? body.cantonParty ?? "");
      if (!userParty) {
        return NextResponse.json({ error: "missing userParty" }, { status: 400 });
      }
      const auth = await requirePartyOwner(userParty);
      if (auth.error) return auth.error;

      const estimate = await estimateHtlcManagedFee({
        action,
        userParty,
        solverParty: String(body.solverParty ?? "") || expectedSettlementParty(),
        cbtcAmount:
          body.cbtcAmount != null ? String(body.cbtcAmount) : undefined,
        htlcCid: body.htlcCid != null ? String(body.htlcCid) : undefined,
        allocationCid:
          body.allocationCid != null ? String(body.allocationCid) : undefined,
        htlcBlob: body.htlcBlob != null ? String(body.htlcBlob) : undefined,
        notionalUsd:
          body.notionalUsd != null ? Number(body.notionalUsd) : undefined
      });
      logNetworkFeeEstimate(`estimate ${action}`, estimate);
      return NextResponse.json({
        ...estimate,
        ...estimateToQuoteFields(estimate)
      });
    }

    if (action === "htlc-loop-claim" || action === "htlc-loop-lock") {
      const userParty = String(body.userParty ?? body.cantonParty ?? "");
      if (!userParty) {
        return NextResponse.json(
          { error: "missing userParty" },
          { status: 400 }
        );
      }
      const auth = await authorizeQuoteParty(userParty);
      if (auth.error) return auth.error;

      const disabled = estimateToQuoteFields({
        feeCc: "0",
        feeUsd: 0,
        trafficBytes: 0,
        minCcRequired: "0",
        networkFeeSource: "disabled",
        transactions: []
      });
      return NextResponse.json({
        feeCc: disabled.networkFeeCc,
        feeUsd: disabled.networkFeeUsd,
        ...disabled
      });
    }

    return NextResponse.json({ error: `unknown action ${action}` }, { status: 400 });
  } catch (e) {
    if (e instanceof NetworkFeePrepareError) {
      return NextResponse.json({ error: e.userMessage }, { status: 400 });
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 }
    );
  }
}

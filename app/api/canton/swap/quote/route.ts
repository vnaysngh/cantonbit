/**
 * POST /api/canton/swap/quote — indicative same-Canton quote (CBTC↔CC MVP).
 */
import { NextResponse } from "next/server";

import {
  cantonSwapQuoteRateLimitOk,
  clientIpFromRequest
} from "@/lib/canton-swap-rate-limit";
import { quoteMvpCantonSwap } from "@/lib/canton-swap-quote";
import {
  computeC2cSwapNotionalUsd,
  estimateManagedC2cSettleFee,
  estimateToQuoteFields,
  logNetworkFeeEstimate,
  NetworkFeePrepareError,
  shouldQuoteNetworkFee
} from "@/lib/canton-network-fee";
import { expectedCantonSwapParty, requirePartyOwner } from "@/lib/htlc-auth";
import {
  CantonQuoteSanityError,
  CantonQuoteUnavailableError
} from "@/lib/canton-quote";
import { cantonQuoteUnavailableUserMessage } from "@/lib/canton-quote-messages";
import type { CantonSwapMvpAssetId } from "@/lib/canton-swap-types";

export const dynamic = "force-dynamic";

function parseMvpAsset(raw: unknown): CantonSwapMvpAssetId | null {
  if (raw === "CBTC" || raw === "CC") return raw;
  return null;
}

export async function POST(req: Request) {
  try {
    if (!cantonSwapQuoteRateLimitOk(clientIpFromRequest(req))) {
      return NextResponse.json({ error: "rate limit exceeded" }, { status: 429 });
    }

    const body = await req.json();
    const fromAsset = parseMvpAsset(body.fromAsset);
    const toAsset = parseMvpAsset(body.toAsset);
    const amount = body.amount ?? body.inAmount;
    const userParty = body.userParty ? String(body.userParty) : undefined;
    if (!fromAsset || !toAsset || amount == null) {
      return NextResponse.json(
        { error: "missing fromAsset / toAsset / amount" },
        { status: 400 }
      );
    }
    const q = await quoteMvpCantonSwap(fromAsset, toAsset, String(amount));

    let networkFeeFields = estimateToQuoteFields({
      feeCc: "0",
      feeUsd: 0,
      trafficBytes: 0,
      minCcRequired: "0",
      networkFeeSource: "disabled"
    });
    if (shouldQuoteNetworkFee() && userParty) {
      const auth = await requirePartyOwner(userParty);
      if (auth.error) return auth.error;

      const vault = expectedCantonSwapParty();
      if (!vault) {
        return NextResponse.json(
          { error: "CANTON_SWAP_SETTLEMENT_PARTY not configured" },
          { status: 503 }
        );
      }

      try {
        const notionalUsd = await computeC2cSwapNotionalUsd({
          fromAsset,
          inAmount: q.inAmount
        });
        const nf = await estimateManagedC2cSettleFee({
          userParty,
          vaultParty: vault,
          fromAsset,
          toAsset,
          inAmount: q.inAmount,
          outAmount: q.outAmount,
          notionalUsd
        });
        logNetworkFeeEstimate("c2c-quote", nf);
        networkFeeFields = estimateToQuoteFields(nf);
      } catch (e) {
        if (shouldQuoteNetworkFee()) {
          throw e;
        }
        console.warn(
          "[c2c-quote] network fee estimate failed — swap quote still returned:",
          e instanceof Error ? e.message : e
        );
      }
    }

    return NextResponse.json({
      fromAsset,
      toAsset,
      inAmount: q.inAmount,
      outAmount: q.outAmount,
      feeBps: q.feeBps,
      bridgeFeeBps: q.feeBps,
      expires: q.expiresAt,
      quoteSource: q.source,
      ...networkFeeFields
    });
  } catch (e) {
    if (e instanceof NetworkFeePrepareError) {
      return NextResponse.json({ error: e.userMessage }, { status: 400 });
    }
    if (e instanceof CantonQuoteSanityError) {
      return NextResponse.json({ error: e.userMessage }, { status: 503 });
    }
    if (e instanceof CantonQuoteUnavailableError) {
      return NextResponse.json(
        { error: cantonQuoteUnavailableUserMessage(e.message) },
        { status: 503 }
      );
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 }
    );
  }
}

/**
 * POST /api/canton/swap/quote — indicative same-Canton quote (CBTC↔CC MVP).
 */
import { NextResponse } from "next/server";

import { clientIpFromRequest } from "@/lib/canton-swap-rate-limit";
import { distributedRateLimitOk } from "@/lib/api-rate-limit";
import { quoteMvpCantonSwap } from "@/lib/canton-swap-quote";
import {
  computeC2cSwapNotionalUsd,
  estimateManagedC2cSettleFee,
  estimateToQuoteFields,
  isNetworkFeeEnabled,
  logNetworkFeeEstimate,
  NetworkFeePrepareError,
  shouldQuoteNetworkFee
} from "@/lib/canton-network-fee";
import {
  authorizeQuoteParty,
  expectedCantonSwapParty,
  isParticipantManagedParty
} from "@/lib/htlc-auth";
import {
  CantonQuoteSanityError,
  CantonQuoteUnavailableError
} from "@/lib/canton-quote";
import { cantonQuoteUnavailableUserMessage } from "@/lib/canton-quote-messages";
import type { CantonSwapMvpAssetId } from "@/lib/canton-swap-types";
import { assertSwapPayAmountLimit } from "@/lib/swap-amount-limits";
import { NETWORK } from "@/lib/constants";

export const dynamic = "force-dynamic";

function parseMvpAsset(raw: unknown): CantonSwapMvpAssetId | null {
  if (raw === "CBTC" || raw === "CC") return raw;
  return null;
}

function impliedPrice(outAmount: string, inAmount: string): string | undefined {
  const out = Number(outAmount);
  const input = Number(inAmount);
  if (!Number.isFinite(out) || !Number.isFinite(input) || input <= 0) {
    return undefined;
  }
  return (out / input).toPrecision(12);
}

export async function POST(req: Request) {
  try {
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
    const clientIp = clientIpFromRequest(req);
    if (
      !(await distributedRateLimitOk({
        scope: "c2c-quote-ip",
        key: clientIp,
        limit: 30
      }))
    ) {
      return NextResponse.json({ error: "rate limit exceeded" }, { status: 429 });
    }
    if (userParty) {
      const auth = await authorizeQuoteParty(userParty);
      if (auth.error) return auth.error;
      if (
        !(await distributedRateLimitOk({
          scope: "c2c-quote-party",
          key: auth.partyId,
          limit: 30
        }))
      ) {
        return NextResponse.json({ error: "rate limit exceeded" }, { status: 429 });
      }
    }
    assertSwapPayAmountLimit(fromAsset, String(amount));
    const q = await quoteMvpCantonSwap(fromAsset, toAsset, String(amount));

    let networkFeeFields = estimateToQuoteFields({
      feeCc: "0",
      feeUsd: 0,
      trafficBytes: 0,
      minCcRequired: "0",
      networkFeeSource: "disabled"
    });
    if (shouldQuoteNetworkFee() && userParty) {
      const managed = await isParticipantManagedParty(userParty);
      if (managed) {
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
          logNetworkFeeEstimate("c2c-quote managed", nf);
          networkFeeFields = estimateToQuoteFields(nf);
        } catch (e) {
          if (isNetworkFeeEnabled()) {
            throw e;
          }
          console.warn(
            "[c2c-quote] preview network fee estimate failed — swap quote still returned without fee:",
            e instanceof Error ? e.message : e
          );
        }
      }
      // Loop C2C: Canton traffic is billed by Loop wallet on sign — not an Oranj CC line item.
    }

    return NextResponse.json({
      fromAsset,
      toAsset,
      inAmount: q.inAmount,
      outAmount: q.outAmount,
      grossOutAmount: q.grossOutAmount,
      feeBps: q.feeBps,
      bridgeFeeBps: q.feeBps,
      expires: q.expiresAt,
      expiresAt: q.expiresAt,
      quoteSource: q.source,
      quoteAgeMs: q.ageMs,
      quoteStale: q.stale,
      midPrice: impliedPrice(q.grossOutAmount, q.inAmount),
      minReceived: q.outAmount,
      minReceivedToken: toAsset,
      quoteIndicative: NETWORK.name === "devnet",
      quoteNote:
        NETWORK.name === "devnet"
          ? "Devnet C2C quotes use mainnet Tradecraft pricing and are indicative."
          : undefined,
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

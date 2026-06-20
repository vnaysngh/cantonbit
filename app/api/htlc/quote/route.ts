/**
 * POST /api/htlc/quote — RFQ-style quote for cross-chain WBTC↔CBTC swaps.
 */
import { NextResponse } from "next/server";
import {
  authorizeQuoteParty,
  expectedSettlementParty,
  isParticipantManagedParty
} from "@/lib/htlc-auth";
import {
  quoteWbtcToCbtc,
  quoteCbtcToWbtc,
  QuoteUnavailableError,
  DepegError,
  QUOTE_TTL_SECONDS
} from "@/lib/htlc-quote";
import { NETWORK } from "@/lib/constants";
import {
  computeHtlcSwapNotionalUsd,
  estimateHtlcLoopFee,
  estimateHtlcManagedFee,
  estimateToQuoteFields,
  logNetworkFeeEstimate,
  measureAndLogSolverCounterLockTraffic,
  NetworkFeePrepareError,
  shouldQuoteNetworkFee
} from "@/lib/canton-network-fee";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { user, wbtcAmount, cbtcAmount, cantonParty, direction } = body;

    const reverse = direction === "canton-to-evm";
    const inRaw = reverse ? cbtcAmount : wbtcAmount;
    if (!user || !inRaw || !cantonParty) {
      return NextResponse.json(
        { error: "missing user / amount / cantonParty" },
        { status: 400 }
      );
    }
    const partyAuth = await authorizeQuoteParty(String(cantonParty));
    if (partyAuth.error) return partyAuth.error;
    const inUnits = BigInt(inRaw);
    if (inUnits <= 0n) {
      return NextResponse.json({ error: "amount must be > 0" }, { status: 400 });
    }

    const q = reverse
      ? await quoteCbtcToWbtc(inUnits)
      : await quoteWbtcToCbtc(inUnits);

    let networkFeeFields = estimateToQuoteFields({
      feeCc: "0",
      feeUsd: 0,
      trafficBytes: 0,
      minCcRequired: "0",
      networkFeeSource: "disabled"
    });
    const managedQuote = body.counterMode === "managed";
    const cbtcDec = (Number(reverse ? q.inUnits : q.outUnits) / 1e8).toFixed(8);

    if (shouldQuoteNetworkFee()) {
      try {
        if (managedQuote) {
          const action = reverse ? "htlc-lock" : "htlc-claim";
          const notionalUsd = await computeHtlcSwapNotionalUsd(cbtcDec);
          const vaultParty = expectedSettlementParty();
          if (!vaultParty) {
            throw new Error("CANTON_SWAP_SETTLEMENT_PARTY not configured");
          }
          const nf = await estimateHtlcManagedFee({
            action,
            userParty: String(cantonParty),
            solverParty: vaultParty,
            cbtcAmount: cbtcDec,
            notionalUsd
          });
          logNetworkFeeEstimate(`htlc-quote ${action}`, nf);
          networkFeeFields = estimateToQuoteFields(nf);
          if (!reverse) {
            void measureAndLogSolverCounterLockTraffic({
              context: "htlc-quote-projection",
              solverParty: vaultParty,
              userParty: String(cantonParty),
              cbtcAmount: cbtcDec
            });
          }
        } else if (!(await isParticipantManagedParty(String(cantonParty)))) {
          if (!reverse) {
            const notionalUsd = await computeHtlcSwapNotionalUsd(cbtcDec);
            const nf = await estimateHtlcLoopFee({
              action: "htlc-loop-claim",
              userParty: String(cantonParty),
              cbtcAmount: cbtcDec,
              notionalUsd
            });
            logNetworkFeeEstimate("htlc-quote htlc-loop-claim", nf);
            networkFeeFields = estimateToQuoteFields(nf);
          }
        }
      } catch (e) {
        if (shouldQuoteNetworkFee()) {
          if (e instanceof NetworkFeePrepareError) {
            return NextResponse.json({ error: e.userMessage }, { status: 400 });
          }
          throw e;
        }
        console.warn(
          "[htlc-quote] network fee estimate failed — quote still returned:",
          e instanceof Error ? e.message : e
        );
      }
    }

    const order = {
      inputs: [["0", q.inUnits.toString()]],
      outputs: [{ amount: q.outUnits.toString() }]
    };
    return NextResponse.json({
      order,
      direction: reverse ? "canton-to-evm" : "evm-to-canton",
      cantonParty,
      cbtcAmount: (reverse ? q.inUnits : q.outUnits).toString(),
      wbtcAmount: (reverse ? q.outUnits : q.inUnits).toString(),
      wbtc: "",
      wbtcPriceRaw: q.price8.toString(),
      wbtcPriceDecimals: 8,
      expires: q.expiresAt,
      feeBps: q.feeBps,
      bridgeFeeBps: q.feeBps,
      instrument: NETWORK.instrumentId,
      networkFeeExpiresAt:
        shouldQuoteNetworkFee() &&
        networkFeeFields.networkFeeSource !== "disabled"
          ? Math.floor(Date.now() / 1000) + QUOTE_TTL_SECONDS
          : undefined,
      ...networkFeeFields
    });
  } catch (e) {
    if (e instanceof DepegError || e instanceof QuoteUnavailableError) {
      return NextResponse.json({ error: e.message }, { status: 503 });
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 }
    );
  }
}

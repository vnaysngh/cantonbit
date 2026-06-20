/**
 * POST /api/htlc — create an HTLC swap order (Cancore step 1).
 * Order history is GET /api/htlc/history (authenticated), not this route.
 */
import { NextResponse } from "next/server";
import { htlcService } from "@/lib/htlc-service-singleton";
import {
  expectedSettlementParty,
  expectedSolverEvm,
  isParticipantManagedParty,
  requirePartyOwner
} from "@/lib/htlc-auth";
import {
  assertOrderAmounts,
  DepegError,
  QuoteUnavailableError
} from "@/lib/htlc-quote";
import { assertValidTimelocks, MIN_GAP } from "@/lib/htlc-timelock";
import {
  computeHtlcSwapNotionalUsd,
  estimateHtlcLoopFee,
  estimateHtlcManagedFee,
  isNetworkFeeEnabled,
  NetworkFeePrepareError
} from "@/lib/canton-network-fee";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const direction = String(body.direction ?? "");
    if (!body.id || !body.hashLock || !direction) {
      return NextResponse.json({ error: "missing id / direction / hashLock" }, { status: 400 });
    }
    if (direction !== "evm-to-canton" && direction !== "canton-to-evm") {
      return NextResponse.json({ error: "invalid direction" }, { status: 400 });
    }

    const common = ["userTimelock", "userCantonParty", "solverCantonParty", "solverTimelock"];
    for (const k of common) {
      if (body[k] === undefined) {
        return NextResponse.json({ error: `missing ${k}` }, { status: 400 });
      }
    }

    const partyAuth = await requirePartyOwner(String(body.userCantonParty));
    if (partyAuth.error) return partyAuth.error;

    const vaultParty = expectedSettlementParty();
    if (!vaultParty) {
      return NextResponse.json(
        { error: "CANTON_SWAP_SETTLEMENT_PARTY not configured" },
        { status: 503 }
      );
    }
    body.solverCantonParty = vaultParty;

    const evmRequired = [
      "userEvmAddress",
      "solverEvmAddress",
      "wbtcAmount",
      "cbtcAmount"
    ];
    for (const k of evmRequired) {
      if (body[k] === undefined) {
        return NextResponse.json({ error: `missing ${k}` }, { status: 400 });
      }
    }
    const solverEvm = expectedSolverEvm();
    if (solverEvm && String(body.solverEvmAddress).toLowerCase() !== solverEvm.toLowerCase()) {
      return NextResponse.json({ error: "solver EVM address mismatch" }, { status: 403 });
    }

    const now = Math.floor(Date.now() / 1000);
    assertValidTimelocks(now, Number(body.userTimelock), Number(body.solverTimelock), MIN_GAP);
    const cbtcUnits = BigInt(Math.round(parseFloat(String(body.cbtcAmount)) * 1e8));
    await assertOrderAmounts(direction, BigInt(body.wbtcAmount), cbtcUnits);
    body.counterMode = (await isParticipantManagedParty(String(body.userCantonParty)))
      ? "managed"
      : "loop";

    if (isNetworkFeeEnabled() && body.counterMode === "managed") {
      const action =
        direction === "canton-to-evm" ? "htlc-lock" : "htlc-claim";
      const notionalUsd = await computeHtlcSwapNotionalUsd(
        String(body.cbtcAmount)
      );
      const nf = await estimateHtlcManagedFee({
        action,
        userParty: String(body.userCantonParty),
        solverParty: vaultParty,
        cbtcAmount: String(body.cbtcAmount),
        notionalUsd
      });
      body.networkFeeCc = nf.feeCc;
      // Fee bound lasts for the order window (claim/lock), not the 60s RFQ preview TTL.
      body.networkFeeExpiresAt = Number(body.userTimelock);
    }

    if (isNetworkFeeEnabled() && body.counterMode === "loop" && direction === "evm-to-canton") {
      const notionalUsd = await computeHtlcSwapNotionalUsd(
        String(body.cbtcAmount)
      );
      const nf = await estimateHtlcLoopFee({
        action: "htlc-loop-claim",
        userParty: String(body.userCantonParty),
        cbtcAmount: String(body.cbtcAmount),
        notionalUsd
      });
      body.networkFeeCc = nf.feeCc;
      body.networkFeeExpiresAt = Number(body.userTimelock);
    }

    const order = await htlcService().createOrder(body);
    return NextResponse.json({ order });
  } catch (e) {
    if (e instanceof NetworkFeePrepareError) {
      return NextResponse.json({ error: e.userMessage }, { status: 400 });
    }
    if (e instanceof QuoteUnavailableError || e instanceof DepegError) {
      return NextResponse.json({ error: e.message }, { status: 503 });
    }
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("another party")) {
      return NextResponse.json({ error: msg }, { status: 403 });
    }
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

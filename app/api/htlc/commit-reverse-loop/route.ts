/**
 * POST /api/htlc/commit-reverse-loop — create reverse HTLC only after verified Loop CBTC payment.
 */
import { NextResponse } from "next/server";
import { htlcService } from "@/lib/htlc-service-singleton";
import {
  expectedSettlementParty,
  expectedSolverEvm,
  requireHtlcCommitRateLimit,
  requirePartyOwner
} from "@/lib/htlc-auth";
import { assertOrderAmounts } from "@/lib/htlc-quote";
import { assertValidTimelocks, MIN_GAP } from "@/lib/htlc-timelock";
import { toBaseUnits } from "@/lib/amount-units";
import { assertSwapPayAmountLimit } from "@/lib/swap-amount-limits";
import { bindEnabledHtlcEvmChain } from "@/lib/htlc-chain-binding";
import { crossChainDisabledResponse } from "@/lib/swap-feature-flags-server";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const blocked = crossChainDisabledResponse(body.evmChain);
    if (blocked) return blocked;
    const direction = "canton-to-evm";
    const id = String(body.id ?? body.hashLock).toLowerCase();
    const hashLock = String(body.hashLock).toLowerCase();
    const submitUpdateId = String(body.submitUpdateId ?? "").trim();
    if (!/^0x[0-9a-f]{64}$/.test(hashLock) || id !== hashLock) {
      return NextResponse.json({ error: "invalid hashLock/id" }, { status: 400 });
    }
    if (!submitUpdateId) {
      return NextResponse.json({ error: "missing submitUpdateId" }, { status: 400 });
    }
    const createdAt = Math.floor(Number(body.createdAt));
    if (!Number.isFinite(createdAt) || createdAt <= 0) {
      return NextResponse.json({ error: "invalid createdAt" }, { status: 400 });
    }
    const auth = await requirePartyOwner(String(body.userCantonParty));
    if (auth.error) return auth.error;
    const rateLimit = await requireHtlcCommitRateLimit(auth.partyId);
    if (rateLimit) return rateLimit.error;
    const vault = expectedSettlementParty();
    const solverEvm = expectedSolverEvm();
    if (!vault || !solverEvm) {
      return NextResponse.json({ error: "solver not configured" }, { status: 503 });
    }
    const { fields: evmChainFields } = bindEnabledHtlcEvmChain(body.evmChain);
    const now = Math.floor(Date.now() / 1000);
    assertValidTimelocks(
      now,
      Number(body.userTimelock),
      Number(body.solverTimelock),
      MIN_GAP
    );
    const wbtcUnits = BigInt(body.wbtcAmount);
    const cbtcUnits = toBaseUnits(String(body.cbtcAmount), 8);
    assertSwapPayAmountLimit("CBTC", String(body.cbtcAmount));
    await assertOrderAmounts(direction, wbtcUnits, cbtcUnits);
    const order = await htlcService().commitReverseLoopOrder(
      {
        id,
        direction,
        hashLock: hashLock as `0x${string}`,
        userEvmAddress: String(body.userEvmAddress).toLowerCase(),
        solverEvmAddress: solverEvm.toLowerCase(),
        wbtcAmount: wbtcUnits.toString(),
        userTimelock: Number(body.userTimelock),
        userCantonParty: String(body.userCantonParty),
        solverCantonParty: vault,
        cbtcAmount: String(body.cbtcAmount),
        solverTimelock: Number(body.solverTimelock),
        counterMode: "loop",
        ...evmChainFields
      },
      {
        createdAt,
        submitUpdateId,
        offerCidHint: body.offerCidHint
          ? String(body.offerCidHint)
          : undefined
      }
    );
    return NextResponse.json({ order });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 }
    );
  }
}

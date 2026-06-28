/**
 * POST /api/htlc/commit-forward — bind verified WBTC lock after prepare-forward-intent.
 */
import { NextResponse } from "next/server";
import { htlcService } from "@/lib/htlc-service-singleton";
import {
  expectedSettlementParty,
  expectedSolverEvm,
  isParticipantManagedParty,
  requireHtlcCommitRateLimit,
  requirePartyOwner
} from "@/lib/htlc-auth";
import { assertOrderAmounts } from "@/lib/htlc-quote";
import { assertValidTimelocks, MIN_GAP } from "@/lib/htlc-timelock";
import { toBaseUnits } from "@/lib/amount-units";
import {
  assertSwapPayAmountLimit,
  assertSwapPayAmountLimitUnits
} from "@/lib/swap-amount-limits";
import { bindEnabledHtlcEvmChain } from "@/lib/htlc-chain-binding";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const direction = "evm-to-canton";
    const id = String(body.id ?? body.hashLock).toLowerCase();
    const hashLock = String(body.hashLock).toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(hashLock) || id !== hashLock) {
      return NextResponse.json({ error: "invalid hashLock/id" }, { status: 400 });
    }
    const mainLockTx = String(body.mainLockTx ?? "");
    if (!mainLockTx) {
      return NextResponse.json({ error: "missing mainLockTx" }, { status: 400 });
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
    assertSwapPayAmountLimitUnits("WBTC", wbtcUnits);
    await assertOrderAmounts(direction, wbtcUnits, cbtcUnits);
    const counterMode = (await isParticipantManagedParty(String(body.userCantonParty)))
      ? "managed"
      : "loop";
    const order = await htlcService().commitForwardOrder(
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
        counterMode,
        ...evmChainFields
      },
      mainLockTx
    );
    return NextResponse.json({ order });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 }
    );
  }
}

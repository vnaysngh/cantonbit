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
import { toBaseUnits } from "@/lib/amount-units";
import {
  assertSwapPayAmountLimit,
  assertSwapPayAmountLimitUnits
} from "@/lib/swap-amount-limits";
import {
  computeHtlcSwapNotionalUsd,
  estimateHtlcManagedFee,
  isNetworkFeeEnabled,
  NetworkFeePrepareError
} from "@/lib/canton-network-fee";
import { distributedRateLimitOk } from "@/lib/api-rate-limit";
import { bindEnabledHtlcEvmChain } from "@/lib/htlc-chain-binding";
import { crossChainDisabledResponse } from "@/lib/swap-feature-flags-server";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const blocked = crossChainDisabledResponse(body.evmChain);
    if (blocked) return blocked;
    const direction = String(body.direction ?? "");
    if (!body.id || !body.hashLock || !direction) {
      return NextResponse.json({ error: "missing id / direction / hashLock" }, { status: 400 });
    }
    if (direction !== "evm-to-canton" && direction !== "canton-to-evm") {
      return NextResponse.json({ error: "invalid direction" }, { status: 400 });
    }
    const id = String(body.id).toLowerCase();
    const hashLock = String(body.hashLock).toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(hashLock) || id !== hashLock) {
      return NextResponse.json(
        { error: "id must equal a 32-byte hashLock" },
        { status: 400 }
      );
    }
    body.id = id;
    body.hashLock = hashLock;

    const common = ["userTimelock", "userCantonParty", "solverCantonParty", "solverTimelock"];
    for (const k of common) {
      if (body[k] === undefined) {
        return NextResponse.json({ error: `missing ${k}` }, { status: 400 });
      }
    }

    const partyAuth = await requirePartyOwner(String(body.userCantonParty));
    if (partyAuth.error) return partyAuth.error;
    if (
      !(await distributedRateLimitOk({
        scope: "htlc-create",
        key: partyAuth.partyId,
        limit: 12
      }))
    ) {
      return NextResponse.json({ error: "rate limit exceeded" }, { status: 429 });
    }

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
    if (!solverEvm) {
      return NextResponse.json(
        { error: "solver EVM address not configured" },
        { status: 503 }
      );
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(body.userEvmAddress))) {
      return NextResponse.json({ error: "invalid user EVM address" }, { status: 400 });
    }
    if (String(body.solverEvmAddress).toLowerCase() !== solverEvm.toLowerCase()) {
      return NextResponse.json({ error: "solver EVM address mismatch" }, { status: 403 });
    }
    body.userEvmAddress = String(body.userEvmAddress).toLowerCase();
    body.solverEvmAddress = solverEvm.toLowerCase();
    const { fields: evmChainFields } = bindEnabledHtlcEvmChain(body.evmChain);
    Object.assign(body, evmChainFields);

    const now = Math.floor(Date.now() / 1000);
    assertValidTimelocks(now, Number(body.userTimelock), Number(body.solverTimelock), MIN_GAP);
    // cbtcAmount is a decimal-BTC string (client sends (units/1e8).toFixed(8)).
    // Use the integer-exact toBaseUnits (8dp) instead of float parseFloat*1e8 — the
    // latter reintroduces rounding into the anti-manipulation guard and would be
    // 1e8x off if a caller ever passed an already-base-unit string. toBaseUnits also
    // validates the input shape (rejects junk / >8dp).
    let cbtcUnits: bigint;
    try {
      cbtcUnits = toBaseUnits(String(body.cbtcAmount), 8);
    } catch {
      return NextResponse.json({ error: "invalid cbtcAmount" }, { status: 400 });
    }
    let wbtcUnits: bigint;
    try {
      wbtcUnits = BigInt(body.wbtcAmount);
    } catch {
      return NextResponse.json({ error: "invalid wbtcAmount" }, { status: 400 });
    }
    if (direction === "evm-to-canton") {
      assertSwapPayAmountLimitUnits("WBTC", wbtcUnits);
    } else {
      assertSwapPayAmountLimit("CBTC", String(body.cbtcAmount));
    }
    await assertOrderAmounts(direction, wbtcUnits, cbtcUnits);
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

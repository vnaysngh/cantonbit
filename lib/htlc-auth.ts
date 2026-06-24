import "server-only";

import { NextResponse } from "next/server";

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { resolveSessionParty } from "@/lib/session-party";
import { getJwtSession, loopApiBase } from "@/lib/swap-session";
import { htlcService, type SwapOrder } from "@/lib/htlc-service-singleton";
import { isBearerAuthorized } from "@/lib/htlc-auth-logic";
import { distributedRateLimitOk } from "@/lib/api-rate-limit";

type GuardOk<T = unknown> = T & { error: null };
type GuardErr = { error: NextResponse };

function unauthorized(message = "Unauthorized", status = 401): GuardErr {
  return { error: NextResponse.json({ error: message }, { status }) };
}

export function daemonSecret(): string {
  return (
    process.env.HTLC_DAEMON_SECRET?.trim() ||
    process.env.CRON_SECRET?.trim() ||
    ""
  );
}

export function isDaemonAuthorized(req: Request): boolean {
  const secret = daemonSecret();
  return isBearerAuthorized({
    header: req.headers.get("authorization"),
    secret,
    nodeEnv: process.env.NODE_ENV,
  });
}

export function requireDaemon(req: Request): GuardOk | GuardErr {
  if (isDaemonAuthorized(req)) return { error: null };
  return unauthorized("Daemon authorization required");
}

/** Email/participant-managed party hosted on our warpx node (backend CanActAs). */
export async function isParticipantManagedParty(party: string): Promise<boolean> {
  if (!party.includes("::")) return false;
  const sb = await createSupabaseServiceClient();
  const { data } = await sb
    .from("party_mappings")
    .select("party_hint")
    .eq("canton_party_id", party)
    .eq("party_hint", "participant-managed")
    .maybeSingle();
  return !!data;
}

export function loopProfileParty(profile: unknown): string | null {
  const p = profile as Record<string, unknown>;
  const account = (p.account ?? {}) as Record<string, unknown>;
  const user = (p.user ?? {}) as Record<string, unknown>;
  const wallet = (p.wallet ?? {}) as Record<string, unknown>;
  const candidates = [
    p.party_id,
    p.partyId,
    p.party,
    p.canton_party_id,
    account.party_id,
    account.partyId,
    user.party_id,
    user.partyId,
    wallet.party_id,
    wallet.partyId,
  ];
  return candidates.find((x): x is string => typeof x === "string" && x.includes("::")) ?? null;
}

async function resolveLoopSessionParty(): Promise<string | null> {
  const apiKey = await getJwtSession();
  if (!apiKey) return null;
  const res = await fetch(`${loopApiBase()}/api/v1/profile`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    cache: "no-store",
  });
  if (!res.ok) return null;
  return loopProfileParty(await res.json().catch(() => ({})));
}

export async function requirePartyOwner(party: string): Promise<GuardOk<{ partyId: string }> | GuardErr> {
  if (!party || !party.includes("::")) return unauthorized("Invalid Canton party", 400);

  if (await isParticipantManagedParty(party)) {
    const session = await resolveSessionParty(party);
    if (session.error) return { error: session.error };
    return { partyId: session.partyId, error: null };
  }

  const loopParty = await resolveLoopSessionParty();
  if (!loopParty) return unauthorized("Loop wallet session required");
  if (loopParty !== party) return unauthorized("Requested party does not match the connected Loop wallet.", 403);
  return { partyId: loopParty, error: null };
}

/**
 * Read-only quote / fee-estimate auth. Participant-managed still needs email session;
 * Loop wallet parties only need a valid party id (submit paths keep requirePartyOwner).
 */
export async function authorizeQuoteParty(
  party: string
): Promise<GuardOk<{ partyId: string }> | GuardErr> {
  if (!party || !party.includes("::")) return unauthorized("Invalid Canton party", 400);
  if (await isParticipantManagedParty(party)) {
    return requirePartyOwner(party);
  }
  return { partyId: party, error: null };
}

export async function requireOrderOwner(id: string): Promise<GuardOk<{ order: SwapOrder }> | GuardErr> {
  const order = await htlcService().peekOrder(id);
  if (!order) return unauthorized("not found", 404);
  const owner = await requirePartyOwner(order.userCantonParty);
  if (owner.error) return owner;
  if (
    !(await distributedRateLimitOk({
      scope: "htlc-order-owner",
      key: owner.partyId,
      limit: 120
    }))
  ) {
    return unauthorized("rate limit exceeded", 429);
  }
  return { order, error: null };
}

export async function requireOrderOwnerOrDaemon(req: Request, id: string): Promise<GuardOk<{ order: SwapOrder; daemon: boolean }> | GuardErr> {
  const order = await htlcService().peekOrder(id);
  if (!order) return unauthorized("not found", 404);
  if (isDaemonAuthorized(req)) return { order, daemon: true, error: null };
  const owner = await requirePartyOwner(order.userCantonParty);
  if (owner.error) return owner;
  if (
    !(await distributedRateLimitOk({
      scope: "htlc-order-owner",
      key: owner.partyId,
      limit: 120
    }))
  ) {
    return unauthorized("rate limit exceeded", 429);
  }
  return { order, daemon: false, error: null };
}

/** WarpX node party (legacy public label). Not used for swap vault float. */
export function expectedSolverCanton(): string {
  return process.env.SOLVER_CANTON_PARTY ?? process.env.NEXT_PUBLIC_SOLVER_CANTON ?? "";
}

/** Settlement vault — receives user legs and pays counter legs (C2C + HTLC). */
export function expectedSettlementParty(): string {
  return (
    process.env.CANTON_SWAP_SETTLEMENT_PARTY?.trim() ||
    process.env.NEXT_PUBLIC_CANTON_SWAP_SETTLEMENT_PARTY?.trim() ||
    ""
  );
}

/** HTLC CBTC float / allocate / deliver — same vault as C2C. */
export function expectedHtlcVaultParty(): string {
  return expectedSettlementParty();
}

/** Single funded vault for all same-Canton swap receive/send (Loop + managed). */
export function expectedCantonSwapParty(): string {
  return expectedSettlementParty();
}

export function expectedSolverEvm(): string {
  return process.env.SOLVER_EVM ?? process.env.NEXT_PUBLIC_SOLVER_EVM ?? "";
}

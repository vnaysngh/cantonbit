import "server-only";

import { NextResponse } from "next/server";

import type { CantonSwapOrder } from "@/lib/canton-swap-types";
import { requireDaemon, requirePartyOwner } from "@/lib/htlc-auth";

type GuardOk = { error: null };
type GuardErr = { error: NextResponse };

/** User-only — daemon must not act on behalf of the user (settle, confirm legs, etc.). */
export async function requireOrderOwner(
  _req: Request,
  order: CantonSwapOrder
): Promise<GuardOk | GuardErr> {
  const owner = await requirePartyOwner(order.userParty);
  if (owner.error) return owner;
  return { error: null };
}

/** Solver fill must be daemon-only — users must not trigger atomic fill. */
export function requireDaemonOnly(req: Request): GuardOk | GuardErr {
  return requireDaemon(req);
}

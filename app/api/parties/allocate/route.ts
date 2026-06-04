/**
 * POST /api/parties/allocate  — DEPRECATED.
 *
 * The app no longer creates Canton parties on our own validator. A user's
 * Canton identity now comes from their connected Loop wallet, registered via
 * POST /api/parties/register-loop. This endpoint is kept only so any stale
 * caller gets a clear, non-crashing response instead of a 404.
 */

import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json(
    {
      error:
        "Deprecated: parties are no longer allocated server-side. Connect a Loop wallet; it is registered via /api/parties/register-loop.",
    },
    { status: 410 }, // Gone
  );
}

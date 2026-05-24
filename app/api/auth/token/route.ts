import { NextResponse } from "next/server";

import { describeCachedToken, getLedgerJwt } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * Debug-only health endpoint.
 *
 * Returns cache metadata (NOT the JWT) so we can verify the server-side
 * token fetch is working without leaking the bearer token to the browser.
 *
 * To return the raw token (local dev only), set ALLOW_TOKEN_LEAK=true AND
 * send header `x-token-leak-ack: i-know-what-im-doing`. Production deploys
 * must leave ALLOW_TOKEN_LEAK unset.
 */
export async function GET(request: Request) {
  try {
    await getLedgerJwt();

    const meta = describeCachedToken();

    const leakAllowed =
      process.env.ALLOW_TOKEN_LEAK === "true" &&
      request.headers.get("x-token-leak-ack") === "i-know-what-im-doing";

    if (leakAllowed) {
      const accessToken = await getLedgerJwt();
      return NextResponse.json({ ...meta, accessToken });
    }

    return NextResponse.json(meta);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

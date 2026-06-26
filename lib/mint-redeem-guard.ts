import "server-only";

import { NextResponse } from "next/server";

import { distributedRateLimitOk } from "@/lib/api-rate-limit";
import { clientIpFromRequest } from "@/lib/canton-swap-rate-limit";
import { mainnetBlockedResponse } from "@/lib/mainnet-guard";

/** M-6: rate limit mint/redeem routes by IP and optional authenticated party. */
export async function requireMintRedeemRateLimit(
  req: Request,
  partyId?: string
): Promise<NextResponse | null> {
  const mainnetBlocked = mainnetBlockedResponse();
  if (mainnetBlocked) return mainnetBlocked;

  if (
    !(await distributedRateLimitOk({
      scope: "mint-redeem-ip",
      key: clientIpFromRequest(req),
      limit: 20
    }))
  ) {
    return NextResponse.json({ error: "rate limit exceeded" }, { status: 429 });
  }
  if (
    partyId &&
    !(await distributedRateLimitOk({
      scope: "mint-redeem-party",
      key: partyId,
      limit: 20
    }))
  ) {
    return NextResponse.json({ error: "rate limit exceeded" }, { status: 429 });
  }
  return null;
}

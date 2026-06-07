/**
 * Server-side Loop JWT session for the swap flow.
 *
 * The user signs the "Exchange API Key" message ONCE (right after wallet
 * connect). We exchange that signature for a Loop JWT (`api_key`), then cache the
 * JWT in an httpOnly cookie keyed to their browser session. Every subsequent
 * server read of the user's Loop profile (/profile, auto-accept gate) and
 * transfer history (/history) reuses the cached JWT — NO further wallet
 * signatures during the swap.
 *
 * Why httpOnly cookie (not browser storage): the JWT is a bearer token over the
 * user's Loop account. Keeping it httpOnly means browser JS can never read it
 * (XSS-safe) and it's sent automatically on same-origin requests to our API
 * routes. It is re-minted only when it expires (the JWT's own `exp`, hours away).
 *
 * This module is server-only (it sets cookies + talks to Loop). Import it only
 * from route handlers.
 */
import { cookies } from "next/headers";

import { NETWORK } from "@/lib/constants";

/** Loop backend base, per network (matches the SDK's apiUrl). */
const LOOP_API: Record<string, string> = {
  mainnet: "https://cantonloop.com",
  testnet: "https://testnet.cantonloop.com",
  devnet: "https://devnet.cantonloop.com",
};

export function loopApiBase(): string {
  return LOOP_API[NETWORK.name] ?? LOOP_API.mainnet;
}

/** The httpOnly cookie name holding the minted Loop JWT for the swap session. */
const COOKIE_NAME = "oranj_loop_jwt";

/** The "Exchange API Key" signature the browser produces (see lib/swap-accept.ts). */
export interface ExchangeSig {
  public_key: string;
  signature: string;
  epoch: number;
}

/**
 * Exchange a wallet signature for a Loop JWT (`api_key`). Returns the JWT string
 * or null if the exchange failed. (No caching — the caller decides what to do.)
 */
export async function exchangeForJwt(sig: ExchangeSig): Promise<string | null> {
  try {
    const res = await fetch(`${loopApiBase()}/api/v1/.connect/pair/apikey`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sig),
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as { api_key?: string };
    return body.api_key ?? null;
  } catch {
    return null;
  }
}

/**
 * Decode a JWT's `exp` (seconds since epoch). Returns null if it can't be parsed
 * (we then treat it as short-lived and re-mint sooner rather than trust it).
 */
function jwtExpSeconds(jwt: string): number | null {
  try {
    const payload = jwt.split(".")[1];
    if (!payload) return null;
    const json = Buffer.from(payload, "base64url").toString("utf8");
    const exp = (JSON.parse(json) as { exp?: number }).exp;
    return typeof exp === "number" ? exp : null;
  } catch {
    return null;
  }
}

/**
 * Mint a JWT from the signature and store it in the httpOnly session cookie.
 * The cookie's maxAge tracks the JWT's own `exp` (minus a small skew) so the
 * cookie never outlives the token. Returns true on success.
 */
export async function storeJwtSession(sig: ExchangeSig): Promise<boolean> {
  const jwt = await exchangeForJwt(sig);
  if (!jwt) return false;

  const exp = jwtExpSeconds(jwt);
  const nowSec = Math.floor(Date.now() / 1000);
  // Cookie lifetime: until the JWT expires, with a 60s safety skew. If we
  // couldn't read exp, default to 1h (Loop JWTs are multi-hour; 1h is a safe
  // floor that still removes the per-swap prompt).
  const maxAge = exp ? Math.max(0, exp - nowSec - 60) : 60 * 60;
  if (maxAge <= 0) return false; // already-expired token — don't store it

  const store = await cookies();
  store.set(COOKIE_NAME, jwt, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge,
  });
  return true;
}

/**
 * Read a still-valid JWT from the session cookie, or null if absent/expired.
 * Callers that get null should respond with 401 so the client re-mints (one
 * signature) and retries.
 */
export async function getJwtSession(): Promise<string | null> {
  const store = await cookies();
  const jwt = store.get(COOKIE_NAME)?.value;
  if (!jwt) return null;
  // Defense in depth: even though the cookie maxAge tracks exp, re-check the
  // token's own exp in case of clock skew / a stale cookie.
  const exp = jwtExpSeconds(jwt);
  if (exp != null && exp <= Math.floor(Date.now() / 1000)) return null;
  return jwt;
}

/** Clear the session cookie (on logout). */
export async function clearJwtSession(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}

import "server-only";

import { JWT_REFRESH_BUFFER_SECONDS } from "./constants";

interface CachedToken {
  accessToken: string;
  expiresAt: number; // ms since epoch
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type?: string;
}

let cached: CachedToken | null = null;
let inflight: Promise<CachedToken> | null = null;

function readEnv(): {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
} {
  const tokenUrl = process.env.KEYCLOAK_TOKEN_URL;
  const clientId = process.env.KEYCLOAK_CLIENT_ID;
  const clientSecret = process.env.KEYCLOAK_CLIENT_SECRET;
  const scope = process.env.KEYCLOAK_SCOPE ?? "daml_ledger_api";

  if (!tokenUrl || !clientId || !clientSecret) {
    throw new Error(
      "Missing Authentik OAuth env vars: KEYCLOAK_TOKEN_URL, KEYCLOAK_CLIENT_ID, KEYCLOAK_CLIENT_SECRET must all be set.",
    );
  }

  return { tokenUrl, clientId, clientSecret, scope };
}

function isFresh(token: CachedToken, nowMs: number): boolean {
  const bufferMs = JWT_REFRESH_BUFFER_SECONDS * 1000;
  return token.expiresAt - nowMs > bufferMs;
}

async function fetchNewToken(): Promise<CachedToken> {
  const { tokenUrl, clientId, clientSecret, scope } = readEnv();

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope,
  });

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "<no body>");
    throw new Error(
      `Authentik token request failed (${res.status} ${res.statusText}): ${text}`,
    );
  }

  const data = (await res.json()) as TokenResponse;
  if (!data.access_token || typeof data.expires_in !== "number") {
    throw new Error("Authentik token response missing access_token or expires_in");
  }

  return {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

/**
 * Returns a valid Ledger-API JWT. In-memory cached; refreshes when within
 * JWT_REFRESH_BUFFER_SECONDS of expiry. Concurrent callers share one inflight
 * refresh so we don't stampede Authentik on cold start.
 */
export async function getLedgerJwt(): Promise<string> {
  const now = Date.now();

  if (cached && isFresh(cached, now)) {
    return cached.accessToken;
  }

  if (!inflight) {
    inflight = fetchNewToken()
      .then((token) => {
        cached = token;
        return token;
      })
      .finally(() => {
        inflight = null;
      });
  }

  const token = await inflight;
  return token.accessToken;
}

/** For diagnostics only — never expose to the browser. */
export function describeCachedToken(): {
  cached: boolean;
  expiresInSeconds: number | null;
} {
  if (!cached) return { cached: false, expiresInSeconds: null };
  return {
    cached: true,
    expiresInSeconds: Math.max(0, Math.round((cached.expiresAt - Date.now()) / 1000)),
  };
}

/** Test/dev only — force the next call to re-fetch. */
export function invalidateLedgerJwtCache(): void {
  cached = null;
}

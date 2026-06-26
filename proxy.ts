/**
 * Next.js middleware — runs on every request before the page renders.
 *
 * The app NO LONGER gates on a Supabase login. Identity comes from connecting
 * the Loop wallet (client-side). This middleware only refreshes the Supabase
 * session cookie when one happens to exist (so any legacy session stays valid),
 * and never redirects to /login. The gating ("connect your Loop wallet to use
 * the app") is handled in the UI.
 */

import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

import { loopWebBase, NETWORK } from "@/lib/constants";
import { mainnetBlockedResponse } from "@/lib/mainnet-guard";

export async function proxy(request: NextRequest) {
  const blocked = mainnetGuardForRequest(request);
  if (blocked) return blocked;

  const nonce = crypto.randomUUID().replaceAll("-", "");
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set(
    "Content-Security-Policy",
    buildContentSecurityPolicy(nonce)
  );
  const nextResponse = () =>
    NextResponse.next({ request: { headers: requestHeaders } });
  let supabaseResponse = nextResponse();

  // Refresh the Supabase session cookie if present (no redirect either way).
  // Wrapped defensively: a missing/invalid session must never block a request.
  try {
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return request.cookies.getAll();
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value }) =>
              request.cookies.set(name, value),
            );
            supabaseResponse = nextResponse();
            cookiesToSet.forEach(({ name, value, options }) =>
              supabaseResponse.cookies.set(name, value, options),
            );
          },
        },
      },
    );
    await supabase.auth.getUser();
  } catch {
    // No/invalid session — fine; the app is open and gates on Loop connect.
  }

  applySecurityHeaders(supabaseResponse, nonce);
  return supabaseResponse;
}

function buildContentSecurityPolicy(nonce: string): string {
  const production = process.env.NODE_ENV === "production";
  const connectSrc = cspConnectSrc();
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${production ? "" : " 'unsafe-eval'"}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    connectSrc,
    "frame-src 'self' https:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ];
  if (production) {
    // Next.js may use Trusted Types internally; do NOT set
    // require-trusted-types-for 'script' — @fivenorth/loop-sdk injects scripts
    // via script.src and fails with "TrustedScriptURL assignment" in production.
    directives.push("trusted-types nextjs nextjs#bundler", "upgrade-insecure-requests");
  }
  return directives.join("; ");
}

function mainnetGuardForRequest(request: NextRequest): NextResponse | null {
  const path = request.nextUrl.pathname;
  if (!path.startsWith("/api/")) return null;
  const guarded =
    path.startsWith("/api/htlc") ||
    path.startsWith("/api/canton/swap") ||
    path.startsWith("/api/mint") ||
    path.startsWith("/api/redeem") ||
    path.startsWith("/api/transfers") ||
    path.startsWith("/api/parties");
  if (!guarded) return null;
  return mainnetBlockedResponse();
}

function cspConnectSrc(): string {
  const origins = new Set<string>(["'self'"]);
  const add = (url: string | undefined) => {
    if (!url) return;
    try {
      origins.add(new URL(url).origin);
    } catch {
      /* ignore malformed env URLs */
    }
  };
  add(process.env.NEXT_PUBLIC_SUPABASE_URL);
  add(NETWORK.ledgerHost);
  add(NETWORK.validatorHost);
  add(NETWORK.registryUrl);
  add(NETWORK.ccRegistryUrl);
  add(NETWORK.coordinatorUrl);
  add(loopWebBase());
  for (const extra of (process.env.CSP_CONNECT_SRC_EXTRA ?? "").split(",")) {
    const trimmed = extra.trim();
    if (trimmed) origins.add(trimmed);
  }
  const supabase = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (supabase?.startsWith("https://")) {
    origins.add(`${supabase.replace("https://", "wss://")}/realtime/v1/websocket`);
  }
  return `connect-src ${[...origins].join(" ")}`;
}

function applySecurityHeaders(response: NextResponse, nonce: string): void {
  response.headers.set(
    "Content-Security-Policy",
    buildContentSecurityPolicy(nonce)
  );
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=()"
  );
  response.headers.set("Cross-Origin-Opener-Policy", "same-origin");
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};

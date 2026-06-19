/**
 * Server-side proxy to the solver HTTP API.
 *
 * Why this exists: on Railway (and any split-service deploy) the solver runs as a
 * PRIVATE service the browser can't reach directly — and we don't want to expose
 * the solver (which has a rate-limiter but no auth) to the public internet. This
 * route forwards /api/solver/<path> from the browser to the private solver over
 * the server-side network, so the browser only ever talks to our own origin.
 *
 * The client (lib/swap-api.ts) points SWAP_API_URL at "/api/solver", so e.g.
 *   browser → POST /api/solver/quote  →  this route  →  POST <SOLVER>/quote
 *
 * SOLVER_INTERNAL_URL is the private solver base (e.g. Railway's
 * http://oranjswap-solver.railway.internal:PORT). Falls back to the public
 * NEXT_PUBLIC_SWAP_API_URL or localhost for local dev so nothing breaks there.
 */
import { type NextRequest, NextResponse } from "next/server";

import { isSolverProxyPathAllowed } from "@/lib/solver-proxy-allowlist";

// Always run dynamically (no caching of swap state) on the Node runtime (needs fetch
// to a private host).
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function solverBase(): string {
  return (
    process.env.SOLVER_INTERNAL_URL ??
    process.env.NEXT_PUBLIC_SWAP_API_URL ??
    "http://localhost:8787"
  ).replace(/\/$/, "");
}

/** Forward the request to the solver, preserving method/body/query, return its JSON. */
async function forward(req: NextRequest, path: string[]): Promise<NextResponse> {
  if (!isSolverProxyPathAllowed(path)) {
    return NextResponse.json({ error: "path not allowed" }, { status: 403 });
  }
  const base = solverBase();
  const suffix = path.join("/");
  const search = req.nextUrl.search; // preserve any query string
  const target = `${base}/${suffix}${search}`;

  const init: RequestInit = {
    method: req.method,
    headers: { "content-type": "application/json" },
    // GET/HEAD must not carry a body.
    body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.text(),
  };

  try {
    const res = await fetch(target, init);
    const text = await res.text();
    // Pass the solver's status + JSON body straight through.
    return new NextResponse(text, {
      status: res.status,
      headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
    });
  } catch (e) {
    return NextResponse.json(
      { error: `solver unreachable: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 },
    );
  }
}

type Ctx = { params: Promise<{ path: string[] }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const { path } = await ctx.params;
  return forward(req, path);
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { path } = await ctx.params;
  return forward(req, path);
}

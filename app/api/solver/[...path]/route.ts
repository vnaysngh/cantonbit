/**
 * Server-side proxy to the solver HTTP API.
 */
import { type NextRequest, NextResponse } from "next/server";

import { requireDaemon } from "@/lib/htlc-auth";
import { isSolverProxyPathAllowed } from "@/lib/solver-proxy-allowlist";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function solverBase(): string {
  return (
    process.env.SOLVER_INTERNAL_URL ??
    process.env.NEXT_PUBLIC_SWAP_API_URL ??
    "http://localhost:8787"
  ).replace(/\/$/, "");
}

function isSolverMutation(path: string[], method: string): boolean {
  if (method !== "POST") return false;
  return (
    path.length === 3 &&
    path[0] === "orders" &&
    (path[2] === "accepted" || path[2] === "refund")
  );
}

async function forward(req: NextRequest, path: string[]): Promise<NextResponse> {
  if (!isSolverProxyPathAllowed(path)) {
    return NextResponse.json({ error: "path not allowed" }, { status: 403 });
  }
  if (isSolverMutation(path, req.method)) {
    const auth = requireDaemon(req);
    if (auth.error) return auth.error;
  }
  const base = solverBase();
  const suffix = path.join("/");
  const search = req.nextUrl.search;
  const target = `${base}/${suffix}${search}`;

  const init: RequestInit = {
    method: req.method,
    headers: { "content-type": "application/json" },
    body:
      req.method === "GET" || req.method === "HEAD"
        ? undefined
        : await req.text(),
    // Bound the proxied call so a hung-but-connected solver can't pin the worker.
    signal: AbortSignal.timeout(20_000)
  };

  try {
    const res = await fetch(target, init);
    const text = await res.text();
    return new NextResponse(text, {
      status: res.status,
      headers: {
        "content-type": res.headers.get("content-type") ?? "application/json"
      }
    });
  } catch (e) {
    // Do NOT leak the raw error (it contains SOLVER_INTERNAL_URL host:port). Log it
    // server-side; return a generic message.
    console.error("[solver-proxy] forward failed:", e);
    const timedOut = e instanceof Error && e.name === "TimeoutError";
    return NextResponse.json(
      { error: timedOut ? "solver timed out" : "solver unreachable" },
      { status: 504 }
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

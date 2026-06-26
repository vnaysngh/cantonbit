/**
 * Server-side proxy to the solver HTTP API.
 */
import { type NextRequest, NextResponse } from "next/server";

import { requireDaemon, requirePartyOwner } from "@/lib/htlc-auth";
import { isSolverProxyPathAllowed } from "@/lib/solver-proxy-allowlist";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function solverBase(): string {
  const configured = process.env.SOLVER_INTERNAL_URL?.trim();
  const raw =
    configured ||
    (process.env.NODE_ENV === "production" ? "" : "http://localhost:8787");
  if (!raw) {
    throw new Error(
      "SOLVER_INTERNAL_URL must be set for the server-side solver proxy"
    );
  }
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("SOLVER_INTERNAL_URL must be an http(s) URL");
  }
  return url.toString().replace(/\/$/, "");
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
  let search = req.nextUrl.search;
  if (req.method === "GET" && path[0] === "orders") {
    if (path.length === 1) {
      const auth = requireDaemon(req);
      if (auth.error) return auth.error;
    } else if (path.length === 2) {
      const cantonParty = req.nextUrl.searchParams.get("cantonParty") ?? "";
      const auth = await requirePartyOwner(cantonParty);
      if (auth.error) return auth.error;
      if (!search.includes("cantonParty=")) {
        const params = new URLSearchParams(search);
        params.set("cantonParty", auth.partyId);
        search = `?${params.toString()}`;
      }
    }
  }
  let target: string;
  try {
    const base = solverBase();
    const suffix = path.join("/");
    target = `${base}/${suffix}${search}`;
  } catch (e) {
    console.error("[solver-proxy] invalid solver base:", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "invalid solver base" },
      { status: 500 }
    );
  }

  const init: RequestInit = {
    method: req.method,
    headers: { "content-type": "application/json" },
    body:
      req.method === "GET" || req.method === "HEAD"
        ? undefined
        : await req.text(),
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

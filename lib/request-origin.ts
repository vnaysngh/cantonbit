import type { NextRequest } from "next/server";

/** Deployed public app URL (Railway / custom domain). Baked in at build time. */
export function configuredAppOrigin(): string | null {
  const raw = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/$/, "");
  if (!raw) return null;
  if (raw.startsWith("https://") || raw.startsWith("http://")) return raw;
  return null;
}

/** Browser-safe origin for OAuth redirectTo (prefer configured deploy URL). */
export function publicAppOrigin(fallback?: string): string {
  return (
    configuredAppOrigin() ??
    fallback ??
    (typeof window !== "undefined" ? window.location.origin : "")
  );
}

function isLoopbackHost(host: string): boolean {
  const h = host.split(":")[0]?.toLowerCase() ?? "";
  return h === "localhost" || h === "127.0.0.1" || h === "0.0.0.0";
}

/** Public site origin behind Railway / reverse proxies (not internal localhost). */
export function publicRequestOrigin(request: NextRequest): string {
  const configured = configuredAppOrigin();
  if (configured) return configured;

  const forwardedHost = request.headers.get("x-forwarded-host");
  if (forwardedHost) {
    const host = forwardedHost.split(",")[0]?.trim();
    if (host && !isLoopbackHost(host)) {
      const proto =
        request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
        "https";
      return `${proto}://${host}`;
    }
  }

  const host = request.headers.get("host");
  if (host && !isLoopbackHost(host)) {
    const proto =
      request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
      (request.url.startsWith("https://") ? "https" : "http");
    return `${proto}://${host.split(",")[0]?.trim()}`;
  }

  return new URL(request.url).origin;
}

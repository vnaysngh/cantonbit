import type { NextRequest } from "next/server";

function isLoopbackHost(host: string): boolean {
  const h = host.split(":")[0]?.toLowerCase() ?? "";
  return h === "localhost" || h === "127.0.0.1" || h === "0.0.0.0";
}

function configuredPublicOrigins(): string[] {
  const fromList = (process.env.PUBLIC_SITE_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const single = process.env.PUBLIC_SITE_ORIGIN?.trim();
  if (single && !fromList.includes(single)) fromList.unshift(single);
  return fromList;
}

function candidateOrigin(request: NextRequest): string | null {
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

  return null;
}

/** Public site origin behind Railway / reverse proxies (not internal localhost). */
export function publicRequestOrigin(request: NextRequest): string {
  const allowlist = configuredPublicOrigins();
  const candidate = candidateOrigin(request);

  if (allowlist.length > 0) {
    if (candidate && allowlist.includes(candidate)) return candidate;
    return allowlist[0]!;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "PUBLIC_SITE_ORIGIN or PUBLIC_SITE_ORIGINS must be set in production"
    );
  }

  if (candidate) return candidate;
  return new URL(request.url).origin;
}

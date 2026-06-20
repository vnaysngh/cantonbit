import { timingSafeEqual } from "node:crypto";

export function bearerTokenFromHeader(header: string | null): string {
  const value = header ?? "";
  return value.startsWith("Bearer ") ? value.slice("Bearer ".length) : "";
}

function safeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function isBearerAuthorized(params: {
  header: string | null;
  secret: string;
  nodeEnv?: string;
}): boolean {
  if (!params.secret) return false;
  return safeEqualString(bearerTokenFromHeader(params.header), params.secret);
}


/** Browser-facing solver proxy paths (lib/swap-api.ts). Deny everything else. */
const ALLOWED_PREFIXES = ["health", "quote", "orders"] as const;

export function isSolverProxyPathAllowed(path: string[]): boolean {
  if (path.length === 0) return false;
  const head = path[0];
  if (!ALLOWED_PREFIXES.includes(head as (typeof ALLOWED_PREFIXES)[number])) {
    return false;
  }
  if (head === "orders") {
    if (path.length === 1) return true;
    if (path.length === 2) return true;
    if (path.length === 3 && (path[2] === "accepted" || path[2] === "refund")) {
      return true;
    }
    return false;
  }
  return path.length === 1;
}

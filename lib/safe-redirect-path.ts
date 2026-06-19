/** Safe relative post-auth redirect — blocks protocol-relative and absolute URLs. */
export function safeRedirectPath(next: string | null | undefined, fallback = "/swap"): string {
  if (!next) return fallback;
  const trimmed = next.trim();
  if (
    !trimmed.startsWith("/") ||
    trimmed.startsWith("//") ||
    trimmed.includes("://") ||
    trimmed.includes("\\")
  ) {
    return fallback;
  }
  return trimmed;
}

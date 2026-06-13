/** CIP-0056 / Splice standard key for transfer memo (human-readable reason). */
export const TRANSFER_REASON_META_KEY =
  "splice.lfdecentralizedtrust.org/reason";

/** How long the receiver has to accept an offer before it expires. */
export const TRANSFER_EXPIRATION_OPTIONS = [
  { label: "1 hour", seconds: 60 * 60 },
  { label: "4 hours", seconds: 4 * 60 * 60 },
  { label: "24 hours", seconds: 24 * 60 * 60 }
] as const;

export const DEFAULT_TRANSFER_EXPIRATION_SECONDS =
  TRANSFER_EXPIRATION_OPTIONS[0].seconds;

export function buildTransferMeta(memo?: string): { values: Record<string, string> } {
  const trimmed = memo?.trim();
  if (!trimmed) return { values: {} };
  return {
    values: {
      [TRANSFER_REASON_META_KEY]: trimmed.slice(0, 256)
    }
  };
}

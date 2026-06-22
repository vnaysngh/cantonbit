/**
 * Shared HTLC quote math (client + server). Price must be WBTC/BTC scaled to 8dp.
 *
 *   wbtc → cbtc : out = in × P × (1 − fee)
 *   cbtc → wbtc : out = in ÷ P × (1 − fee)
 */
export function quoteGrossOutUnits(
  direction: "evm-to-canton" | "canton-to-evm",
  inUnits: bigint,
  price8: bigint
): bigint {
  if (price8 <= 0n) throw new Error("price must be > 0");
  return direction === "canton-to-evm"
    ? (inUnits * 100_000_000n) / price8
    : (inUnits * price8) / 100_000_000n;
}

export function applyOutputFee(gross: bigint, feeBps: number): bigint {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) {
    throw new Error("feeBps must be an integer from 0 to 10000");
  }
  return gross - (gross * BigInt(feeBps)) / 10000n;
}

/** Parse operator fee config without permitting NaN, fractions, or over-100% fees. */
export function parsePlatformFeeBps(
  raw: string | undefined,
  fallback: number
): number {
  const text = raw?.trim();
  const value = text ? Number(text) : fallback;
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new Error("PLATFORM_FEE_BPS must be an integer from 0 to 10000");
  }
  return value;
}

export function quoteOutUnits(
  direction: "evm-to-canton" | "canton-to-evm",
  inUnits: bigint,
  price8: bigint,
  feeBps: number
): bigint {
  return applyOutputFee(quoteGrossOutUnits(direction, inUnits, price8), feeBps);
}

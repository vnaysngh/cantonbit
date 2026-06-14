/** Integer base-unit conversions for Canton assets (no float on value paths). */

/** Floor/truncate excess fractional digits (for ledger strings wider than asset scale). */
export function toBaseUnitsFloor(amount: string, decimals: number): bigint {
  const trimmed = amount.trim();
  if (!trimmed || !/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error("invalid decimal amount");
  }
  const [whole, frac = ""] = trimmed.split(".");
  const floored = frac.slice(0, decimals).padEnd(decimals, "0");
  const combined = `${whole}${floored}`.replace(/^0+(?=\d)/, "") || "0";
  return BigInt(combined);
}

export function toBaseUnits(amount: string, decimals: number): bigint {
  const trimmed = amount.trim();
  if (!trimmed || !/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error("invalid decimal amount");
  }
  const [whole, frac = ""] = trimmed.split(".");
  if (frac.length > decimals) {
    throw new Error(`too many decimal places (max ${decimals})`);
  }
  const padded = frac.padEnd(decimals, "0");
  const combined = `${whole}${padded}`.replace(/^0+(?=\d)/, "") || "0";
  return BigInt(combined);
}

export function fromBaseUnits(units: bigint, decimals: number): string {
  if (units < 0n) throw new Error("negative amount");
  if (decimals === 0) return units.toString();
  const s = units.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, -decimals) || "0";
  const frac = s.slice(-decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

export function formatBaseUnits(units: bigint, decimals: number): string {
  return fromBaseUnits(units, decimals);
}

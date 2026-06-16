import type { CantonSwapAssetId } from "./canton-assets";

const DEFAULT =
  "We couldn't get a price right now. Please try again in a moment.";

/** User-facing copy when Tradecraft output fails the reference sanity check. */
export function cantonQuoteSanityUserMessage(
  fromAsset: CantonSwapAssetId,
  toAsset: CantonSwapAssetId
): string {
  if (fromAsset === "CC" && toAsset === "CBTC") {
    return "We can't quote this CC amount right now — the rate moved too far from our safety check. Try a smaller amount or wait a minute and retry.";
  }
  if (fromAsset === "CBTC" && toAsset === "CC") {
    return "We can't quote this CBTC amount right now — the rate moved too far from our safety check. Try a smaller amount or wait a minute and retry.";
  }
  return "We can't show a reliable price for this pair right now. Try a smaller amount or retry in a minute.";
}

export function cantonQuoteUnavailableUserMessage(_detail?: string): string {
  return "Price temporarily unavailable. Please try again in a moment.";
}

/** Map raw API / server errors to plain language (safe for UI). */
export function formatCantonQuoteError(raw: string | undefined): string {
  if (!raw?.trim()) return DEFAULT;
  // Already user-facing from the quote API.
  if (
    /^(we can't|price temporarily|too many quote|could not verify|enter a valid|select both)/i.test(
      raw.trim()
    )
  ) {
    return raw.trim();
  }
  const m = raw.toLowerCase();

  if (m.includes("rate limit")) {
    return "Too many quote requests. Please wait a moment and try again.";
  }
  if (
    m.includes("deviates from reference") ||
    m.includes("reference mid") ||
    m.includes("safety check") ||
    (m.includes("bps") && m.includes("quote"))
  ) {
    return cantonQuoteSanityUserMessage("CC", "CBTC");
  }
  if (m.includes("tradecraft") || m.includes("unavailable")) {
    return cantonQuoteUnavailableUserMessage(raw);
  }
  if (m.includes("btc/usd reference")) {
    return "Could not verify the Bitcoin reference price. Please try again shortly.";
  }
  if (m.includes("missing fromasset") || m.includes("missing toasset")) {
    return "Select both assets and enter an amount.";
  }
  if (m.includes("must be > 0") || m.includes("valid amount")) {
    return "Enter a valid amount.";
  }
  // Plain short messages from the API can pass through.
  if (
    raw.length <= 120 &&
    !m.includes("tradecraft") &&
    !m.includes("bps") &&
    !m.includes("::")
  ) {
    return raw;
  }
  return DEFAULT;
}

/**
 * Tiny dependency-free EVM helpers for the swap flow.
 *
 * The user must approve Permit2 to pull WBTC before the solver can submit
 * openFor. We hand-encode the few ERC20 calls we need (approve / allowance /
 * balanceOf) rather than pull viem into the app bundle.
 *
 * All amounts are hex-encoded uint256. Addresses are lowercased 20-byte hex.
 */

/** Canonical Permit2 (same address on every chain). */
export const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

/** Known chain ids. */
export const BASE_SEPOLIA_CHAIN_ID = 84532;
export const BASE_MAINNET_CHAIN_ID = 8453;
export const ARBITRUM_CHAIN_ID = 42161;
export const ARBITRUM_SEPOLIA_CHAIN_ID = 421614;
export const ETHEREUM_CHAIN_ID = 1;

/**
 * The EVM origin chain the swap sources WBTC from. Config-driven so flipping
 * testnet→mainnet is env-only. Default: Base Sepolia (testnet). For mainnet we
 * swap from Arbitrum (deep WBTC liquidity), set NEXT_PUBLIC_SWAP_CHAIN=arbitrum.
 */
export type HtlcEvmChainSlug =
  | "base-sepolia"
  | "arbitrum-sepolia"
  | "arbitrum"
  | "base";

export interface SwapChain {
  slug: HtlcEvmChainSlug;
  id: number;
  name: string;
  /**
   * The WBTC token contract on this chain. A fixed public constant — used to
   * read the user's own balance directly via eth_call. NOT sourced from the
   * solver: reading your on-chain balance only needs the token + wallet address,
   * so the balance must never depend on the solver being up. A blank string
   * means "unknown for this chain" (balance just won't show).
   */
  wbtc: string;
  /** HTLC escrow deployed on this chain. */
  escrow: string;
  /** wallet_addEthereumChain params (for the "switch network" button). */
  rpcUrls: string[];
  blockExplorerUrls: string[];
  nativeCurrency: {
    name: string;
    symbol: string;
    decimals: number;
  };
}

const TESTNET_HTLC_ESCROW = "0x1b19a764ab35db1833ae2137544dd84ba5bf8cf1";

function envKeySlug(slug: HtlcEvmChainSlug): string {
  return slug.toUpperCase().replace(/-/g, "_");
}

function readStaticPublicEnv(
  prefix: "HTLC_ESCROW" | "WBTC",
  slug: HtlcEvmChainSlug
): string {
  // Next.js only inlines public env vars in browser bundles when the property
  // access is statically analyzable. Do not replace this with process.env[key].
  if (prefix === "HTLC_ESCROW") {
    switch (slug) {
      case "base-sepolia":
        return process.env.NEXT_PUBLIC_HTLC_ESCROW_BASE_SEPOLIA?.trim() || "";
      case "arbitrum-sepolia":
        return (
          process.env.NEXT_PUBLIC_HTLC_ESCROW_ARBITRUM_SEPOLIA?.trim() || ""
        );
      case "arbitrum":
        return process.env.NEXT_PUBLIC_HTLC_ESCROW_ARBITRUM?.trim() || "";
      case "base":
        return process.env.NEXT_PUBLIC_HTLC_ESCROW_BASE?.trim() || "";
    }
  }

  switch (slug) {
    case "base-sepolia":
      return process.env.NEXT_PUBLIC_WBTC_BASE_SEPOLIA?.trim() || "";
    case "arbitrum-sepolia":
      return process.env.NEXT_PUBLIC_WBTC_ARBITRUM_SEPOLIA?.trim() || "";
    case "arbitrum":
      return process.env.NEXT_PUBLIC_WBTC_ARBITRUM?.trim() || "";
    case "base":
      return process.env.NEXT_PUBLIC_WBTC_BASE?.trim() || "";
  }
}

function readPublicOrServerEnv(
  prefix: "HTLC_ESCROW" | "WBTC",
  slug: HtlcEvmChainSlug
): string {
  const suffix = envKeySlug(slug);
  const publicValue = readStaticPublicEnv(prefix, slug);
  const serverValue =
    prefix === "WBTC"
      ? process.env[`WBTC_ADDRESS_${suffix}`]?.trim() ||
        process.env[`WBTC_${suffix}`]?.trim()
      : process.env[`${prefix}_${suffix}`]?.trim();
  return serverValue || publicValue || "";
}

export const SWAP_CHAINS: Record<HtlcEvmChainSlug, SwapChain> = {
  "base-sepolia": {
    slug: "base-sepolia",
    id: BASE_SEPOLIA_CHAIN_ID,
    name: "Base Sepolia",
    // testnet mock WBTC — deployed per-environment, so it has no fixed address.
    // Set NEXT_PUBLIC_WBTC_ADDRESS to show a balance on testnet.
    wbtc: readPublicOrServerEnv("WBTC", "base-sepolia") || process.env.NEXT_PUBLIC_WBTC_ADDRESS?.trim() || "",
    escrow:
      readPublicOrServerEnv("HTLC_ESCROW", "base-sepolia") ||
      process.env.NEXT_PUBLIC_HTLC_ESCROW?.trim() ||
      TESTNET_HTLC_ESCROW,
    rpcUrls: ["https://sepolia.base.org"],
    blockExplorerUrls: ["https://sepolia.basescan.org"],
    nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 }
  },
  "arbitrum-sepolia": {
    slug: "arbitrum-sepolia",
    id: ARBITRUM_SEPOLIA_CHAIN_ID,
    name: "Arbitrum Sepolia",
    wbtc: readPublicOrServerEnv("WBTC", "arbitrum-sepolia"),
    escrow: readPublicOrServerEnv("HTLC_ESCROW", "arbitrum-sepolia"),
    rpcUrls: ["https://sepolia-rollup.arbitrum.io/rpc"],
    blockExplorerUrls: ["https://sepolia.arbiscan.io"],
    nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 }
  },
  arbitrum: {
    slug: "arbitrum",
    id: ARBITRUM_CHAIN_ID,
    name: "Arbitrum",
    wbtc:
      readPublicOrServerEnv("WBTC", "arbitrum") ||
      "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
    escrow: readPublicOrServerEnv("HTLC_ESCROW", "arbitrum"),
    rpcUrls: ["https://arb1.arbitrum.io/rpc"],
    blockExplorerUrls: ["https://arbiscan.io"],
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }
  },
  base: {
    slug: "base",
    id: BASE_MAINNET_CHAIN_ID,
    name: "Base",
    wbtc:
      readPublicOrServerEnv("WBTC", "base") ||
      "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c",
    escrow: readPublicOrServerEnv("HTLC_ESCROW", "base"),
    rpcUrls: ["https://mainnet.base.org"],
    blockExplorerUrls: ["https://basescan.org"],
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }
  }
};

function normalizeHtlcChainSlug(value: unknown): HtlcEvmChainSlug | null {
  const raw = String(value ?? "").trim().toLowerCase();
  return raw in SWAP_CHAINS ? (raw as HtlcEvmChainSlug) : null;
}

export function defaultHtlcEvmChainSlug(): HtlcEvmChainSlug {
  const configured = normalizeHtlcChainSlug(process.env.NEXT_PUBLIC_SWAP_CHAIN);
  if (configured) return configured;
  return process.env.NEXT_PUBLIC_NETWORK === "mainnet" ||
    process.env.SWAP_NETWORK === "mainnet"
    ? "arbitrum"
    : "base-sepolia";
}

export function enabledHtlcEvmChains(): SwapChain[] {
  const raw =
    process.env.NEXT_PUBLIC_ENABLED_EVM_CHAINS?.trim() ||
    process.env.ENABLED_EVM_CHAINS?.trim();
  const slugs = raw
    ? raw
        .split(",")
        .map((s) => normalizeHtlcChainSlug(s))
        .filter((s): s is HtlcEvmChainSlug => !!s)
    : [defaultHtlcEvmChainSlug()];
  const unique = [...new Set(slugs)];
  return unique.map((slug) => SWAP_CHAINS[slug]);
}

export function resolveHtlcChainConfig(
  slug?: string | null
): SwapChain {
  const resolved =
    normalizeHtlcChainSlug(slug) ??
    normalizeHtlcChainSlug(process.env.NEXT_PUBLIC_SWAP_CHAIN) ??
    defaultHtlcEvmChainSlug();
  const cfg = SWAP_CHAINS[resolved];
  // Allow legacy one-off testnet overrides to keep current local/devnet flows alive.
  const legacyWbtc = process.env.NEXT_PUBLIC_WBTC_ADDRESS?.trim();
  const legacyEscrow = process.env.NEXT_PUBLIC_HTLC_ESCROW?.trim();
  return {
    ...cfg,
    wbtc: legacyWbtc && resolved === defaultHtlcEvmChainSlug() ? legacyWbtc : cfg.wbtc,
    escrow:
      legacyEscrow && resolved === defaultHtlcEvmChainSlug()
        ? legacyEscrow
        : cfg.escrow
  };
}

export function assertEnabledHtlcChain(slug?: string | null): SwapChain {
  const cfg = resolveHtlcChainConfig(slug);
  const enabled = new Set(enabledHtlcEvmChains().map((c) => c.slug));
  if (!enabled.has(cfg.slug)) {
    throw new Error(`EVM chain ${cfg.slug} is not enabled`);
  }
  return cfg;
}

export function chainConfigForOrder(order: {
  evmChainSlug?: string;
  evmChainId?: number;
  evmEscrowAddress?: string;
  evmWbtcAddress?: string;
}): SwapChain {
  const cfg = resolveHtlcChainConfig(order.evmChainSlug);
  return {
    ...cfg,
    id: order.evmChainId ?? cfg.id,
    escrow: order.evmEscrowAddress || cfg.escrow,
    wbtc: order.evmWbtcAddress || cfg.wbtc
  };
}

/** The configured swap origin chain. */
export const SWAP_CHAIN: SwapChain = resolveHtlcChainConfig();

/**
 * The HTLC escrow contract address — single source of truth (client + server).
 * In PRODUCTION at runtime, NEXT_PUBLIC_HTLC_ESCROW is REQUIRED: a missing var must
 * NOT silently fall back to the Base-Sepolia testnet escrow. During `next build`
 * (NEXT_PHASE=phase-production-build) we allow the documented testnet default so
 * image builds don't fail when Railway hasn't injected env yet — but NEXT_PUBLIC_*
 * is still baked at build time, so set it on the web service before deploy.
 */
function isNextProductionBuild(): boolean {
  return process.env.NEXT_PHASE === "phase-production-build";
}

/** Resolve escrow address; throws at production runtime if unset. */
export function resolveHtlcEscrowAddress(): string {
  const chainSpecific = readPublicOrServerEnv("HTLC_ESCROW", SWAP_CHAIN.slug);
  const configured = process.env.NEXT_PUBLIC_HTLC_ESCROW?.trim();
  const chainEscrow = chainSpecific || SWAP_CHAIN.escrow?.trim();
  if (process.env.NODE_ENV === "production" && !isNextProductionBuild()) {
    if (!chainSpecific && !configured) {
      throw new Error(
        `NEXT_PUBLIC_HTLC_ESCROW must be set in production (or NEXT_PUBLIC_HTLC_ESCROW_${envKeySlug(SWAP_CHAIN.slug)} for ${SWAP_CHAIN.slug})`,
      );
    }
  }
  if (chainEscrow) return chainEscrow;
  if (configured) return configured;
  if (isNextProductionBuild()) return TESTNET_HTLC_ESCROW;
  return TESTNET_HTLC_ESCROW;
}

export const HTLC_ESCROW_ADDRESS: string = resolveHtlcEscrowAddress();

const MAX_UINT256 = "0x" + "f".repeat(64);

/** Left-pad a hex string (no 0x) to 32 bytes. */
function pad32(hexNo0x: string): string {
  return hexNo0x.padStart(64, "0");
}

/** Encode a 20-byte address as a 32-byte ABI word. */
function encAddress(addr: string): string {
  return pad32(addr.toLowerCase().replace(/^0x/, ""));
}

/** Encode a bigint as a 32-byte ABI word. */
function encUint(v: bigint): string {
  return pad32(v.toString(16));
}

/** function selector = first 4 bytes of keccak256(signature). Precomputed. */
const SELECTORS = {
  approve: "095ea7b3", // approve(address,uint256)
  allowance: "dd62ed3e", // allowance(address,address)
  balanceOf: "70a08231" // balanceOf(address)
} as const;

/** Calldata for approve(spender, amount). */
export function encodeApprove(
  spender: string,
  amount: bigint = BigInt(MAX_UINT256)
): string {
  return "0x" + SELECTORS.approve + encAddress(spender) + encUint(amount);
}

/** Calldata for allowance(owner, spender). */
export function encodeAllowance(owner: string, spender: string): string {
  return "0x" + SELECTORS.allowance + encAddress(owner) + encAddress(spender);
}

/** Calldata for balanceOf(owner). */
export function encodeBalanceOf(owner: string): string {
  return "0x" + SELECTORS.balanceOf + encAddress(owner);
}

/** Parse a 32-byte hex word (eth_call return) into a bigint. */
export function decodeUint(hex: string): bigint {
  if (!hex || hex === "0x") return 0n;
  return BigInt(hex);
}

/** Format WBTC base units (8dp) as a human BTC string. */
export function formatWbtc(baseUnits: bigint): string {
  const whole = baseUnits / 100_000_000n;
  const frac = (baseUnits % 100_000_000n)
    .toString()
    .padStart(8, "0")
    .replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** Parse a human BTC string (e.g. "0.0001") to WBTC base units (8dp). */
export function parseWbtc(input: string): bigint {
  const trimmed = input.trim();
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === "" || trimmed === ".") {
    throw new Error("invalid amount");
  }
  const [whole = "0", frac = ""] = trimmed.split(".");
  const fracPadded = (frac + "00000000").slice(0, 8);
  return BigInt(whole) * 100_000_000n + BigInt(fracPadded || "0");
}

export const PERMIT2_MAX_APPROVAL = MAX_UINT256;

// ---------------------------------------------------------------------------
// Amount-input sanitizing — benchmarked against CoW's NumericalInput
// (apps/cowswap-frontend/src/legacy/components/NumericalInput/index.tsx).
// CoW's keystroke gate is a single regex; bad keystrokes are silently rejected.
// ---------------------------------------------------------------------------

/** CoW's exact keystroke regex: digits with at most one dot, empty allowed. */
const AMOUNT_INPUT_REGEX = /^(\d*\.?\d*)?$/;

/**
 * Sanitize a keystroke-level amount input the way CoW does: comma→dot, then only
 * accept it if it matches the decimal regex (else keep the previous value — a
 * no-op, exactly like CoW). Returns the value to set. Empty is always allowed.
 * Rejects: letters, `-`, scientific `1e5`, a second dot, any non-digit symbol.
 */
export function sanitizeAmountInput(next: string, previous: string): string {
  if (next === "") return "";
  const v = next.replace(/,/g, ".");
  return AMOUNT_INPUT_REGEX.test(v) ? v : previous;
}

/** CoW's paste cleaner: comma→dot, strip non-digit/dot, keep first dot, drop trailing dot. */
export function cleanPastedAmount(pasted: string): string {
  return pasted
    .replace(/,/g, ".")
    .replace(/[^\d.]/g, "")
    .replace(/(\..*)\./g, "$1")
    .replace(/\.$/, "");
}

/** Truncate an amount string to `decimals` fractional digits (no rounding) —
 *  CoW truncates to token precision before parseUnits. */
export function truncateToDecimals(input: string, decimals = 8): string {
  const [whole, frac] = input.split(".");
  if (frac === undefined) return input;
  return `${whole}.${frac.slice(0, decimals)}`;
}

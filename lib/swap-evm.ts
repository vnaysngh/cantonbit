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
export const ETHEREUM_CHAIN_ID = 1;

/**
 * The EVM origin chain the swap sources WBTC from. Config-driven so flipping
 * testnet→mainnet is env-only. Default: Base Sepolia (testnet). For mainnet we
 * swap from Arbitrum (deep WBTC liquidity), set NEXT_PUBLIC_SWAP_CHAIN=arbitrum.
 */
interface SwapChain {
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
  /** wallet_addEthereumChain params (for the "switch network" button). */
  rpcUrls: string[];
  blockExplorerUrls: string[];
}

const SWAP_CHAINS: Record<string, SwapChain> = {
  "base-sepolia": {
    id: BASE_SEPOLIA_CHAIN_ID,
    name: "Base Sepolia",
    // testnet mock WBTC — deployed per-environment, so it has no fixed address.
    // Set NEXT_PUBLIC_WBTC_ADDRESS to show a balance on testnet.
    wbtc: "",
    rpcUrls: ["https://sepolia.base.org"],
    blockExplorerUrls: ["https://sepolia.basescan.org"]
  },
  arbitrum: {
    id: ARBITRUM_CHAIN_ID,
    name: "Arbitrum",
    wbtc: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
    rpcUrls: ["https://arb1.arbitrum.io/rpc"],
    blockExplorerUrls: ["https://arbiscan.io"]
  },
  base: {
    id: BASE_MAINNET_CHAIN_ID,
    name: "Base",
    wbtc: "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c",
    rpcUrls: ["https://mainnet.base.org"],
    blockExplorerUrls: ["https://basescan.org"]
  },
  ethereum: {
    id: ETHEREUM_CHAIN_ID,
    name: "Ethereum",
    wbtc: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
    rpcUrls: ["https://eth.llamarpc.com"],
    blockExplorerUrls: ["https://etherscan.io"]
  }
};

/** The configured swap origin chain. */
export const SWAP_CHAIN: SwapChain = (() => {
  const base =
    SWAP_CHAINS[process.env.NEXT_PUBLIC_SWAP_CHAIN ?? "base-sepolia"] ??
    SWAP_CHAINS["base-sepolia"];
  // Allow an explicit override (e.g. a testnet mock WBTC) without editing code.
  const override = process.env.NEXT_PUBLIC_WBTC_ADDRESS;
  return override ? { ...base, wbtc: override } : base;
})();

/**
 * The HTLC escrow contract address — single source of truth (client + server).
 * In PRODUCTION at runtime, NEXT_PUBLIC_HTLC_ESCROW is REQUIRED: a missing var must
 * NOT silently fall back to the Base-Sepolia testnet escrow. During `next build`
 * (NEXT_PHASE=phase-production-build) we allow the documented testnet default so
 * image builds don't fail when Railway hasn't injected env yet — but NEXT_PUBLIC_*
 * is still baked at build time, so set it on the web service before deploy.
 */
const TESTNET_HTLC_ESCROW = "0x1b19a764ab35db1833ae2137544dd84ba5bf8cf1";

function isNextProductionBuild(): boolean {
  return process.env.NEXT_PHASE === "phase-production-build";
}

/** Resolve escrow address; throws at production runtime if unset. */
export function resolveHtlcEscrowAddress(): string {
  const configured = process.env.NEXT_PUBLIC_HTLC_ESCROW?.trim();
  if (configured) return configured;
  if (isNextProductionBuild()) return TESTNET_HTLC_ESCROW;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "NEXT_PUBLIC_HTLC_ESCROW must be set in production — refusing to fall back to the testnet escrow",
    );
  }
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

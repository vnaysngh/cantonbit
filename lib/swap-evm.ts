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

/** Base Sepolia chain id (origin chain for testnet swaps). */
export const BASE_SEPOLIA_CHAIN_ID = 84532;
export const BASE_MAINNET_CHAIN_ID = 8453;

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
  balanceOf: "70a08231", // balanceOf(address)
} as const;

/** Calldata for approve(spender, amount). */
export function encodeApprove(spender: string, amount: bigint = BigInt(MAX_UINT256)): string {
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
  const frac = (baseUnits % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
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

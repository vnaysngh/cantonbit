/**
 * EVM chain selection for the HTLC solver daemon — mirrors deploy.ts / lib/swap-evm.ts.
 * Keeps viem chain + default RPC aligned with SWAP_NETWORK and EVM_CHAIN env vars.
 */
import {
  arbitrum,
  arbitrumSepolia,
  base,
  baseSepolia,
  type Chain,
} from "viem/chains";
import { getAddress, type Address } from "viem";
import type { PublicClient } from "viem";

/** Canonical mainnet WBTC per EVM chain (matches deploy.ts). */
const MAINNET_WBTC: Record<"arbitrum" | "base", Address> = {
  arbitrum: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
  base: "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c",
};

export type SwapNetwork = "devnet" | "testnet" | "mainnet";
export type EvmChainSlug =
  | "base-sepolia"
  | "arbitrum-sepolia"
  | "arbitrum"
  | "base";

export function resolveSwapNetwork(): SwapNetwork {
  const raw = (
    process.env.SWAP_NETWORK ??
    process.env.NEXT_PUBLIC_NETWORK ??
    "devnet"
  ).toLowerCase();
  if (raw !== "devnet" && raw !== "testnet" && raw !== "mainnet") {
    throw new Error(
      `SWAP_NETWORK/NEXT_PUBLIC_NETWORK must be devnet|testnet|mainnet, got '${raw}'`,
    );
  }
  return raw;
}

/** Refuse mainnet unless explicitly opted in (real funds). */
export function assertMainnetAllowed(network: SwapNetwork): void {
  if (network === "mainnet" && process.env.ALLOW_MAINNET !== "true") {
    throw new Error(
      "Refusing to start on mainnet. Set ALLOW_MAINNET=true explicitly to run against real funds.",
    );
  }
}

/** Which EVM chain the HTLC escrow lives on. */
export function resolveEvmChainSlug(network: SwapNetwork): EvmChainSlug {
  const override = process.env.EVM_CHAIN ?? process.env.NEXT_PUBLIC_SWAP_CHAIN;
  if (override) {
    const c = override.toLowerCase();
    if (
      c === "base-sepolia" ||
      c === "arbitrum-sepolia" ||
      c === "arbitrum" ||
      c === "base"
    ) {
      return c;
    }
    throw new Error(
      `EVM_CHAIN/NEXT_PUBLIC_SWAP_CHAIN must be base-sepolia|arbitrum-sepolia|arbitrum|base, got '${c}'`,
    );
  }
  return network === "mainnet" ? "arbitrum" : "base-sepolia";
}

export function viemChainFor(slug: EvmChainSlug): Chain {
  switch (slug) {
    case "arbitrum":
      return arbitrum;
    case "arbitrum-sepolia":
      return arbitrumSepolia;
    case "base":
      return base;
    case "base-sepolia":
      return baseSepolia;
  }
}

export function defaultRpcFor(slug: EvmChainSlug): string {
  switch (slug) {
    case "arbitrum":
      return "https://arb1.arbitrum.io/rpc";
    case "arbitrum-sepolia":
      return "https://sepolia-rollup.arbitrum.io/rpc";
    case "base":
      return "https://mainnet.base.org";
    case "base-sepolia":
      return "https://sepolia.base.org";
  }
}

/** Fail fast if ORIGIN_RPC_URL points at the wrong chain. */
export async function verifyRpcChainId(
  pub: PublicClient,
  expected: Chain,
): Promise<void> {
  const id = await pub.getChainId();
  if (id !== expected.id) {
    throw new Error(
      `ORIGIN_RPC_URL chain id ${id} != expected ${expected.id} (${expected.name}). ` +
        `Check EVM_CHAIN/SWAP_NETWORK and RPC URL.`,
    );
  }
}

export function resolveHtlcEvmConfig(): {
  network: SwapNetwork;
  slug: EvmChainSlug;
  chain: Chain;
  rpcUrl: string;
} {
  const network = resolveSwapNetwork();
  assertMainnetAllowed(network);
  const slug = resolveEvmChainSlug(network);
  const chain = viemChainFor(slug);
  const rpcUrl = process.env.ORIGIN_RPC_URL ?? defaultRpcFor(slug);
  return { network, slug, chain, rpcUrl };
}

/** WBTC token for reverse (canton→evm) counter-locks. */
export function resolveWbtcAddress(slug: EvmChainSlug): Address {
  const suffix = slug.toUpperCase().replace(/-/g, "_");
  const chainSpecific =
    process.env[`WBTC_ADDRESS_${suffix}`] ??
    process.env[`NEXT_PUBLIC_WBTC_${suffix}`];
  const generic =
    process.env.WBTC_ADDRESS ?? process.env.NEXT_PUBLIC_WBTC_ADDRESS;
  // Chain-specific wins — .env.devnet keeps generic WBTC_ADDRESS for the web app's
  // default chain (Base) while per-chain daemons set EVM_CHAIN + WBTC_ADDRESS_* .
  if (chainSpecific) return getAddress(chainSpecific);
  if (generic) return getAddress(generic);
  if (slug === "base-sepolia" || slug === "arbitrum-sepolia") {
    throw new Error(
      `missing env WBTC_ADDRESS_${suffix} or WBTC_ADDRESS (set in swap-solver/.env or .env.htlc-devnet)`,
    );
  }
  const chainKey = slug === "arbitrum" ? "arbitrum" : "base";
  return MAINNET_WBTC[chainKey];
}

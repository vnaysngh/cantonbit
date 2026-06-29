import {
  assertConfiguredHtlcChain,
  assertHtlcChainEnabledForIntake,
  chainConfigForOrder,
  type SwapChain
} from "./swap-evm";

export type HtlcEvmChainBinding = {
  evmChainSlug: string;
  evmChainId: number;
  evmEscrowAddress: string;
  evmWbtcAddress: string;
};

export function bindEnabledHtlcEvmChain(slug?: string | null): {
  chain: SwapChain;
  fields: HtlcEvmChainBinding;
} {
  const chain = assertHtlcChainEnabledForIntake(slug);
  if (!chain.escrow?.trim()) {
    throw new Error(`HTLC escrow not configured for ${chain.slug}`);
  }
  if (!chain.wbtc?.trim()) {
    throw new Error(`WBTC address not configured for ${chain.slug}`);
  }
  return {
    chain,
    fields: {
      evmChainSlug: chain.slug,
      evmChainId: chain.id,
      evmEscrowAddress: chain.escrow,
      evmWbtcAddress: chain.wbtc
    }
  };
}

export function assertOrderChainMatchesRequest(
  order: {
    evmChainSlug?: string;
    evmChainId?: number;
    evmEscrowAddress?: string;
    evmWbtcAddress?: string;
  },
  requestedSlug?: string | null
): void {
  if (!requestedSlug) return;
  const orderChain = chainConfigForOrder(order);
  const requestChain = assertConfiguredHtlcChain(requestedSlug);
  if (orderChain.slug !== requestChain.slug) {
    throw new Error(
      `EVM chain mismatch: order is ${orderChain.slug}, request is ${requestChain.slug}`
    );
  }
}

export function daemonRequestedEvmChain(req: Request): string | undefined {
  const header = req.headers.get("x-warpx-evm-chain")?.trim();
  if (header) return header;
  const url = new URL(req.url);
  return url.searchParams.get("evmChain")?.trim() || undefined;
}

export function assertDaemonOrderChain(
  req: Request,
  order: {
    evmChainSlug?: string;
    evmChainId?: number;
    evmEscrowAddress?: string;
    evmWbtcAddress?: string;
  }
): void {
  const requested = daemonRequestedEvmChain(req);
  if (!requested) {
    throw new Error("missing daemon EVM chain");
  }
  assertOrderChainMatchesRequest(order, requested);
}

import { strict as assert } from "node:assert";
import { test } from "node:test";

test("resolveEvmChainSlug: devnet defaults to base-sepolia", async () => {
  const prev = {
    swap: process.env.SWAP_NETWORK,
    evm: process.env.EVM_CHAIN,
    pub: process.env.NEXT_PUBLIC_SWAP_CHAIN,
  };
  delete process.env.EVM_CHAIN;
  delete process.env.NEXT_PUBLIC_SWAP_CHAIN;
  process.env.SWAP_NETWORK = "devnet";
  try {
    const { resolveEvmChainSlug } = await import("./htlc-evm-chain.js");
    assert.equal(resolveEvmChainSlug("devnet"), "base-sepolia");
  } finally {
    if (prev.swap === undefined) delete process.env.SWAP_NETWORK;
    else process.env.SWAP_NETWORK = prev.swap;
    if (prev.evm === undefined) delete process.env.EVM_CHAIN;
    else process.env.EVM_CHAIN = prev.evm;
    if (prev.pub === undefined) delete process.env.NEXT_PUBLIC_SWAP_CHAIN;
    else process.env.NEXT_PUBLIC_SWAP_CHAIN = prev.pub;
  }
});

test("resolveEvmChainSlug: mainnet defaults to arbitrum", async () => {
  const prev = process.env.EVM_CHAIN;
  delete process.env.EVM_CHAIN;
  try {
    const { resolveEvmChainSlug } = await import("./htlc-evm-chain.js");
    assert.equal(resolveEvmChainSlug("mainnet"), "arbitrum");
  } finally {
    if (prev === undefined) delete process.env.EVM_CHAIN;
    else process.env.EVM_CHAIN = prev;
  }
});

test("assertMainnetAllowed: refuses mainnet without ALLOW_MAINNET", async () => {
  const prev = process.env.ALLOW_MAINNET;
  delete process.env.ALLOW_MAINNET;
  try {
    const { assertMainnetAllowed } = await import("./htlc-evm-chain.js");
    assert.throws(
      () => assertMainnetAllowed("mainnet"),
      /ALLOW_MAINNET=true/,
    );
  } finally {
    if (prev === undefined) delete process.env.ALLOW_MAINNET;
    else process.env.ALLOW_MAINNET = prev;
  }
});

test("assertMainnetAllowed: allows mainnet when opted in", async () => {
  const prev = process.env.ALLOW_MAINNET;
  process.env.ALLOW_MAINNET = "true";
  try {
    const { assertMainnetAllowed } = await import("./htlc-evm-chain.js");
    assert.doesNotThrow(() => assertMainnetAllowed("mainnet"));
  } finally {
    if (prev === undefined) delete process.env.ALLOW_MAINNET;
    else process.env.ALLOW_MAINNET = prev;
  }
});

test("resolveWbtcAddress: chain-specific wins over generic WBTC_ADDRESS", async () => {
  const prev = {
    generic: process.env.WBTC_ADDRESS,
    arb: process.env.WBTC_ADDRESS_ARBITRUM_SEPOLIA,
  };
  process.env.WBTC_ADDRESS = "0x8d587e55236d1d4898e85711f709e53e657413ee";
  process.env.WBTC_ADDRESS_ARBITRUM_SEPOLIA =
    "0x9d5e24f388c3821f26eb82239a25016979f5a331";
  try {
    const { getAddress } = await import("viem");
    const { resolveWbtcAddress } = await import("./htlc-evm-chain.js");
    assert.equal(
      resolveWbtcAddress("arbitrum-sepolia"),
      getAddress("0x9d5e24f388c3821f26eb82239a25016979f5a331"),
    );
  } finally {
    if (prev.generic === undefined) delete process.env.WBTC_ADDRESS;
    else process.env.WBTC_ADDRESS = prev.generic;
    if (prev.arb === undefined) delete process.env.WBTC_ADDRESS_ARBITRUM_SEPOLIA;
    else process.env.WBTC_ADDRESS_ARBITRUM_SEPOLIA = prev.arb;
  }
});

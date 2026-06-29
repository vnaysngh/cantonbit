import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  assertC2cIntakeEnabled,
  assertCrossChainIntakeEnabled,
  C2cSwapDisabledError,
  CrossChainSwapDisabledError,
  isC2cSwapEnabled,
  isCrossChainSwapEnabled,
  isHtlcArbitrumFamilyEnabled,
  isHtlcBaseFamilyEnabled,
  isHtlcEvmChainFamilyEnabled,
  isHtlcEvmChainFamilyEnabledFromSnapshot
} from "./swap-feature-flags.js";
import { envFlagEnabled, readEnvFlag } from "./env-flag-enabled.js";

type EnvSnapshot = Record<string, string | undefined>;

function withEnv(
  overrides: EnvSnapshot,
  fn: () => void | Promise<void>
): void | Promise<void> {
  const keys = new Set(Object.keys(overrides));
  const prev: EnvSnapshot = {};
  for (const key of keys) {
    prev[key] = process.env[key];
    const value = overrides[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const key of keys) {
      const value = prev[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("envFlagEnabled defaults to enabled", () => {
  assert.equal(envFlagEnabled(undefined), true);
  assert.equal(envFlagEnabled(""), true);
  assert.equal(envFlagEnabled("1"), true);
  assert.equal(envFlagEnabled("true"), true);
  assert.equal(envFlagEnabled("0"), false);
  assert.equal(envFlagEnabled("false"), false);
});

test("readEnvFlag prefers server env over public", () => {
  withEnv(
    {
      CROSS_CHAIN_SWAP_ENABLED: "0",
      NEXT_PUBLIC_CROSS_CHAIN_SWAP_ENABLED: "1"
    },
    () => {
      assert.equal(
        readEnvFlag(
          "CROSS_CHAIN_SWAP_ENABLED",
          "NEXT_PUBLIC_CROSS_CHAIN_SWAP_ENABLED"
        ),
        false
      );
    }
  );
});

test("swap feature flags default to enabled", () => {
  withEnv(
    {
      CROSS_CHAIN_SWAP_ENABLED: undefined,
      NEXT_PUBLIC_CROSS_CHAIN_SWAP_ENABLED: undefined,
      HTLC_BASE_ENABLED: undefined,
      NEXT_PUBLIC_HTLC_BASE_ENABLED: undefined,
      HTLC_ARBITRUM_ENABLED: undefined,
      NEXT_PUBLIC_HTLC_ARBITRUM_ENABLED: undefined,
      C2C_SWAP_ENABLED: undefined,
      NEXT_PUBLIC_C2C_SWAP_ENABLED: undefined
    },
    () => {
      assert.equal(isCrossChainSwapEnabled(), true);
      assert.equal(isHtlcBaseFamilyEnabled(), true);
      assert.equal(isHtlcArbitrumFamilyEnabled(), true);
      assert.equal(isC2cSwapEnabled(), true);
      assert.equal(isHtlcEvmChainFamilyEnabled("arbitrum-sepolia"), true);
    }
  );
});

test("cross-chain master flag disables all HTLC families", () => {
  withEnv(
    {
      CROSS_CHAIN_SWAP_ENABLED: "0",
      NEXT_PUBLIC_CROSS_CHAIN_SWAP_ENABLED: undefined,
      HTLC_BASE_ENABLED: "1",
      HTLC_ARBITRUM_ENABLED: "1"
    },
    () => {
      assert.equal(isCrossChainSwapEnabled(), false);
      assert.equal(isHtlcEvmChainFamilyEnabled("base-sepolia"), false);
      assert.equal(isHtlcEvmChainFamilyEnabled("arbitrum"), false);
      assert.throws(
        () => assertCrossChainIntakeEnabled("base-sepolia"),
        CrossChainSwapDisabledError
      );
    }
  );
});

test("per-family flags disable only matching slugs", () => {
  withEnv(
    {
      CROSS_CHAIN_SWAP_ENABLED: "1",
      NEXT_PUBLIC_CROSS_CHAIN_SWAP_ENABLED: undefined,
      HTLC_ARBITRUM_ENABLED: "0",
      NEXT_PUBLIC_HTLC_ARBITRUM_ENABLED: undefined,
      HTLC_BASE_ENABLED: "1"
    },
    () => {
      assert.equal(isHtlcEvmChainFamilyEnabled("base-sepolia"), true);
      assert.equal(isHtlcEvmChainFamilyEnabled("arbitrum-sepolia"), false);
      assert.throws(
        () => assertCrossChainIntakeEnabled("arbitrum-sepolia"),
        CrossChainSwapDisabledError
      );
      assert.doesNotThrow(() =>
        assertCrossChainIntakeEnabled("base-sepolia")
      );
    }
  );
});

test("isHtlcEvmChainFamilyEnabledFromSnapshot respects per-family flags", () => {
  const flags = {
    crossChainEnabled: true,
    htlcBaseEnabled: true,
    htlcArbitrumEnabled: false,
    c2cEnabled: true
  };
  assert.equal(isHtlcEvmChainFamilyEnabledFromSnapshot("base-sepolia", flags), true);
  assert.equal(
    isHtlcEvmChainFamilyEnabledFromSnapshot("arbitrum-sepolia", flags),
    false
  );
});

test("c2c flag blocks c2c intake only", () => {
  withEnv(
    {
      C2C_SWAP_ENABLED: "false",
      NEXT_PUBLIC_C2C_SWAP_ENABLED: undefined,
      CROSS_CHAIN_SWAP_ENABLED: undefined
    },
    () => {
      assert.equal(isC2cSwapEnabled(), false);
      assert.throws(() => assertC2cIntakeEnabled(), C2cSwapDisabledError);
      assert.equal(isCrossChainSwapEnabled(), true);
    }
  );
});

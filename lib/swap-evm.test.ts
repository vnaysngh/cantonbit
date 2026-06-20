import { strict as assert } from "node:assert";
import { test } from "node:test";

const TESTNET_HTLC_ESCROW = "0x1b19a764ab35db1833ae2137544dd84ba5bf8cf1";

/** Mutable view for test env patching (process.env.NODE_ENV is read-only in @types/node). */
const env = process.env as Record<string, string | undefined>;

test("resolveHtlcEscrowAddress: testnet default during next production build", async () => {
  const prev = {
    escrow: env.NEXT_PUBLIC_HTLC_ESCROW,
    phase: env.NEXT_PHASE,
    nodeEnv: env.NODE_ENV,
  };
  delete env.NEXT_PUBLIC_HTLC_ESCROW;
  env.NEXT_PHASE = "phase-production-build";
  env.NODE_ENV = "production";
  try {
    const { resolveHtlcEscrowAddress } = await import("./swap-evm");
    assert.equal(resolveHtlcEscrowAddress(), TESTNET_HTLC_ESCROW);
  } finally {
    if (prev.escrow === undefined) delete env.NEXT_PUBLIC_HTLC_ESCROW;
    else env.NEXT_PUBLIC_HTLC_ESCROW = prev.escrow;
    if (prev.phase === undefined) delete env.NEXT_PHASE;
    else env.NEXT_PHASE = prev.phase;
    if (prev.nodeEnv === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = prev.nodeEnv;
  }
});

test("resolveHtlcEscrowAddress: throws at production runtime when unset", async () => {
  const prev = {
    escrow: env.NEXT_PUBLIC_HTLC_ESCROW,
    phase: env.NEXT_PHASE,
    nodeEnv: env.NODE_ENV,
  };
  delete env.NEXT_PUBLIC_HTLC_ESCROW;
  delete env.NEXT_PHASE;
  env.NODE_ENV = "production";
  try {
    const { resolveHtlcEscrowAddress } = await import("./swap-evm");
    assert.throws(
      () => resolveHtlcEscrowAddress(),
      /NEXT_PUBLIC_HTLC_ESCROW must be set in production/,
    );
  } finally {
    if (prev.escrow === undefined) delete env.NEXT_PUBLIC_HTLC_ESCROW;
    else env.NEXT_PUBLIC_HTLC_ESCROW = prev.escrow;
    if (prev.phase === undefined) delete env.NEXT_PHASE;
    else env.NEXT_PHASE = prev.phase;
    if (prev.nodeEnv === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = prev.nodeEnv;
  }
});

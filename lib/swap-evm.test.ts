import { strict as assert } from "node:assert";
import { test } from "node:test";

const TESTNET_HTLC_ESCROW = "0x1b19a764ab35db1833ae2137544dd84ba5bf8cf1";

test("resolveHtlcEscrowAddress: testnet default during next production build", async () => {
  const prev = {
    escrow: process.env.NEXT_PUBLIC_HTLC_ESCROW,
    phase: process.env.NEXT_PHASE,
    nodeEnv: process.env.NODE_ENV,
  };
  delete process.env.NEXT_PUBLIC_HTLC_ESCROW;
  process.env.NEXT_PHASE = "phase-production-build";
  process.env.NODE_ENV = "production";
  try {
    const { resolveHtlcEscrowAddress } = await import("./swap-evm");
    assert.equal(resolveHtlcEscrowAddress(), TESTNET_HTLC_ESCROW);
  } finally {
    if (prev.escrow === undefined) delete process.env.NEXT_PUBLIC_HTLC_ESCROW;
    else process.env.NEXT_PUBLIC_HTLC_ESCROW = prev.escrow;
    if (prev.phase === undefined) delete process.env.NEXT_PHASE;
    else process.env.NEXT_PHASE = prev.phase;
    if (prev.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prev.nodeEnv;
  }
});

test("resolveHtlcEscrowAddress: throws at production runtime when unset", async () => {
  const prev = {
    escrow: process.env.NEXT_PUBLIC_HTLC_ESCROW,
    phase: process.env.NEXT_PHASE,
    nodeEnv: process.env.NODE_ENV,
  };
  delete process.env.NEXT_PUBLIC_HTLC_ESCROW;
  delete process.env.NEXT_PHASE;
  process.env.NODE_ENV = "production";
  try {
    const { resolveHtlcEscrowAddress } = await import("./swap-evm");
    assert.throws(
      () => resolveHtlcEscrowAddress(),
      /NEXT_PUBLIC_HTLC_ESCROW must be set in production/,
    );
  } finally {
    if (prev.escrow === undefined) delete process.env.NEXT_PUBLIC_HTLC_ESCROW;
    else process.env.NEXT_PUBLIC_HTLC_ESCROW = prev.escrow;
    if (prev.phase === undefined) delete process.env.NEXT_PHASE;
    else process.env.NEXT_PHASE = prev.phase;
    if (prev.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prev.nodeEnv;
  }
});

/**
 * Tests for the env-loading SECURITY guards: mainnet gating, NEXT_PUBLIC
 * rejection, key validation, and that the masked summary never leaks secrets.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { loadEnv, describeEnv } from "./env.js";

const VALID: Record<string, string> = {
  SWAP_NETWORK: "testnet",
  ORIGIN_RPC_URL: "https://sepolia.base.org",
  ESCROW_ADDRESS: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  ORACLE_ADDRESS: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
  WBTC_ADDRESS: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
  AGENT_PRIVATE_KEY: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  CANTON_LEDGER_HOST: "https://ledger.example",
  CANTON_REGISTRY_URL: "https://registry.example",
  CANTON_ADMIN_PARTY: "cbtc-network::1220abcd",
  SOLVER_CANTON_PARTY: "cbtc-user-solver::1220beef0000000000000000",
  KEYCLOAK_TOKEN_URL: "https://auth.example/token",
  KEYCLOAK_CLIENT_ID: "swap-solver-m2m",
  KEYCLOAK_CLIENT_SECRET: "super-secret-value-do-not-log",
};

function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const saved = { ...process.env };
  // clear the keys we manage
  for (const k of Object.keys(VALID)) delete process.env[k];
  delete process.env.ALLOW_MAINNET;
  // apply base then overrides; an `undefined` override DELETES the key (process.env
  // coerces an assigned undefined to the string "undefined", which would defeat
  // the missing-var test — so delete instead).
  for (const [k, v] of Object.entries({ ...VALID, ...overrides })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in saved)) delete process.env[k];
    }
    Object.assign(process.env, saved);
  }
}

test("loads a valid testnet config", () => {
  withEnv({}, () => {
    const env = loadEnv();
    assert.equal(env.network, "testnet");
    assert.equal(env.agentAccount.address.length, 42);
    assert.equal(env.canton.auth.clientSecret, "super-secret-value-do-not-log");
  });
});

test("refuses mainnet without ALLOW_MAINNET", () => {
  withEnv({ SWAP_NETWORK: "mainnet" }, () => {
    assert.throws(() => loadEnv(), /Refusing to start on mainnet/);
  });
});

test("allows mainnet when explicitly flagged", () => {
  withEnv({ SWAP_NETWORK: "mainnet", ALLOW_MAINNET: "true" }, () => {
    assert.equal(loadEnv().network, "mainnet");
  });
});

test("rejects a malformed agent key", () => {
  withEnv({ AGENT_PRIVATE_KEY: "not-a-key" }, () => {
    assert.throws(() => loadEnv(), /AGENT_PRIVATE_KEY/);
  });
});

test("throws on a missing required var", () => {
  withEnv({ ESCROW_ADDRESS: undefined }, () => {
    assert.throws(() => loadEnv(), /Missing required env var: ESCROW_ADDRESS/);
  });
});

test("describeEnv masks every secret", () => {
  withEnv({}, () => {
    const summary = describeEnv(loadEnv());
    const blob = JSON.stringify(summary);
    // The secret values must NOT appear anywhere in the summary.
    assert.ok(!blob.includes("super-secret-value-do-not-log"), "client secret leaked");
    assert.ok(!blob.includes("ac0974bec39a17e36ba4a6b4"), "agent private key leaked");
    assert.equal(summary.agentKey, "***redacted***");
    assert.equal(summary.keycloakClientSecret, "***redacted***");
    // Non-secret identifiers are present (the agent ADDRESS is fine to show).
    assert.match(summary.agentAddress ?? "", /^0x[0-9a-fA-F]{40}$/);
  });
});

test("validates the SWAP_NETWORK enum", () => {
  withEnv({ SWAP_NETWORK: "bogus" }, () => {
    assert.throws(() => loadEnv(), /SWAP_NETWORK must be/);
  });
});

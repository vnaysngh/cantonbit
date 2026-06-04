/**
 * Environment loading — the single, validated boundary where secrets enter the
 * solver. Everything sensitive (the EVM agent key, the Canton KEYCLOAK creds)
 * is read here, once, and passed forward as typed values. Nothing else in the
 * codebase reads process.env.
 *
 * SECURITY NOTES
 *  - The agent EVM key can attest a fill → release the ENTIRE escrow. It is
 *    treasury-grade. The Canton client secret can act on the cBTC float. Treat
 *    both like a hot treasury wallet: dedicated signer, server-only, never logged.
 *  - This module NEVER logs a secret. `describeEnv()` returns a masked summary.
 *  - NEXT_PUBLIC_* is rejected for any secret name — that prefix would bundle a
 *    value into client JS in the sibling Next.js app. The solver is a standalone
 *    backend; secrets must use non-public names.
 *  - Mainnet is gated behind ALLOW_MAINNET=true so we can't point real funds at
 *    it by accident during development.
 */

import { privateKeyToAccount } from "viem/accounts";
import { getAddress, isHex, type Account, type Address, type Hex } from "viem";

import type { NetworkName } from "./config.js";

export interface SolverEnv {
  network: NetworkName;

  // --- EVM (Base) side ---
  originRpcUrl: string;
  escrow: Address;
  oracle: Address;
  wbtc: Address;
  /** The agent signer (attest + finalise). Treasury-grade. */
  agentAccount: Account;

  // --- Canton side ---
  canton: {
    ledgerHost: string;
    registryUrl: string;
    decentralizedPartyId: string;
    instrumentId: { admin: string; id: string };
    solverParty: string;
    auth: {
      tokenUrl: string;
      clientId: string;
      clientSecret: string;
      scope: string;
    };
  };

  // --- behavior ---
  /** Watcher start block (escrow deploy block). */
  startBlock: bigint;
  /** Poll cadence (ms) for the solver loop. */
  pollIntervalMs: number;
}

function req(name: string): string {
  // Reject NEXT_PUBLIC_* secret leakage vector outright.
  if (name.startsWith("NEXT_PUBLIC_")) {
    throw new Error(`Refusing to read a NEXT_PUBLIC_ variable for a secret: ${name}`);
  }
  const v = process.env[name];
  if (v == null || v === "") throw new Error(`Missing required env var: ${name}`);
  return v;
}

function opt(name: string, fallback: string): string {
  const v = process.env[name];
  return v == null || v === "" ? fallback : v;
}

/**
 * Load + validate all solver configuration from the environment. Throws on any
 * missing/invalid value so the process never starts half-configured.
 */
export function loadEnv(): SolverEnv {
  const network = opt("SWAP_NETWORK", "testnet") as NetworkName;
  if (!["devnet", "testnet", "mainnet"].includes(network)) {
    throw new Error(`SWAP_NETWORK must be devnet|testnet|mainnet, got '${network}'`);
  }
  if (network === "mainnet" && process.env.ALLOW_MAINNET !== "true") {
    throw new Error(
      "Refusing to start on mainnet. Set ALLOW_MAINNET=true explicitly to run against real funds.",
    );
  }

  // EVM agent key
  // Accept AGENT_PRIVATE_KEY, falling back to PRIVATE_KEY (the MetaMask-export
  // name). Tolerate a missing 0x prefix (MetaMask exports a bare 64-hex key).
  const rawKeyValue = process.env.AGENT_PRIVATE_KEY ?? process.env.PRIVATE_KEY;
  if (!rawKeyValue) {
    throw new Error("Missing required env var: AGENT_PRIVATE_KEY (or PRIVATE_KEY)");
  }
  const normalizedKey = (rawKeyValue.startsWith("0x") ? rawKeyValue : `0x${rawKeyValue}`) as Hex;
  if (!isHex(normalizedKey) || normalizedKey.length !== 66) {
    throw new Error("AGENT_PRIVATE_KEY/PRIVATE_KEY must be a 32-byte hex string (64 hex chars, 0x optional)");
  }
  const agentAccount = privateKeyToAccount(normalizedKey);

  return {
    network,
    originRpcUrl: req("ORIGIN_RPC_URL"),
    escrow: getAddress(req("ESCROW_ADDRESS")),
    oracle: getAddress(req("ORACLE_ADDRESS")),
    wbtc: getAddress(req("WBTC_ADDRESS")),
    agentAccount,

    canton: {
      ledgerHost: req("CANTON_LEDGER_HOST"),
      registryUrl: req("CANTON_REGISTRY_URL"),
      decentralizedPartyId: req("CANTON_ADMIN_PARTY"),
      instrumentId: { admin: req("CANTON_ADMIN_PARTY"), id: opt("CANTON_INSTRUMENT_ID", "CBTC") },
      solverParty: req("SOLVER_CANTON_PARTY"),
      auth: {
        tokenUrl: req("KEYCLOAK_TOKEN_URL"),
        clientId: req("KEYCLOAK_CLIENT_ID"),
        clientSecret: req("KEYCLOAK_CLIENT_SECRET"),
        scope: opt("KEYCLOAK_SCOPE", "daml_ledger_api"),
      },
    },

    startBlock: BigInt(opt("ESCROW_START_BLOCK", "0")),
    pollIntervalMs: Number(opt("POLL_INTERVAL_MS", "15000")),
  };
}

/** A log-safe summary. NEVER returns secrets — keys/secrets are masked. */
export function describeEnv(env: SolverEnv): Record<string, string> {
  return {
    network: env.network,
    originRpcUrl: env.originRpcUrl,
    escrow: env.escrow,
    oracle: env.oracle,
    wbtc: env.wbtc,
    agentAddress: env.agentAccount.address,
    agentKey: "***redacted***",
    cantonLedgerHost: env.canton.ledgerHost,
    solverParty: maskParty(env.canton.solverParty),
    keycloakClientId: env.canton.auth.clientId,
    keycloakClientSecret: "***redacted***",
    startBlock: env.startBlock.toString(),
    pollIntervalMs: String(env.pollIntervalMs),
  };
}

function maskParty(p: string): string {
  return p.length > 20 ? `${p.slice(0, 14)}…${p.slice(-6)}` : p;
}

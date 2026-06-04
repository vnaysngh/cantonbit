/**
 * Solver API entrypoint.
 *   node --env-file=../.env.local --env-file=.env --import tsx src/serve.ts
 *
 * Loads the validated env, wires the config + store + Canton client + agent
 * account, and starts the HTTP API the /swap UI talks to. This serves the API
 * ONLY — it does not run the solver settlement loop (run `npm start` for that).
 * In production you'd run both; for testnet dev it's convenient to run them
 * separately so you can restart the API without disturbing in-flight settlement.
 *
 * ENV LOAD ORDER (Canton creds): load ../.env.local FIRST then .env LAST so the
 * 20-char DevNet KEYCLOAK_CLIENT_ID (in .env) wins over the app's 21-char id,
 * paired with KEYCLOAK_CLIENT_SECRET_DEVNET. Wrong order → invalid_grant.
 */

import { pad, type Hex } from "viem";

import { loadEnv, describeEnv } from "./env.js";
import { makeNetworkConfig } from "./config.js";
import { OrderStore } from "./store.js";
import { CantonClient } from "./canton.js";
import { createApi } from "./api.js";

const STORE_PATH = process.env.STORE_PATH ?? ".oranj-swap/orders.json";
const PORT = Number(process.env.API_PORT ?? 8787);

/** bytes32 cBTC instrument token used as MandateOutput.token (opaque on EVM). */
const CBTC_TOKEN: Hex = (process.env.CBTC_TOKEN_BYTES32 as Hex) ?? pad("0xc87c", { size: 32 });

/** Per-order WBTC ceiling (base units, 8dp). Default 0.001 WBTC for testnet. */
const MAX_WBTC_PER_ORDER = BigInt(process.env.MAX_WBTC_PER_ORDER ?? 100_000); // 0.001 * 1e8

/** Solver fee in basis points (1 bps = 0.01%). Default 0 → clean 1:1. */
const SOLVER_FEE_BPS = Number(process.env.SOLVER_FEE_BPS ?? 0);

async function main() {
  const env = loadEnv();
  console.log("[oranj-swap-api] starting");
  console.log("[config]", JSON.stringify(describeEnv(env), null, 2));

  const { createPublicClient, http } = await import("viem");
  const chainId = await createPublicClient({ transport: http(env.originRpcUrl) }).getChainId();

  const cfg = makeNetworkConfig({
    network: env.network,
    originChainId: chainId,
    escrow: env.escrow,
    oracle: env.oracle,
    wbtc: env.wbtc,
  });

  const store = new OrderStore(STORE_PATH);
  const canton = new CantonClient(
    {
      ledgerHost: env.canton.ledgerHost,
      registryUrl: env.canton.registryUrl,
      decentralizedPartyId: env.canton.decentralizedPartyId,
      instrumentId: env.canton.instrumentId,
      solverParty: env.canton.solverParty,
    },
    env.canton.auth,
  );

  const server = createApi({
    cfg,
    store,
    canton,
    rpcUrl: env.originRpcUrl,
    agentAccount: env.agentAccount,
    chain: { id: chainId, name: `${env.network}:${chainId}` },
    cbtcToken: CBTC_TOKEN,
    maxWbtcPerOrder: MAX_WBTC_PER_ORDER,
    feeBps: SOLVER_FEE_BPS,
  });

  server.listen(PORT, () => {
    console.log(`[oranj-swap-api] listening on http://localhost:${PORT}`);
    console.log(`  GET  /health`);
    console.log(`  POST /quote     { user, wbtcAmount, cantonParty }`);
    console.log(`  POST /orders    { order, signature, cantonParty }`);
    console.log(`  GET  /orders/:orderId`);
    console.log(`  per-order WBTC cap: ${Number(MAX_WBTC_PER_ORDER) / 1e8} WBTC`);
    console.log(`  solver fee: ${SOLVER_FEE_BPS} bps (${SOLVER_FEE_BPS / 100}%)${SOLVER_FEE_BPS === 0 ? " — clean 1:1" : ""}`);
  });

  const stop = () => { server.close(); console.log("\n[oranj-swap-api] stopped"); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e) => { console.error("[oranj-swap-api] fatal:", e); process.exit(1); });

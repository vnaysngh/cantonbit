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
// SECURITY (HIGH-4): bind to loopback by default so the solver API is NOT exposed
// on all interfaces. Expose it only deliberately, behind an authenticated reverse
// proxy, by setting API_BIND_HOST=0.0.0.0 (or a specific interface).
const BIND_HOST = process.env.API_BIND_HOST ?? "127.0.0.1";

/** bytes32 cBTC instrument token used as MandateOutput.token (opaque on EVM). */
const CBTC_TOKEN: Hex = (process.env.CBTC_TOKEN_BYTES32 as Hex) ?? pad("0xc87c", { size: 32 });

/**
 * Solver/bridge fee in basis points (1 bps = 0.01%). Default 20 bps = 0.2% — the
 * cost of running the cross-chain bridge (gas to openFor/attest/finalise, the
 * cBTC float capital, operational risk). Subtracted from the cBTC the user
 * receives: cbtcOut = wbtcIn * (10000 - feeBps) / 10000. Override via
 * SOLVER_FEE_BPS; set 0 for a clean 1:1.
 */
const SOLVER_FEE_BPS = Number(process.env.SOLVER_FEE_BPS ?? 20);

/**
 * De-peg circuit breaker config. We quote WBTC↔cBTC at 1:1 (both = 1 BTC); this
 * pauses swaps if WBTC de-pegs from BTC. Reads the Chainlink WBTC/BTC feed on the
 * origin chain. Disabled if DEPEG_FEED is unset (no feed → no guard; logged).
 * Arbitrum mainnet WBTC/BTC feed: 0x0017abAc5b6f291F9164e35B1234CA1D697f9CF4.
 */
const DEPEG_FEED = process.env.DEPEG_FEED ?? "";
const DEPEG_MAX_DEVIATION_BPS = Number(process.env.DEPEG_MAX_DEVIATION_BPS ?? 100); // ±1%
const DEPEG_MAX_STALENESS_SECONDS = Number(process.env.DEPEG_MAX_STALENESS_SECONDS ?? 24 * 3600);

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

  // De-peg circuit breaker (optional; only if a feed is configured).
  const { DepegGuard } = await import("./depeg.js");
  const depegGuard = DEPEG_FEED
    ? new DepegGuard({
        rpcUrl: env.originRpcUrl,
        feed: DEPEG_FEED as `0x${string}`,
        maxDeviationBps: DEPEG_MAX_DEVIATION_BPS,
        maxStalenessSeconds: DEPEG_MAX_STALENESS_SECONDS,
      })
    : undefined;
  console.log(
    depegGuard
      ? `  de-peg guard: WBTC/BTC feed ${DEPEG_FEED.slice(0, 10)}… max ${DEPEG_MAX_DEVIATION_BPS}bps`
      : `  de-peg guard: DISABLED (set DEPEG_FEED to enable the circuit breaker)`,
  );

  const server = createApi({
    cfg,
    store,
    canton,
    rpcUrl: env.originRpcUrl,
    agentAccount: env.agentAccount,
    chain: { id: chainId, name: `${env.network}:${chainId}` },
    cbtcToken: CBTC_TOKEN,
    feeBps: SOLVER_FEE_BPS,
    depegGuard,
  });

  server.listen(PORT, BIND_HOST, () => {
    console.log(`[oranj-swap-api] listening on http://${BIND_HOST}:${PORT}`);
    if (BIND_HOST !== "127.0.0.1" && BIND_HOST !== "localhost") {
      console.warn(`  [security] bound to ${BIND_HOST} (not loopback) — ensure an authenticated gateway fronts this.`);
    }
    console.log(`  GET  /health`);
    console.log(`  POST /quote     { user, wbtcAmount, cantonParty }`);
    console.log(`  POST /orders    { order, signature, cantonParty }`);
    console.log(`  GET  /orders/:orderId`);
    console.log(`  solver fee: ${SOLVER_FEE_BPS} bps (${SOLVER_FEE_BPS / 100}%)${SOLVER_FEE_BPS === 0 ? " — clean 1:1" : ""}`);
  });

  const stop = () => { server.close(); console.log("\n[oranj-swap-api] stopped"); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e) => { console.error("[oranj-swap-api] fatal:", e); process.exit(1); });

/**
 * API smoke test — boots the real API in-process and hits /health + /quote.
 *   node --env-file=../.env.local --env-file=.env --import tsx src/api.smoke.ts
 *
 * Proves the endpoints assemble a config-consistent order + signable Permit2
 * typed data WITHOUT moving any funds (no openFor submitted). /quote is pure;
 * /health reads the live float.
 */

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createPublicClient, http } from "viem";

import { loadEnv } from "./env.js";
import { makeNetworkConfig } from "./config.js";
import { InMemoryOrderStore } from "./store.js";
import { CantonClient } from "./canton.js";
import { createApi } from "./api.js";
import { verifyCantonParty } from "./order.js";

const RECIPIENT =
  "8f5ca108eb208e8826f868952ede00a5::12200fe103931833a6cb6f080dff41df997dbb9abd8d06384e6405434a04efcf8e2b";

async function main() {
  const env = loadEnv();
  const chainId = await createPublicClient({
    transport: http(env.originRpcUrl)
  }).getChainId();
  const cfg = makeNetworkConfig({
    network: env.network,
    originChainId: chainId,
    escrow: env.escrow,
    oracle: env.oracle,
    wbtc: env.wbtc
  });
  const store = new InMemoryOrderStore();
  const canton = new CantonClient(
    {
      ledgerHost: env.canton.ledgerHost,
      registryUrl: env.canton.registryUrl,
      decentralizedPartyId: env.canton.decentralizedPartyId,
      instrumentId: env.canton.instrumentId,
      solverParty: env.canton.solverParty
    },
    env.canton.auth
  );

  const server = createApi({
    cfg,
    store,
    canton,
    rpcUrl: env.originRpcUrl,
    agentAccount: env.agentAccount,
    chain: { id: chainId, name: `${env.network}:${chainId}` },
    cbtcToken: ("0x" + "c87c".padStart(64, "0")) as `0x${string}`,
    feeBps: 0
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  const base = `http://localhost:${port}`;
  console.log(`API up on ${base}`);

  // --- /health ---
  console.log("\n=== GET /health ===");
  const health = (await (await fetch(`${base}/health`)).json()) as any;
  console.log(JSON.stringify(health, null, 2));
  assert.equal(health.ok, true);
  assert.equal(health.network, env.network);
  assert.ok(
    health.agent?.startsWith("0x"),
    "health should expose the agent address"
  );
  // float may be present or error (DevNet flakiness) — don't hard-fail on it.

  // --- /quote ---
  console.log("\n=== POST /quote ===");
  const quoteRes = await fetch(`${base}/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      user: env.agentAccount.address,
      wbtcAmount: "10000",
      cantonParty: RECIPIENT
    })
  });
  assert.equal(quoteRes.status, 200, `quote status ${quoteRes.status}`);
  const quote = (await quoteRes.json()) as any;
  console.log("orderId:", quote.orderId);
  console.log("permit2.primaryType:", quote.permit2?.primaryType);
  assert.ok(
    /^0x[0-9a-f]{64}$/i.test(quote.orderId),
    "orderId should be bytes32"
  );
  assert.ok(
    quote.permit2?.domain && quote.permit2?.types && quote.permit2?.message,
    "permit2 typed data present"
  );
  assert.equal(quote.permit2.primaryType, "PermitBatchWitnessTransferFrom");
  // feeBps=0 → clean 1:1: CBTC out must equal WBTC in.
  assert.equal(quote.feeBps, 0, "smoke runs at 0 bps");
  assert.equal(
    quote.cbtcAmount,
    "10000",
    "0 bps fee → 1:1 (cbtcOut == wbtcIn)"
  );
  assert.equal(quote.order.inputs[0][1], "10000", "WBTC input unchanged");
  console.log("fee:", quote.feeBps, "bps → 1:1 ✓");
  // The quoted order must bind the cantonParty correctly.
  const committed = quote.order.outputs[0].recipient;
  assert.ok(
    verifyCantonParty(RECIPIENT, committed),
    "quoted recipient must match keccak256(party)"
  );
  console.log("recipient binding verified ✓");

  // --- /quote rejects over-cap ---
  console.log("\n=== POST /quote (over cap → 400) ===");
  const over = await fetch(`${base}/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      user: env.agentAccount.address,
      wbtcAmount: "999999999",
      cantonParty: RECIPIENT
    })
  });
  assert.equal(over.status, 400, "over-cap quote should be rejected");
  console.log("over-cap correctly rejected ✓");

  // --- /quote rejects bad party ---
  console.log("\n=== POST /quote (bad party → 400) ===");
  const badParty = await fetch(`${base}/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      user: env.agentAccount.address,
      wbtcAmount: "10000",
      cantonParty: "not-a-party"
    })
  });
  assert.equal(badParty.status, 400, "bad party should be rejected");
  console.log("bad party correctly rejected ✓");

  // --- /orders/:id 404 ---
  const missing = await fetch(`${base}/orders/0x${"00".repeat(32)}`);
  assert.equal(missing.status, 404, "unknown order should 404");

  server.close();
  console.log("\n\n========== ✓ API SMOKE TEST PASSED ==========");
}

main().catch((e) => {
  console.error("\n✗ API SMOKE FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});

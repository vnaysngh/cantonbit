#!/usr/bin/env npx tsx
/**
 * Phase 0 probe — verify prepare costEstimation, Scan extraTrafficPrice,
 * fee-receiver CC preapproval, and Lighthouse traffic snapshot.
 *
 * Usage: bash scripts/with-env.sh devnet npx tsx scripts/probe-network-fee.mts
 */
import { getLedgerJwt } from "../lib/auth.js";
import { NETWORK } from "../lib/constants.js";
import { networkFeeReceiverParty } from "../lib/canton-network-fee-math.js";
import {
  fetchAmuletPriceUsd,
  fetchExtraTrafficPriceUsdPerMb
} from "../lib/canton-price-scan.js";

const feeReceiver = networkFeeReceiverParty() || NETWORK.warpxPartyId;

async function probePrepare(jwt: string): Promise<Record<string, unknown>> {
  const body = {
    commandId: `probe-nf-${Date.now()}`,
    actAs: [NETWORK.warpxPartyId],
    readAs: [NETWORK.warpxPartyId],
    commands: [],
    disclosedContracts: []
  };
  const r = await fetch(
    `${NETWORK.ledgerHost}/v2/interactive-submission/prepare`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }
  );
  const text = await r.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  return {
    ok: r.ok,
    status: r.status,
    hasCostEstimation: !!(json.costEstimation ?? json.cost_estimation),
    costEstimation: json.costEstimation ?? json.cost_estimation,
    error: r.ok ? undefined : text.slice(0, 300)
  };
}

async function probeFeeReceiverPreapproval(jwt: string): Promise<boolean> {
  const r = await fetch(
    `${NETWORK.validatorHost}/api/validator/v0/scan-proxy/transfer-preapprovals/by-party/${encodeURIComponent(feeReceiver)}`,
    { headers: { Authorization: `Bearer ${jwt}` } }
  );
  if (r.status === 404 || !r.ok) return false;
  const body = (await r.json().catch(() => null)) as {
    transfer_preapproval?: unknown;
  } | null;
  return !!body?.transfer_preapproval;
}

async function probeLighthouse(): Promise<Record<string, unknown>> {
  const party = encodeURIComponent(NETWORK.warpxPartyId);
  const r = await fetch(
    `https://lighthouse.cantonloop.com/api/validators/${party}`,
    { cache: "no-store" }
  );
  if (!r.ok) {
    return { ok: false, status: r.status };
  }
  const j = (await r.json()) as Record<string, unknown>;
  return {
    ok: true,
    total_purchased: j.total_purchased,
    total_consumed: j.total_consumed,
    total_limit: j.total_limit
  };
}

async function main() {
  console.log(`Network: ${NETWORK.name}`);
  console.log(`Ledger: ${NETWORK.ledgerHost}`);
  console.log(`Fee receiver: ${feeReceiver.slice(0, 24)}…`);

  const jwt = await getLedgerJwt();

  console.log("\n=== Scan pricing ===");
  try {
    const [amulet, traffic] = await Promise.all([
      fetchAmuletPriceUsd(),
      fetchExtraTrafficPriceUsdPerMb()
    ]);
    console.log(JSON.stringify({ amuletPriceUsd: amulet, extraTrafficPriceUsdPerMb: traffic }, null, 2));
  } catch (e) {
    console.log("pricing error:", e instanceof Error ? e.message : e);
  }

  console.log("\n=== prepare / costEstimation ===");
  console.log(JSON.stringify(await probePrepare(jwt), null, 2));

  console.log("\n=== fee-receiver CC preapproval ===");
  const preapproved = await probeFeeReceiverPreapproval(jwt);
  console.log(JSON.stringify({ feeReceiver, ccPreapproval: preapproved }, null, 2));

  console.log("\n=== Lighthouse validator traffic ===");
  console.log(JSON.stringify(await probeLighthouse(), null, 2));

  console.log(
    "\n=== Track A (infra) ===\nConfirm TARGET_TRAFFIC_THROUGHPUT with Five North / WarpX ops.\nSee docs/SWAP-FEE-ECONOMICS.md §8"
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

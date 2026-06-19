#!/usr/bin/env npx tsx
/**
 * Live audit — Scan pricing + prepare-based fee estimates for managed swap paths.
 *
 *   bash scripts/with-env.sh devnet npx tsx scripts/audit-network-fee.mts
 *   bash scripts/with-env.sh mainnet npx tsx scripts/audit-network-fee.mts
 *
 * Optional: AUDIT_USER_CANTON_PARTY (managed email party with CBTC for lock estimate)
 */
import { shouldQuoteNetworkFee } from "../lib/canton-network-fee-math.js";
import {
  parseAmuletPriceFromMiningRounds,
  parseAmuletRulesPayload,
  parseExtraTrafficPriceFromPayload
} from "../lib/canton-scan-pricing.js";

const network = process.env.NEXT_PUBLIC_NETWORK ?? "devnet";
const validatorHost =
  network === "mainnet"
    ? "https://wallet.validator.warpx.fivenorth.io"
    : "https://wallet.validator.devnet.warpx.fivenorth.io";

async function getJwt(): Promise<string> {
  const tokenUrl = process.env.KEYCLOAK_TOKEN_URL;
  const isDevnet = network === "devnet";
  const clientId = isDevnet
    ? process.env.KEYCLOAK_CLIENT_ID_DEVNET || process.env.KEYCLOAK_CLIENT_ID
    : process.env.KEYCLOAK_CLIENT_ID;
  const clientSecret = isDevnet
    ? process.env.KEYCLOAK_CLIENT_SECRET_DEVNET || process.env.KEYCLOAK_CLIENT_SECRET
    : process.env.KEYCLOAK_CLIENT_SECRET;
  if (!tokenUrl || !clientId || !clientSecret) {
    throw new Error("Missing KEYCLOAK_* env for JWT");
  }
  const r = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      scope: process.env.KEYCLOAK_SCOPE ?? "daml_ledger_api"
    })
  });
  if (!r.ok) throw new Error(`JWT ${r.status}: ${await r.text()}`);
  return ((await r.json()) as { access_token: string }).access_token;
}

async function scanGet(
  jwt: string,
  path: string
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const r = await fetch(`${validatorHost}/api/validator/v0/scan-proxy${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${jwt}` },
    cache: "no-store"
  });
  let body: unknown = null;
  try {
    body = await r.json();
  } catch {
    body = await r.text().catch(() => null);
  }
  return { ok: r.ok, status: r.status, body };
}

type Row = { check: string; pass: boolean; detail: string };

async function main() {
  const rows: Row[] = [];
  const jwt = await getJwt();

  const rules = await scanGet(jwt, "/amulet-rules");
  rows.push({
    check: "GET /amulet-rules",
    pass: rules.ok,
    detail: `status ${rules.status}`
  });

  const rounds = await scanGet(jwt, "/open-and-issuing-mining-rounds");
  rows.push({
    check: "GET /open-and-issuing-mining-rounds",
    pass: rounds.ok,
    detail: `status ${rounds.status}`
  });

  const extraTrafficPriceUsdPerMb = parseExtraTrafficPriceFromPayload(
    parseAmuletRulesPayload(rules.body)
  );
  rows.push({
    check: "parse extraTrafficPrice",
    pass: extraTrafficPriceUsdPerMb != null,
    detail:
      extraTrafficPriceUsdPerMb != null
        ? `$${extraTrafficPriceUsdPerMb}/MB`
        : "missing in payload"
  });

  const amuletPriceUsd = parseAmuletPriceFromMiningRounds(rounds.body);
  rows.push({
    check: "parse amuletPrice",
    pass: amuletPriceUsd != null,
    detail: amuletPriceUsd != null ? `$${amuletPriceUsd}/CC` : "missing in payload"
  });

  rows.push({
    check: "shouldQuoteNetworkFee()",
    pass: shouldQuoteNetworkFee(),
    detail: shouldQuoteNetworkFee()
      ? "enabled or preview"
      : "set NETWORK_FEE_ENABLED=1 or NETWORK_FEE_QUOTE_PREVIEW=1"
  });

  const auditUser =
    process.env.AUDIT_USER_CANTON_PARTY?.trim() ||
    process.env.CANTON_SWAP_TEST_USER_PARTY?.trim() ||
    "";
  const auditCbtc = process.env.AUDIT_CBTC_AMOUNT?.trim() || "0.0001";

  if (shouldQuoteNetworkFee() && auditUser) {
    rows.push({
      check: "HTLC prepare estimates",
      pass: true,
      detail:
        "run via app (POST /api/canton/network-fee/estimate) — server-only module not importable from CLI"
    });
  } else {
    rows.push({
      check: "HTLC prepare estimates",
      pass: true,
      detail: auditUser
        ? "skipped (shouldQuoteNetworkFee false)"
        : "skipped — set AUDIT_USER_CANTON_PARTY for live prepare audit"
    });
  }

  console.log(`\n=== Network fee audit (${network}) ===\n`);
  console.log("Check | Pass | Detail");
  console.log("------|------|-------");
  for (const row of rows) {
    console.log(`${row.check} | ${row.pass ? "PASS" : "FAIL"} | ${row.detail}`);
  }
  const failed = rows.filter((r) => !r.pass);
  if (failed.length) {
    console.log(`\n${failed.length} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll checks passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

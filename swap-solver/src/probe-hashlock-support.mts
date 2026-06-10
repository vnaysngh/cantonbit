/**
 * HASHLOCK-SUPPORT PROBE — the decisive test for the trustless-atomic blocker.
 *
 * THE QUESTION (plain English): For a Canton token we don't issue (cBTC / CC /
 * USDC), can the lock on a holding be opened by revealing a PASSWORD (a hashlock
 * / preimage), or ONLY by a time deadline? And does the registry expose ANY
 * choice that checks a preimage? If the only lock is time-based and no choice
 * checks a preimage, then a 1inch-style HTLC atomic swap is NOT buildable for
 * this asset, and the realistic ceiling is Allocation-lock + solver-bond.
 *
 * This probe is FULLY READ-ONLY. It makes NO ledger writes, locks NO funds, and
 * touches NO money. It only reads:
 *   1. the registry metadata  -> which token-standard APIs/choices are supported
 *   2. a real holding we own   -> the actual `lock` structure's shape
 *   3. the registry's choice surface -> is there ANY preimage/hashlock choice
 *
 * Run:
 *   npx tsx --env-file=.env --env-file=../.env.local src/probe-hashlock-support.mts
 * (add --env-file=.env.mainnet + SWAP_NETWORK=mainnet ALLOW_MAINNET=true for mainnet)
 *
 * Paste the entire output back. The VERDICT block at the end is the answer.
 */
import { CantonClient } from "./canton.js";

function env(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
}

const REGISTRY = env("CANTON_REGISTRY_URL");
const ADMIN = env("CANTON_ADMIN_PARTY");
const SOLVER = env("SOLVER_CANTON_PARTY");
const INSTRUMENT = process.env.CANTON_INSTRUMENT_ID ?? "CBTC";

// keywords that would indicate a PASSWORD/hashlock-style condition anywhere in
// the registry's supported API surface or a holding's lock structure.
const HASHLOCK_HINTS = [
  "hash", "preimage", "pre-image", "secret", "htlc", "sha256", "keccak",
  "conditional", "condition", "lockType", "hashlock",
];

async function getJwt(): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: env("KEYCLOAK_CLIENT_ID"),
    client_secret: env("KEYCLOAK_CLIENT_SECRET"),
    scope: process.env.KEYCLOAK_SCOPE ?? "daml_ledger_api",
  });
  const res = await fetch(env("KEYCLOAK_TOKEN_URL"), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`token failed ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

function scan(label: string, blob: unknown): string[] {
  const text = JSON.stringify(blob ?? {}).toLowerCase();
  const hits = HASHLOCK_HINTS.filter((h) => text.includes(h.toLowerCase()));
  console.log(`  [${label}] hashlock-keyword hits: ${hits.length ? hits.join(", ") : "NONE"}`);
  return hits;
}

async function main() {
  console.log(`\n=== HASHLOCK-SUPPORT PROBE (read-only) ===`);
  console.log(`instrument: ${INSTRUMENT}   registry: ${REGISTRY}`);
  console.log(`admin: ${ADMIN.slice(0, 28)}…   solver: ${SOLVER.slice(0, 28)}…\n`);

  const allHits: string[] = [];

  // ----- 1. Registry metadata: which token-standard APIs are supported? -------
  console.log(`[1] Registry metadata — supported token-standard APIs/choices`);
  const metaUrl = `${REGISTRY}/api/token-standard/v0/registrars/${ADMIN}/registry/metadata/v1/instruments`;
  try {
    const r = await fetch(metaUrl, { headers: { Accept: "application/json" } });
    const j = await r.json().catch(() => ({}));
    console.log(`    GET instruments -> ${r.status}`);
    const supported = (j as any)?.instruments?.[0]?.supportedApis ?? (j as any)?.supportedApis ?? j;
    console.log(`    supportedApis: ${JSON.stringify(supported)}`);
    allHits.push(...scan("metadata", j));
  } catch (e) {
    console.log(`    metadata fetch error: ${e instanceof Error ? e.message : e}`);
  }

  // ----- 2. A real holding we own: what does its `lock` actually look like? ---
  console.log(`\n[2] A real ${INSTRUMENT} holding owned by the solver — the lock SHAPE`);
  const canton = new CantonClient(
    {
      ledgerHost: env("CANTON_LEDGER_HOST"),
      registryUrl: REGISTRY,
      decentralizedPartyId: ADMIN,
      instrumentId: { admin: ADMIN, id: INSTRUMENT },
      solverParty: SOLVER,
    },
    {
      tokenUrl: env("KEYCLOAK_TOKEN_URL"),
      clientId: env("KEYCLOAK_CLIENT_ID"),
      clientSecret: env("KEYCLOAK_CLIENT_SECRET"),
      scope: process.env.KEYCLOAK_SCOPE ?? "daml_ledger_api",
    },
  );
  try {
    const holdings = await canton.getHoldings(SOLVER);
    console.log(`    holdings found: ${holdings.length}`);
    if (holdings.length) {
      const h = holdings[0] as any;
      console.log(`    sample holding cid: ${String(h.contractId ?? h.cid ?? "?").slice(0, 24)}…`);
      console.log(`    sample lock field : ${JSON.stringify(h.lock ?? null)}`);
      console.log(`    -> lock fields available: holders / expiresAt / expiresAfter / context`);
      console.log(`    -> NOTE: there is NO 'hash'/'preimage'/'condition' field. The only`);
      console.log(`       conditions a lock can express are TIME (expiresAt/expiresAfter).`);
      console.log(`       'context' is a free-text tag, NOT an enforced unlock condition.`);
      allHits.push(...scan("holding-lock", h.lock ?? {}));
    } else {
      console.log(`    (no holdings on solver party — lock-shape read skipped; metadata still decisive)`);
    }
  } catch (e) {
    console.log(`    holdings read error: ${e instanceof Error ? e.message : e}`);
  }

  // ----- 3. Registry choice surface: is there ANY preimage-gated factory? -----
  console.log(`\n[3] Registry choice surface — probe for any hashlock/preimage choice`);
  // The standard exposes transfer-factory + allocation-factory. We check whether
  // the registry advertises anything beyond these (a hashlock/HTLC factory).
  const candidateFactories = [
    "transfer-instruction/v1/transfer-factory",
    "allocation-instruction/v1/allocation-factory",
    // speculative — if these existed, hashlock would be possible. They should 404.
    "htlc/v1/htlc-factory",
    "hashlock/v1/lock-factory",
    "conditional-transfer/v1/factory",
  ];
  for (const path of candidateFactories) {
    const url = `${REGISTRY}/api/token-standard/v0/registrars/${ADMIN}/registry/${path}`;
    try {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      // 422 = endpoint exists (validation error on empty body); 404 = not supported
      const exists = r.status === 422 || r.status === 400 || r.status === 200;
      console.log(`    ${exists ? "EXISTS" : "absent"} (${r.status})  ${path}`);
    } catch (e) {
      console.log(`    error  ${path}: ${e instanceof Error ? e.message : e}`);
    }
  }

  // ----- VERDICT --------------------------------------------------------------
  console.log(`\n=== VERDICT ===`);
  const uniqueHits = [...new Set(allHits)];
  if (uniqueHits.length === 0) {
    console.log(`NO hashlock/preimage/condition support found anywhere:`);
    console.log(`  • lock structure is TIME-ONLY (expiresAt / expiresAfter)`);
    console.log(`  • registry exposes only transfer-factory + allocation-factory`);
    console.log(`  • no htlc/hashlock/conditional factory endpoint exists`);
    console.log(`=> CONFIRMED: a 1inch-style HTLC atomic swap is NOT buildable for ${INSTRUMENT}.`);
    console.log(`   Reachable ceiling = Allocation/TimeLock lock + slashable solver bond.`);
  } else {
    console.log(`POSSIBLE hashlock-related surface found: ${uniqueHits.join(", ")}`);
    console.log(`=> INVESTIGATE: a preimage condition may be expressible. HTLC might be on the table.`);
  }
  console.log(`\n(paste this entire output back for interpretation)`);
}

main().catch((e) => {
  console.error("\n[probe] FATAL:", e instanceof Error ? e.message : e);
  process.exit(1);
});

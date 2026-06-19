#!/usr/bin/env npx tsx
/**
 * One-off: move mis-filed user WBTC claim tx from counter_claim_update_id → main_claim_tx
 * on legacy canton-to-evm orders (pre direction-aware field mapping).
 *
 *   bash scripts/with-env.sh devnet npx tsx scripts/backfill-reverse-htlc-claim-fields.mts [--dry-run]
 */
const dryRun = process.argv.includes("--dry-run");

function isEvmTxHash(s: string | undefined): s is string {
  return !!s && /^0x[0-9a-fA-F]{64}$/.test(s);
}

async function main() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const headers = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
    "Content-Type": "application/json",
    Prefer: "return=representation"
  };

  const listUrl =
    `${supabaseUrl}/rest/v1/htlc_orders?direction=eq.canton-to-evm` +
    `&select=id,status,main_claim_tx,counter_claim_update_id`;
  const r = await fetch(listUrl, { headers, cache: "no-store" });
  const rows = (await r.json()) as {
    id: string;
    status: string;
    main_claim_tx: string | null;
    counter_claim_update_id: string | null;
  }[];

  const candidates = rows.filter(
    (o) =>
      isEvmTxHash(o.counter_claim_update_id ?? undefined) &&
      !isEvmTxHash(o.main_claim_tx ?? undefined)
  );

  console.log(`Found ${candidates.length} reverse order(s) with legacy EVM claim in counter_claim_update_id`);
  if (candidates.length === 0) return;

  for (const o of candidates) {
    const patch = {
      main_claim_tx: o.counter_claim_update_id,
      counter_claim_update_id: null
    };
    console.log(`${dryRun ? "[dry-run] " : ""}${o.id.slice(0, 18)}… status=${o.status} → main_claim_tx=${o.counter_claim_update_id?.slice(0, 14)}…`);
    if (dryRun) continue;
    const pr = await fetch(
      `${supabaseUrl}/rest/v1/htlc_orders?id=eq.${encodeURIComponent(o.id)}`,
      { method: "PATCH", headers, body: JSON.stringify(patch) }
    );
    if (!pr.ok) {
      console.error(`  PATCH failed ${pr.status}: ${await pr.text()}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

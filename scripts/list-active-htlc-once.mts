#!/usr/bin/env npx tsx
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnvFile(name: string) {
  try {
    const raw = readFileSync(resolve(process.cwd(), name), "utf8");
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i <= 0) continue;
      const k = t.slice(0, i).trim();
      let v = t.slice(i + 1).trim();
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      if (!process.env[k]) process.env[k] = v;
    }
  } catch {
    /* optional */
  }
}

loadEnvFile(".env.local");
loadEnvFile(".env.devnet");

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const r = await fetch(
    `${url}/rest/v1/htlc_orders?status=not.in.(main_claimed,refunded,cancelled,failed)&select=id,status,direction,counter_mode,created_at,cbtc_amount,allocation_cid,htlc_cid,counter_lock_tx,main_lock_tx&order=created_at.desc&limit=20`,
    {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      cache: "no-store"
    }
  );
  const rows = (await r.json()) as Record<string, unknown>[];
  console.log(JSON.stringify(rows, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

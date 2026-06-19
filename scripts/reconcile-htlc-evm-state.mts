#!/usr/bin/env npx tsx
/** One-off: fix reverse HTLC orders corrupted by phantom-lock reconcile after EVM claim. */
import {
  hasEvmClaimedForHashLock,
  isReverseEvmCounterLockReady
} from "../lib/htlc-evm-counter-lock.js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing Supabase env");
  process.exit(1);
}

async function main() {
  const partyFilter = process.argv[2];
  let q =
    `${url}/rest/v1/htlc_orders?direction=eq.canton-to-evm&status=not.in.(main_claimed,refunded,cancelled,failed)&select=*`;
  if (partyFilter) {
    q += `&user_canton_party=like.${encodeURIComponent(partyFilter)}*`;
  }
  const r = await fetch(q, {
    headers: { apikey: key, Authorization: `Bearer ${key}` }
  });
  const rows = (await r.json()) as Record<string, unknown>[];
  for (const o of rows) {
    const id = String(o.id);
    if (id.startsWith("smoke-")) continue;
    const hashLock = String(o.hash_lock ?? id);
    const claimed = await hasEvmClaimedForHashLock(hashLock);
    const status = String(o.status);
    let patch: Record<string, unknown> | null = null;
    if (claimed && status !== "counter_claimed" && status !== "main_claimed") {
      patch = { status: "counter_claimed", updated_at: new Date().toISOString() };
      console.log(`FIX ${id.slice(0, 18)}… ${status} → counter_claimed (EVM Claimed)`);
    } else if (status === "counter_locked" && !claimed) {
      const probe = await isReverseEvmCounterLockReady({
        hashLock,
        wbtcAmount: String(o.wbtc_amount),
        userEvmAddress: String(o.user_evm_address)
      });
      if (!probe.ready) {
        patch = {
          status: "main_locked",
          counter_lock_tx: null,
          updated_at: new Date().toISOString()
        };
        console.log(`FIX ${id.slice(0, 18)}… phantom counter_locked → main_locked`);
      }
    } else {
      console.log(`OK  ${id.slice(0, 18)}… ${status} claimed=${claimed}`);
    }
    if (patch) {
      await fetch(`${url}/rest/v1/htlc_orders?id=eq.${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal"
        },
        body: JSON.stringify(patch)
      });
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

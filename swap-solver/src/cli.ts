/**
 * Operator CLI — inspect the solver's order state + health.
 *   node --import tsx src/cli.ts status        # health report + counts
 *   node --import tsx src/cli.ts list [status] # list orders (optionally by status)
 *   node --import tsx src/cli.ts show <orderId># full record for one order
 *
 * Reads the same store file the solver writes (STORE_PATH env, default
 * .oranj-swap/orders.json). Read-only — never mutates state.
 */

import { SupabaseOrderStore, type OrderStore } from "./store.js";
import { buildHealthReport, allOrders, summarize } from "./monitor.js";
import type { Hex } from "viem";


function now(): number { return Math.floor(Date.now() / 1000); }

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);
  const store: OrderStore = SupabaseOrderStore.fromEnv();

  switch (cmd) {
    case "status": {
      const r = await buildHealthReport(store, { now: now(), staleSeenSeconds: 30 * 60, deadlineWarnSeconds: 30 * 60 });
      console.log(`\nSolver health: ${summarize(r)}\n`);
      if (r.atRisk.length) {
        console.log(`⚠ AT RISK (cBTC delivered, WBTC not yet finalised) — solver capital exposed:`);
        for (const o of r.atRisk) console.log(`   ${o.orderId.slice(0, 16)}…  status=${o.status}  deadline_in=${o.order.fillDeadline - now()}s`);
      }
      if (r.stuckDelivering.length) {
        console.log(`\n⚠ STUCK DELIVERING (offer unaccepted, near/past deadline):`);
        for (const o of r.stuckDelivering) console.log(`   ${o.orderId.slice(0, 16)}…  deadline_in=${o.order.fillDeadline - now()}s  ref=${o.cantonDeliveryRef ?? "-"}`);
      }
      if (r.staleSeen.length) {
        console.log(`\n⚠ STALE SEEN (locked, delivery not started):`);
        for (const o of r.staleSeen) console.log(`   ${o.orderId.slice(0, 16)}…  seenAt=${o.createdAt}`);
      }
      if (r.failed.length) {
        console.log(`\n✗ FAILED (needs attention):`);
        for (const o of r.failed) console.log(`   ${o.orderId.slice(0, 16)}…  ${o.note ?? ""}`);
      }
      if (r.reconciliationGaps.length) {
        console.log(`\n✗ RECONCILIATION GAPS (missing tx/timestamp records):`);
        for (const o of r.reconciliationGaps) console.log(`   ${o.orderId.slice(0, 16)}…  status=${o.status}`);
      }
      if (r.status === "ok") console.log("All clear — no orders need attention.");
      console.log("");
      // Non-zero exit on critical so it can gate a healthcheck/cron.
      if (r.status === "critical") process.exit(2);
      break;
    }

    case "list": {
      const orders = (await allOrders(store)).filter((o) => !arg || o.status === arg);
      orders.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      console.log(`\n${orders.length} order(s)${arg ? ` with status '${arg}'` : ""}:\n`);
      for (const o of orders) {
        console.log(`  ${o.orderId.slice(0, 18)}…  ${o.status.padEnd(11)}  fill=${o.fillTimestamp ?? "-"}  ${o.note ?? ""}`);
      }
      console.log("");
      break;
    }

    case "show": {
      if (!arg) { console.error("usage: show <orderId>"); process.exit(1); }
      const rec = (await store.get(arg as Hex)) ?? (await allOrders(store)).find((o) => o.orderId.startsWith(arg!));
      if (!rec) { console.error(`order not found: ${arg}`); process.exit(1); }
      console.log(JSON.stringify(rec, null, 2));
      break;
    }

    default:
      console.log("usage: cli.ts <status|list [status]|show <orderId>>");
      process.exit(1);
  }
}

main();

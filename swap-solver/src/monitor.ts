/**
 * Operational monitoring + reconciliation.
 *
 * Surfaces the order states an operator must watch — above all the DANGEROUS
 * window in two-legged settlement: an order that's `delivered` (cBTC out on
 * Canton) but not yet `finalised` (WBTC not yet claimed on Base). Every such
 * order is solver capital at risk until finalise lands.
 *
 * Also flags:
 *   - stuck `delivering`: offer created but the user never accepted, near/past deadline
 *   - stale `seen`: locked WBTC observed but delivery hasn't started (RPC/float?)
 *   - `failed`: needs human attention
 *   - reconciliation gap: a Canton delivery (cantonDeliveryRef set) with no finaliseTxHash
 */

import type { OrderStore, OrderRecord } from "./store.js";

export interface HealthReport {
  counts: Record<string, number>;
  /** delivered-not-finalised: cBTC out, WBTC unclaimed — capital at risk. */
  atRisk: OrderRecord[];
  /** delivering past (or near) fillDeadline — likely won't complete. */
  stuckDelivering: OrderRecord[];
  /** seen but not progressed for a while — delivery not starting. */
  staleSeen: OrderRecord[];
  /** failed orders needing attention. */
  failed: OrderRecord[];
  /** delivered/finalised but missing the matching tx record (reconciliation gap). */
  reconciliationGaps: OrderRecord[];
  /** overall: ok | warn | critical */
  status: "ok" | "warn" | "critical";
}

export interface MonitorParams {
  now: number; // unix seconds
  /** An order `seen` longer than this (s) without delivering is stale. */
  staleSeenSeconds: number;
  /** Warn when a `delivering` order is within this many seconds of fillDeadline. */
  deadlineWarnSeconds: number;
}

export async function buildHealthReport(store: OrderStore, p: MonitorParams): Promise<HealthReport> {
  const all = await allOrders(store);
  const counts: Record<string, number> = {};
  for (const o of all) counts[o.status] = (counts[o.status] ?? 0) + 1;

  const atRisk = all.filter((o) => o.status === "delivered" || o.status === "attested");

  const stuckDelivering = all.filter(
    (o) => o.status === "delivering" && o.order.fillDeadline - p.now < p.deadlineWarnSeconds,
  );

  const staleSeen = all.filter(
    (o) => o.status === "seen" && p.now - Math.floor(Date.parse(o.createdAt) / 1000) > p.staleSeenSeconds,
  );

  const failed = all.filter((o) => o.status === "failed");

  // Reconciliation: a finalised order must have a finaliseTxHash; a delivered
  // order must have a fillTimestamp + cantonDeliveryRef. Missing = data gap.
  const reconciliationGaps = all.filter((o) => {
    if (o.status === "finalised" && !o.finaliseTxHash) return true;
    if ((o.status === "delivered" || o.status === "attested") && o.fillTimestamp == null) return true;
    return false;
  });

  // Status escalation.
  let status: HealthReport["status"] = "ok";
  if (staleSeen.length || stuckDelivering.length || failed.length) status = "warn";
  // atRisk past its fillDeadline is critical — we may no longer be able to finalise.
  const criticalAtRisk = atRisk.some((o) => o.order.fillDeadline < p.now);
  if (criticalAtRisk || reconciliationGaps.length) status = "critical";

  return { counts, atRisk, stuckDelivering, staleSeen, failed, reconciliationGaps, status };
}

/** All orders across every status (the store exposes byStatus; union them). */
export async function allOrders(store: OrderStore): Promise<OrderRecord[]> {
  const statuses = ["seen", "delivering", "delivered", "attested", "finalised", "refunded", "failed"] as const;
  const groups = await Promise.all(statuses.map((s) => store.byStatus(s)));
  return groups.flat();
}

/** One-line human summary for logs/alerts. */
export function summarize(r: HealthReport): string {
  const c = Object.entries(r.counts).map(([k, v]) => `${k}:${v}`).join(" ");
  const flags = [
    r.atRisk.length ? `atRisk:${r.atRisk.length}` : "",
    r.stuckDelivering.length ? `stuckDelivering:${r.stuckDelivering.length}` : "",
    r.staleSeen.length ? `staleSeen:${r.staleSeen.length}` : "",
    r.failed.length ? `failed:${r.failed.length}` : "",
    r.reconciliationGaps.length ? `reconGaps:${r.reconciliationGaps.length}` : "",
  ].filter(Boolean).join(" ");
  return `[${r.status}] ${c}${flags ? " | " + flags : ""}`;
}

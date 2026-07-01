import { appendFileSync, existsSync, readFileSync } from "node:fs";

import { pingpongLogPath } from "./config";

/** One JSONL record per attempted ping-pong transfer leg. */
export interface PingpongLogEntry {
  ts: string;
  type: "transfer";
  cycle: number;
  from: string;
  to: string;
  amount: string; // CBTC
  ok: boolean;
  error?: string;
}

/** Append one transfer result to the ping-pong log (JSONL, one line each). */
export function logPingpongTransfer(
  entry: Omit<PingpongLogEntry, "ts" | "type">,
  logPath = pingpongLogPath()
): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    type: "transfer",
    ...entry
  });
  appendFileSync(logPath, `${line}\n`, "utf8");
}

export interface PingpongStats {
  total: number;
  ok: number;
  failed: number;
  totalCbtcMoved: string;
  cycles: number;
  firstTs: string | null;
  lastTs: string | null;
  byTrader: Record<string, { sent: number; received: number }>;
}

/** Read the whole log and summarize. Tolerant of partial/corrupt trailing lines. */
export function readPingpongStats(logPath = pingpongLogPath()): PingpongStats {
  const empty: PingpongStats = {
    total: 0,
    ok: 0,
    failed: 0,
    totalCbtcMoved: "0",
    cycles: 0,
    firstTs: null,
    lastTs: null,
    byTrader: {}
  };
  if (!existsSync(logPath)) return empty;

  const raw = readFileSync(logPath, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim());
  let ok = 0;
  let failed = 0;
  let movedSats = 0n;
  const cycleSet = new Set<number>();
  const byTrader: Record<string, { sent: number; received: number }> = {};
  let firstTs: string | null = null;
  let lastTs: string | null = null;

  for (const line of lines) {
    let e: PingpongLogEntry;
    try {
      e = JSON.parse(line) as PingpongLogEntry;
    } catch {
      continue; // skip a torn last line
    }
    if (e.type !== "transfer") continue;
    if (firstTs === null) firstTs = e.ts;
    lastTs = e.ts;
    cycleSet.add(e.cycle);
    if (e.ok) {
      ok++;
      // amount is CBTC with up to 8 decimals; accumulate in sats to avoid float drift.
      const [whole, frac = ""] = String(e.amount).split(".");
      const sats = BigInt(whole || "0") * 100_000_000n + BigInt((frac + "00000000").slice(0, 8));
      movedSats += sats;
      const t = byTrader[e.from] ?? (byTrader[e.from] = { sent: 0, received: 0 });
      t.sent++;
      const r = byTrader[e.to] ?? (byTrader[e.to] = { sent: 0, received: 0 });
      r.received++;
    } else {
      failed++;
    }
  }

  const movedCbtc = `${movedSats / 100_000_000n}.${(movedSats % 100_000_000n)
    .toString()
    .padStart(8, "0")}`;

  return {
    total: ok + failed,
    ok,
    failed,
    totalCbtcMoved: movedCbtc,
    cycles: cycleSet.size,
    firstTs,
    lastTs,
    byTrader
  };
}

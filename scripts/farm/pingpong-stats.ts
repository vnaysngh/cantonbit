#!/usr/bin/env npx tsx
/**
 * Print lifetime ping-pong farm stats from the persisted log
 * (farm-pingpong.log). Read-only; safe to run anytime, even while the farm runs.
 *
 * Usage:
 *   npm run farm:pingpong:stats:mainnet
 */
import { pingpongLogPath } from "./lib/config";
import { readPingpongStats } from "./lib/pingpong-log";

function main(): void {
  const path = pingpongLogPath();
  const s = readPingpongStats();

  console.log(`Ping-pong farm stats  (log: ${path})\n`);
  if (s.total === 0) {
    console.log("No transfers logged yet.");
    return;
  }
  console.log(`  Transfers:    ${s.ok} ok / ${s.failed} failed  (${s.total} total)`);
  console.log(`  CBTC moved:   ${s.totalCbtcMoved} CBTC`);
  console.log(`  Cycles:       ${s.cycles}`);
  console.log(`  First:        ${s.firstTs ?? "-"}`);
  console.log(`  Last:         ${s.lastTs ?? "-"}`);
  console.log(`\n  Per trader (sent / received):`);
  const names = Object.keys(s.byTrader).sort();
  for (const name of names) {
    const t = s.byTrader[name]!;
    console.log(`    ${name}: sent ${t.sent}, received ${t.received}`);
  }
}

main();

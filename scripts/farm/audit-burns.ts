#!/usr/bin/env npx tsx
/**
 * Retro-audit farm-swap.log for CC burn/fee ledger choices.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { SWAP_LOG_FILE, assertMainnetNetwork, loadFleet } from "./lib/config";
import { auditSwapUpdatesForCcBurn } from "./lib/burn-audit";
import { getLedgerJwt } from "./lib/jwt";

interface LogRow {
  swapId?: string;
  offerUpdateId?: string;
  fillUpdateId?: string;
  trader?: string;
  ccBurnSuspected?: boolean;
}

export async function runBurnAudit(): Promise<void> {
  assertMainnetNetwork();
  const logPath = resolve(process.cwd(), SWAP_LOG_FILE);
  if (!existsSync(logPath)) {
    console.error(`Missing ${SWAP_LOG_FILE}`);
    process.exit(1);
  }

  const fleet = loadFleet();
  const jwt = await getLedgerJwt();
  const lines = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
  const rows = lines.map((l) => JSON.parse(l) as LogRow).filter((r) => r.type !== "run_summary" && r.offerUpdateId);

  console.log(`Auditing ${rows.length} swap(s) in ${SWAP_LOG_FILE}\n`);

  let suspected = 0;
  for (const row of rows) {
    if (!row.offerUpdateId || !row.fillUpdateId) continue;
    const burn = await auditSwapUpdatesForCcBurn({
      jwt,
      updateIds: [row.offerUpdateId, row.fillUpdateId],
      partyIds: [row.trader ?? "", fleet.vault, fleet.treasury].filter(Boolean)
    });
    const flag = burn.ccBurnSuspected ? "BURN?" : "ok";
    if (burn.ccBurnSuspected) suspected++;
    console.log(
      `${flag}  ${row.swapId?.slice(0, 8) ?? "?"}  scanned=${burn.updatesScanned}/2  choices=${burn.flaggedChoices.join("; ") || "none"}`
    );
  }

  console.log(`\nSummary: ${suspected}/${rows.length} swaps flagged for CC burn/fee choices`);
  console.log(
    "Note: Token Standard swap legs should show 'ok'. Burns appear for preapproval/traffic, not swap volume."
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runBurnAudit().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}

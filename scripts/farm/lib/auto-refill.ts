import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { treasuryParty } from "./config";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const REFILL_COOLDOWN_MS = 10 * 60 * 1000;

const VAULT_CBTC_REFILL = "0.005";
const TRADER_CBTC_EACH = "0.0002";

let lastRefillAt = 0;

export interface AutoRefillResult {
  ran: boolean;
  vaultCbtc?: string;
  traderCbtcEach?: string;
  /** Planner should re-bootstrap vault CBTC cache after treasury fund. */
  cacheRefreshNeeded?: boolean;
  output: string;
}

function runMainnetScript(
  script: string,
  args: string[]
): { ok: boolean; output: string } {
  const r = spawnSync(
    "bash",
    ["scripts/with-env.sh", "mainnet", "npx", "tsx", script, ...args],
    {
      cwd: REPO_ROOT,
      env: process.env,
      encoding: "utf8",
      timeout: 600_000
    }
  );
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  return { ok: r.status === 0, output };
}

function needsVaultCacheRefresh(msg: string): boolean {
  return /no spendable CBTC UTXO/i.test(msg) || /cached spendable: 0/i.test(msg);
}

function needsVaultCbtc(msg: string): boolean {
  return (
    needsVaultCacheRefresh(msg) ||
    /vault=low CBTC/i.test(msg) ||
    (/vault CBTC=0/i.test(msg) && /CC→CBTC:.*vault=low CBTC/i.test(msg))
  );
}

function needsTraderCbtc(msg: string): boolean {
  if (needsVaultCacheRefresh(msg)) return false;
  return (
    /CBTC→CC: traders=0\//i.test(msg) ||
    (/need 0\.00001\+0\.0000/i.test(msg) && /CBTC→CC/i.test(msg))
  );
}

/**
 * On float blockers, fund vault CBTC from treasury and/or traders from treasury.
 * Throttled so a stuck planner does not spam transfers.
 */
export function tryAutoRefillFromPlanError(msg: string): AutoRefillResult {
  const empty: AutoRefillResult = { ran: false, output: "" };
  if (!/no viable swap/i.test(msg)) return empty;
  if (Date.now() - lastRefillAt < REFILL_COOLDOWN_MS) {
    console.warn(
      `  auto-refill skipped: cooldown (${Math.round((REFILL_COOLDOWN_MS - (Date.now() - lastRefillAt)) / 1000)}s left)`
    );
    return empty;
  }

  const chunks: string[] = [];
  let ran = false;
  let vaultCbtc: string | undefined;
  let traderCbtcEach: string | undefined;
  let cacheRefreshNeeded = false;

  if (needsVaultCbtc(msg)) {
    const reason = needsVaultCacheRefresh(msg)
      ? "vault CBTC not spendable (cache empty)"
      : "vault CBTC low";
    console.warn(
      `  auto-refill: ${reason} → treasury fund ${VAULT_CBTC_REFILL} CBTC`
    );
    const r = runMainnetScript("scripts/fund-swap-vault.mts", [
      "--i-understand-mainnet",
      `--cbtc=${VAULT_CBTC_REFILL}`,
      "--cc=0"
    ]);
    chunks.push(r.output);
    if (r.ok) {
      ran = true;
      vaultCbtc = VAULT_CBTC_REFILL;
      cacheRefreshNeeded = true;
      console.warn(`  auto-refill: vault CBTC fund ok`);
    } else {
      console.error(`  auto-refill: vault CBTC fund failed:\n${r.output.slice(0, 400)}`);
    }
  }

  if (needsTraderCbtc(msg)) {
    let treasuryFrom: string;
    try {
      treasuryFrom = treasuryParty();
    } catch {
      console.error("  auto-refill: treasury party unset — skip trader CBTC fund");
      treasuryFrom = "";
    }
    if (treasuryFrom) {
      console.warn(
        `  auto-refill: traders CBTC low → treasury fund ${TRADER_CBTC_EACH} CBTC each`
      );
      const r = runMainnetScript("scripts/farm/cli.mts", [
        "fund-traders-cbtc",
        "--i-understand-mainnet",
        `--cbtc=${TRADER_CBTC_EACH}`,
        `--from=${treasuryFrom}`
      ]);
      chunks.push(r.output);
      if (r.ok) {
        ran = true;
        traderCbtcEach = TRADER_CBTC_EACH;
        console.warn(`  auto-refill: trader CBTC fund ok`);
      } else {
        console.error(
          `  auto-refill: trader CBTC fund failed:\n${r.output.slice(0, 400)}`
        );
      }
    }
  }

  if (ran) lastRefillAt = Date.now();
  return {
    ran,
    vaultCbtc,
    traderCbtcEach,
    cacheRefreshNeeded,
    output: chunks.join("\n")
  };
}

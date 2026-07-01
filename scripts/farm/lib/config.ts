import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { NETWORK } from "../../../lib/constants";
import type { FarmFleetConfig } from "./types";

export const FLEET_FILE = ".farm-fleet.mainnet.json";
export const SWAP_LOG_FILE = "farm-swap.log";
export const PINGPONG_LOG_FILE = "farm-pingpong.log";
/** Default farm trader count when `--traders` is omitted on provision. */
export const DEFAULT_FARM_TRADER_COUNT = 5;
/** Default CC/CBTC funded per trader from treasury (warpx-mainnet-1). */
export const DEFAULT_FARM_CC_PER_TRADER = "120";
export const DEFAULT_FARM_CBTC_PER_TRADER = "0.0003";

export function assertMainnetNetwork(): void {
  if (NETWORK.name !== "mainnet") {
    throw new Error(
      `Farm toolkit is mainnet-only (NEXT_PUBLIC_NETWORK=${NETWORK.name})`
    );
  }
}

export function vaultParty(): string {
  const p =
    process.env.CANTON_SWAP_SETTLEMENT_PARTY?.trim() ||
    process.env.NEXT_PUBLIC_CANTON_SWAP_SETTLEMENT_PARTY?.trim() ||
    "";
  if (!p) throw new Error("Set CANTON_SWAP_SETTLEMENT_PARTY");
  return p;
}

export function treasuryParty(): string {
  const p =
    process.env.SOLVER_CANTON_PARTY?.trim() ||
    process.env.NEXT_PUBLIC_SOLVER_CANTON?.trim() ||
    "";
  if (!p) throw new Error("Set NEXT_PUBLIC_SOLVER_CANTON or SOLVER_CANTON_PARTY");
  return p;
}

export function farmDataDir(): string {
  const dir = process.env.FARM_DATA_DIR?.trim();
  return dir ? resolve(dir) : process.cwd();
}

export function fleetPath(cwd?: string): string {
  return resolve(cwd ?? farmDataDir(), FLEET_FILE);
}

export function swapLogPath(cwd?: string): string {
  return resolve(cwd ?? farmDataDir(), SWAP_LOG_FILE);
}

export function pingpongLogPath(cwd?: string): string {
  return resolve(cwd ?? farmDataDir(), PINGPONG_LOG_FILE);
}

/** Write fleet JSON from env when file is missing (Railway / CI). */
export function ensureFleetFile(cwd?: string): void {
  const path = fleetPath(cwd);
  if (existsSync(path)) return;

  const raw = process.env.FARM_FLEET_JSON?.trim();
  const b64 = process.env.FARM_FLEET_JSON_B64?.trim();
  let json = raw;
  if (!json && b64) {
    json = Buffer.from(b64, "base64").toString("utf8");
  }
  if (!json) {
    throw new Error(
      `Fleet file missing at ${path}. Run farm:provision locally or set FARM_FLEET_JSON / FARM_FLEET_JSON_B64.`
    );
  }

  const dir = resolve(path, "..");
  mkdirSync(dir, { recursive: true });
  const parsed = JSON.parse(json) as FarmFleetConfig;
  writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  console.log(`[farm] wrote fleet file from env → ${path}`);
}

export function loadFleet(cwd?: string): FarmFleetConfig {
  ensureFleetFile(cwd);
  const path = fleetPath(cwd);
  const fleet = JSON.parse(readFileSync(path, "utf8")) as FarmFleetConfig;
  if (fleet.network !== "mainnet") {
    throw new Error(`Fleet file must be mainnet (got ${fleet.network})`);
  }
  if (!fleet.vault || !fleet.treasury || !Array.isArray(fleet.traders)) {
    throw new Error("Invalid fleet file shape");
  }
  return fleet;
}

export function saveFleet(fleet: FarmFleetConfig, cwd?: string): void {
  const path = fleetPath(cwd);
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(fleet, null, 2)}\n`, "utf8");
}

export function traderParty(fleet: FarmFleetConfig, indexOrParty: string): string {
  const idx = Number(indexOrParty);
  if (Number.isInteger(idx) && idx >= 0 && idx < fleet.traders.length) {
    return fleet.traders[idx]!.party;
  }
  const hit = fleet.traders.find((t) => t.party === indexOrParty || t.hint === indexOrParty);
  if (hit) return hit.party;
  throw new Error(`Trader not in fleet: ${indexOrParty}`);
}

export function assertTraderAllowlisted(fleet: FarmFleetConfig, party: string): void {
  if (!fleet.traders.some((t) => t.party === party)) {
    throw new Error(`Trader not allowlisted: ${party.slice(0, 32)}…`);
  }
}

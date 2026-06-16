#!/usr/bin/env npx tsx
/**
 * Provision mainnet farm fleet: allocate traders, preapproval, fund, write fleet JSON.
 */
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

import { NETWORK } from "../../lib/constants";
import {
  assertMainnetNetwork,
  DEFAULT_FARM_CBTC_PER_TRADER,
  DEFAULT_FARM_CC_PER_TRADER,
  DEFAULT_FARM_TRADER_COUNT,
  saveFleet,
  treasuryParty,
  vaultParty
} from "./lib/config";
import type { FarmFleetConfig } from "./lib/types";
import { auditMainnetConfig, printAudit } from "./lib/mainnet-audit";
import { parseArg, parseNumberArg, parseFlag, requireMainnetGuard } from "./lib/parse-args";
import { getLedgerJwt } from "./lib/jwt";

/** Neutral hosted-party hint — no "farm" in the name. */
function newTraderPartyHint(): string {
  const id = randomUUID().replace(/-/g, "").slice(0, 12);
  return `oranj-user-${id}`;
}

async function ledgerUserId(jwt: string): Promise<string> {
  const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64").toString());
  return String(payload.sub);
}

async function allocateParty(jwt: string, hint: string): Promise<string> {
  const r = await fetch(`${NETWORK.ledgerHost}/v2/parties`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`
    },
    body: JSON.stringify({ partyIdHint: hint })
  });
  if (!r.ok) throw new Error(`allocate failed (${r.status}): ${await r.text()}`);
  const j = (await r.json()) as { partyDetails?: { party?: string } };
  const party = j.partyDetails?.party;
  if (!party) throw new Error("no party in allocate response");
  return party;
}

async function grantCanActAs(jwt: string, party: string): Promise<void> {
  const userId = await ledgerUserId(jwt);
  const r = await fetch(
    `${NETWORK.ledgerHost}/v2/users/${encodeURIComponent(userId)}/rights`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`
      },
      body: JSON.stringify({
        userId,
        rights: [{ kind: { CanActAs: { value: { party } } } }]
      })
    }
  );
  if (!r.ok) {
    const text = await r.text();
    if (!/already|exists/i.test(text)) {
      throw new Error(`grant CanActAs failed (${r.status}): ${text}`);
    }
  }
}

function runScript(script: string, party: string): void {
  const r = spawnSync("npx", ["tsx", script, party], {
    stdio: "inherit",
    cwd: process.cwd(),
    env: process.env
  });
  if (r.status !== 0) {
    throw new Error(`${script} failed for ${party.slice(0, 24)}…`);
  }
}

async function ccPreapproval(jwt: string, party: string): Promise<boolean> {
  const r = await fetch(
    `${NETWORK.validatorHost}/api/validator/v0/scan-proxy/transfer-preapprovals/by-party/${encodeURIComponent(party)}`,
    { headers: { Authorization: `Bearer ${jwt}` }, cache: "no-store" }
  );
  if (r.status === 404 || !r.ok) return false;
  const j = (await r.json().catch(() => null)) as { transfer_preapproval?: unknown } | null;
  return !!j?.transfer_preapproval;
}

async function fundFromTreasury(params: {
  cbtc: string;
  cc: string;
  destParty: string;
}): Promise<void> {
  const prevVault = process.env.CANTON_SWAP_SETTLEMENT_PARTY;
  process.env.CANTON_SWAP_SETTLEMENT_PARTY = params.destParty;
  const r = spawnSync(
    "npx",
    ["tsx", "scripts/fund-swap-vault.mts", `--cbtc=${params.cbtc}`, `--cc=${params.cc}`],
    { stdio: "inherit", cwd: process.cwd(), env: process.env }
  );
  if (prevVault) process.env.CANTON_SWAP_SETTLEMENT_PARTY = prevVault;
  else delete process.env.CANTON_SWAP_SETTLEMENT_PARTY;
  if (r.status !== 0) throw new Error(`fund transfer failed for ${params.destParty.slice(0, 24)}…`);
}

export async function runProvision(): Promise<void> {
  assertMainnetNetwork();
  requireMainnetGuard();

  const audit = auditMainnetConfig();
  printAudit(audit);
  if (!audit.ok) process.exit(1);

  const traderCount = parseNumberArg("traders", DEFAULT_FARM_TRADER_COUNT);
  const ccPerTrader = parseArg("cc", DEFAULT_FARM_CC_PER_TRADER)!;
  const cbtcPerTrader = parseArg("cbtc", DEFAULT_FARM_CBTC_PER_TRADER)!;
  const vaultCc = parseArg("vault-cc", "0")!;
  const vaultCbtc = parseArg("vault-cbtc", "0")!;
  const skipFund = parseFlag("skip-fund");
  const skipPreapproval = parseFlag("skip-preapproval");
  const fundVault = parseFlag("fund-vault");

  const vault = vaultParty();
  const treasury = treasuryParty();
  const jwt = await getLedgerJwt();

  if (await ccPreapproval(jwt, vault)) {
    throw new Error("Settlement vault must NOT have CC preapproval");
  }

  console.log(`\nTreasury (fund source): ${treasury}`);
  console.log(`Settlement vault:       ${vault}`);
  if (!skipFund) {
    console.log(
      `Per trader: ${ccPerTrader} CC + ${cbtcPerTrader} CBTC × ${traderCount} traders`
    );
    if (fundVault) {
      console.log(`Vault top-up: ${vaultCc} CC + ${vaultCbtc} CBTC`);
    } else {
      console.log("Vault top-up: skipped (fund separately with fund-swap-vault:mainnet)");
    }
  }

  console.log(`\nProvisioning ${traderCount} traders…`);
  const traders: FarmFleetConfig["traders"] = [];

  for (let i = 0; i < traderCount; i++) {
    const hint = newTraderPartyHint();
    console.log(`\n[${i + 1}/${traderCount}] ${hint}`);
    const party = await allocateParty(jwt, hint);
    await grantCanActAs(jwt, party);
    traders.push({ hint, party });
    console.log(`  party: ${party}`);

    // Fund before EnableCC — mainnet requires ≥2 CC on party before preapproval.
    if (!skipFund) {
      await fundFromTreasury({
        cbtc: cbtcPerTrader,
        cc: ccPerTrader,
        destParty: party
      });
    }

    if (!skipPreapproval) {
      runScript("scripts/enable-cc-party.mts", party);
      runScript("scripts/enable-cbtc-party.mts", party);
    }
  }

  if (!skipFund && fundVault) {
    console.log("\nFunding settlement vault from treasury…");
    await fundFromTreasury({
      cbtc: vaultCbtc,
      cc: vaultCc,
      destParty: vault
    });
  }

  const fleet: FarmFleetConfig = {
    network: "mainnet",
    createdAt: new Date().toISOString(),
    vault,
    treasury,
    traders
  };
  saveFleet(fleet);
  console.log(`\n✓ Fleet saved to .farm-fleet.mainnet.json (${traders.length} traders)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runProvision().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}

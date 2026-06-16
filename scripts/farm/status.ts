#!/usr/bin/env npx tsx
/**
 * Fleet status — balances, UTXO counts, preapproval flags.
 */
import { NETWORK } from "../../lib/constants";
import { assertMainnetNetwork, loadFleet } from "./lib/config";
import { partyBalancesSummary } from "./lib/float";
import { getLedgerJwt } from "./lib/jwt";

async function ccPreapproval(jwt: string, party: string): Promise<boolean> {
  const r = await fetch(
    `${NETWORK.validatorHost}/api/validator/v0/scan-proxy/transfer-preapprovals/by-party/${encodeURIComponent(party)}`,
    { headers: { Authorization: `Bearer ${jwt}` }, cache: "no-store" }
  );
  if (r.status === 404 || !r.ok) return false;
  const j = (await r.json().catch(() => null)) as { transfer_preapproval?: unknown } | null;
  return !!j?.transfer_preapproval;
}

export async function runStatus(): Promise<void> {
  assertMainnetNetwork();
  const fleet = loadFleet();
  const jwt = await getLedgerJwt();

  console.log(`Network: ${NETWORK.name}`);
  console.log(`Vault: ${fleet.vault}\n`);

  const vaultBal = await partyBalancesSummary(jwt, fleet.vault);
  const vaultCcPre = await ccPreapproval(jwt, fleet.vault);
  console.log("Vault:");
  console.log(`  CBTC: ${vaultBal.cbtc}  UTXO: ${vaultBal.utxoCbtc}`);
  console.log(`  CC:   ${vaultBal.cc}  UTXO: ${vaultBal.utxoCc}`);
  console.log(`  CC preapproval: ${vaultCcPre ? "YES (bad)" : "NO (good)"}\n`);

  for (const t of fleet.traders) {
    const bal = await partyBalancesSummary(jwt, t.party);
    const ccPre = await ccPreapproval(jwt, t.party);
    console.log(`${t.hint} (${t.party.slice(0, 28)}…)`);
    console.log(`  CBTC: ${bal.cbtc}  CC: ${bal.cc}`);
    console.log(
      `  UTXO cbtc/cc: ${bal.utxoCbtc}/${bal.utxoCc}  CC preapproval: ${ccPre ? "YES" : "NO"}`
    );
  }

  if (fleet.calibration?.bytesPerSwap) {
    console.log(
      `\nCalibration: ${fleet.calibration.bytesPerSwap} bytes/swap (${fleet.calibration.measuredAt})`
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runStatus().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}

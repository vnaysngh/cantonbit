#!/usr/bin/env npx tsx
/**
 * Merge token holdings (UTXO consolidate) via self-transfer — consumes all inputs, one output.
 *
 * Usage:
 *   npm run farm:consolidate:mainnet -- --i-understand-mainnet --asset=CBTC --trader=4
 *   npm run farm:consolidate:mainnet -- --i-understand-mainnet --asset=CBTC --min-utxo=3
 *   npm run farm:consolidate:mainnet -- --i-understand-mainnet --party=<party_id> --asset=CBTC
 */
import { assertMainnetNetwork, loadFleet, traderParty, vaultParty } from "./lib/config";
import { consolidatePartyAsset, type FarmAsset } from "./lib/consolidate";
import { getLedgerJwt } from "./lib/jwt";
import { parseArg, parseFlag, parseNumberArg, requireMainnetGuard } from "./lib/parse-args";

export async function runConsolidateTraderHoldings(): Promise<void> {
  assertMainnetNetwork();
  requireMainnetGuard();

  const asset = (parseArg("asset", "CBTC") ?? "CBTC").toUpperCase() as FarmAsset;
  if (asset !== "CBTC" && asset !== "CC") {
    throw new Error("--asset must be CBTC or CC");
  }
  const minUtxo = parseNumberArg("min-utxo", 3);
  const dryRun = parseFlag("dry-run");
  const partyOverride = parseArg("party");
  const traderFilter = parseArg("trader");
  const includeVault = parseFlag("vault");

  const fleet = loadFleet();
  const jwt = await getLedgerJwt();

  const targets: Array<{ label: string; party: string }> = [];
  if (partyOverride) {
    targets.push({ label: partyOverride.slice(0, 24), party: partyOverride });
  } else {
    const traders = traderFilter
      ? [{ hint: `trader-${traderFilter}`, party: traderParty(fleet, traderFilter) }]
      : fleet.traders;
    for (const t of traders) {
      targets.push({ label: t.hint, party: t.party });
    }
    if (includeVault) {
      targets.push({ label: "vault", party: vaultParty() });
    }
  }

  console.log(`Consolidate ${asset} (min ${minUtxo} UTXOs, ${targets.length} party/parties)\n`);

  let n = 0;
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]!;
    const did = await consolidatePartyAsset({
      jwt,
      party: t.party,
      label: t.label,
      asset,
      minUtxo,
      dryRun
    });
    if (did > 0) n += did;
  }

  console.log(`\n✓ Consolidate complete (${n} merge(s)${dryRun ? ", dry-run" : ""}).`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runConsolidateTraderHoldings().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}

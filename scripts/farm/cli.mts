#!/usr/bin/env npx tsx
/**
 * CBTC farm CLI — mainnet-only standalone toolkit.
 *
 *   provision | quote | swap | run | status | audit
 */
import { assertMainnetNetwork, loadFleet, traderParty } from "./lib/config";
import { executeSwap } from "./lib/execute-swap";
import { getLedgerJwt } from "./lib/jwt";
import { logSwapResult } from "./lib/log";
import { auditMainnetConfig, printAudit } from "./lib/mainnet-audit";
import { parseArg, requireMainnetGuard } from "./lib/parse-args";
import { quoteFarmSwap } from "./lib/quote";
import { runProvision } from "./provision";
import { runFarmBot } from "./run";
import { runStatus } from "./status";
import { runBurnAudit } from "./audit-burns";
import { runFundTradersCc } from "./fund-traders-cc";
import { runFundTradersCbtc } from "./fund-traders-cbtc";
import { runConsolidateTraderHoldings } from "./consolidate-trader-holdings";

const sub = process.argv[2]?.trim() ?? "help";

async function cmdQuote(): Promise<void> {
  assertMainnetNetwork();
  const from = (parseArg("from", "CBTC") ?? "CBTC") as "CBTC" | "CC";
  const to = (parseArg("to", "CC") ?? "CC") as "CBTC" | "CC";
  const amount = parseArg("amount") ?? parseArg("in");
  if (!amount) {
    console.error("Usage: farm quote --from=CBTC --to=CC --amount=0.001");
    process.exit(1);
  }
  const q = await quoteFarmSwap({ fromAsset: from, toAsset: to, inAmount: amount });
  console.log(JSON.stringify({ fromAsset: from, toAsset: to, inAmount: amount, ...q }, null, 2));
}

async function cmdSwap(): Promise<void> {
  assertMainnetNetwork();
  requireMainnetGuard();
  const fleet = loadFleet();
  const trader = parseArg("trader", "0")!;
  const from = (parseArg("from", "CBTC") ?? "CBTC") as "CBTC" | "CC";
  const to = (parseArg("to", "CC") ?? "CC") as "CBTC" | "CC";
  const inAmount = parseArg("in") ?? parseArg("amount");
  if (!inAmount) {
    console.error(
      "Usage: farm swap --trader=0 --from=CBTC --to=CC --in=0.000847 [--out=12.38]"
    );
    process.exit(1);
  }
  const jwt = await getLedgerJwt();
  const swapStart = Date.now();
  const result = await executeSwap({
    jwt,
    fleet,
    traderParty: traderParty(fleet, trader),
    fromAsset: from,
    toAsset: to,
    inAmount,
    outAmount: parseArg("out")
  });
  const swapDurationSec = Math.round(((Date.now() - swapStart) / 1000) * 10) / 10;
  logSwapResult(result, { swapDurationSec, sleepAfterSec: 0, wallIntervalSec: null });
  console.log(JSON.stringify({ ...result, swapDurationSec }, null, 2));
}

async function cmdAudit(): Promise<void> {
  const audit = auditMainnetConfig();
  printAudit(audit);
  if (!audit.ok) process.exit(1);
}

function cmdHelp(): void {
  console.log(`CBTC farm CLI (mainnet-only)

Usage:
  npx tsx scripts/farm/cli.mts <command> [flags]

Commands:
  audit       Validate mainnet env + constants
  provision   Allocate traders, preapproval, fund (--i-understand-mainnet)
  quote       Tradecraft quote (--from --to --amount)
  swap        One managed swap (--trader --from --to --in)
  run         Continuous bot (--i-understand-mainnet --bitsafe-eligible-confirmed)
  status      Fleet balances + UTXO
  fund-traders-cc   Send CC from vault to all traders (--cc --trader --dry-run)
  fund-traders-cbtc Send CBTC from vault to all traders (--cbtc --trader --dry-run)
  consolidate       Merge UTXOs via self-transfer (--asset --trader --min-utxo --vault)
  audit-burns Scan farm-swap.log for CC burn/fee choices

npm scripts (via with-env.sh mainnet):
  npm run farm:audit:mainnet
  npm run farm:provision:mainnet -- --i-understand-mainnet
  npm run farm:quote:mainnet -- --from=CBTC --to=CC --amount=0.001
  npm run farm:swap:mainnet -- --i-understand-mainnet --trader=0 --from=CBTC --to=CC --in=0.001
  npm run farm:run:mainnet -- --i-understand-mainnet --bitsafe-eligible-confirmed --dry-run --max-swaps=3
  npm run farm:status:mainnet
  npm run farm:fund-traders-cc:mainnet -- --i-understand-mainnet --dry-run
  npm run farm:fund-traders-cc:mainnet -- --i-understand-mainnet --cc=50
  npm run farm:fund-traders-cbtc:mainnet -- --i-understand-mainnet --cbtc=0.0002
  npm run farm:consolidate:mainnet -- --i-understand-mainnet --asset=CBTC --trader=4
`);
}

async function main(): Promise<void> {
  switch (sub) {
    case "audit":
      await cmdAudit();
      break;
    case "provision":
      await runProvision();
      break;
    case "quote":
      await cmdQuote();
      break;
    case "swap":
      await cmdSwap();
      break;
    case "run":
      await runFarmBot();
      break;
    case "status":
      await runStatus();
      break;
    case "fund-traders-cc":
      await runFundTradersCc();
      break;
    case "fund-traders-cbtc":
      await runFundTradersCbtc();
      break;
    case "consolidate":
      await runConsolidateTraderHoldings();
      break;
    case "audit-burns":
      await runBurnAudit();
      break;
    case "help":
    default:
      cmdHelp();
      if (sub !== "help") process.exit(1);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

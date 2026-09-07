#!/usr/bin/env npx tsx
/**
 * Ping-pong CBTC farm — traffic/volume generator that shuffles CBTC between the
 * fleet traders using cantonmixer's proven random-send algorithm.
 *
 * Ported from cantonmixer/src/transfer.js performRandomTransfers(): a
 * Fisher-Yates DERANGEMENT (no self-send) pairs every trader as exactly one
 * sender AND one receiver per cycle, so funds cycle and never drain — the
 * "traders always have funds" property, guaranteed by construction. Each leg
 * sends a random CBTC amount in [min,max]; legs run in small batches with
 * staggered delays to stay under the node's rate/traffic limits.
 *
 * Unlike cantonmixer (Loop SDK + per-wallet private key, client-signed), our
 * traders are node-hosted parties with NO private keys, so each leg goes through
 * the node actAs path: buildTransferExercise + submitLedgerCommands([trader]).
 * Traders have CBTC preapproval, so transfers settle DIRECTLY (no offer/accept).
 *
 * Usage:
 *   npm run farm:pingpong:mainnet -- --i-understand-mainnet --dry-run
 *   npm run farm:pingpong:mainnet -- --i-understand-mainnet --cycles=1
 *   npm run farm:pingpong:mainnet -- --i-understand-mainnet            # loop forever
 *   npm run farm:pingpong:mainnet -- --i-understand-mainnet --min=0.0000015 --max=0.000003 --interval=30
 */
import { fromBaseUnits, toBaseUnitsFloor } from "../../lib/amount-units";
import { CBTC_ASSET } from "../../lib/canton-assets";
import { consolidatePartyAsset } from "./lib/consolidate";
import { assertMainnetNetwork, loadFleet } from "./lib/config";
import { getLedgerJwt } from "./lib/jwt";
import {
  buildTransferExercise,
  cbtcBalance,
  holdingsForAsset,
  isDirectTransferKind,
  registrarForAsset,
  runWithLedgerReadSession,
  submitLedgerCommands
} from "./lib/ledger";
import { assertNodeVersion } from "./lib/node-guard";
import { logPingpongTransfer, readPingpongStats } from "./lib/pingpong-log";
import { TokenBucket } from "./lib/token-bucket";
import { isAuthError, isTrafficError, parseTrafficError } from "./lib/traffic-error";
import { parseArg, parseFlag, parseNumberArg, requireMainnetGuard } from "./lib/parse-args";
import { retry } from "./lib/retry";

// cantonmixer defaults (config.js transferAmountMin/Max): sub-satoshi-scale CBTC.
const DEFAULT_MIN = "0.0000015";
const DEFAULT_MAX = "0.000003";

// ── Traffic-bucket pacing (REAL measured numbers + live feedback) ─────────────
// Canton free tier (docs.sync.global/deployment/traffic.html baseRateTrafficLimits):
//   burstAmount = 400,000 bytes over burstWindow = 1200s  →  refill 333.3 B/s.
// Measured CBTC-transfer cost on THIS node (SEQUENCER errors, 2026-07-01 live run):
//   trafficCost = 8625 / 8630 / 8642 / 8849 → ~8700B/transfer typical.
// The free bucket is SHARED with other node activity (swap solver, etc.), so we
// (a) start the local mirror EMPTY (assume-drained), (b) budget only part of the
// refill, and (c) reset the mirror from the node's real baseTrafficRemainder each
// time a rejection tells us the truth. See the traffic-failure diagnosis.
const FREE_REFILL_BYTES_PER_SEC = 333.3;
const FREE_BURST_BYTES = 400_000;
// Start the runtime estimate at the fragmented worst case (9457) and converge
// DOWN toward observed (~8634) as real trafficCosts come in — never under-budget
// before we have data. --bytes-per-transfer overrides the starting estimate.
const DEFAULT_BYTES_PER_TRANSFER = 9457;
// Convergence bounds for the runtime byte estimate. Real measured cost on this
// node is ~8634 B/transfer (14.1MB/day ÷ 1633 tx/day, 2026-08-31..09-02). We let
// the estimate drift DOWN toward the observed mean via EWMA so a single fragmented
// worst-case sample cannot pin the gate high forever, but never below MIN (which
// would systematically under-budget and cause a rejection on every send).
const MIN_BYTES_PER_TRANSFER = 8600;
// EWMA weight applied to each newly observed real trafficCost.
const BYTES_EWMA_ALPHA = 0.25;
// Shared-bucket target. 0.95 drives the free bucket near its ceiling: the farm is
// the dominant consumer on this node, and the rejection path below re-syncs from
// the node's real baseTrafficRemainder, so overshoot self-corrects rather than
// wedging. Effective budget ≈317 B/s → ~1 transfer / 27s. Lower it if a co-tenant
// workload (swap solver) starts contending. Override with --utilization.
const TARGET_UTILIZATION = 0.95;
// Serial, per-transfer gating (NOT parallel batches): firing N transfers at once
// is an instantaneous N× overdraw against a bucket that sustains ~1 tx / minute.
const SERIAL_STAGGER_MS = 500; // tiny gap between serial sends for log readability
// Max consecutive traffic-refill backoffs on one transfer before we give up on it
// and move on (prevents an infinitely-stuck leg when the node is deeply starved).
const MAX_TRAFFIC_BACKOFFS = 4;
// Ping-pong fragments UTXOs (change + received per send), and fragmented inputs
// make transfers MORE expensive. Consolidate every N cycles toward ≤2 UTXOs — but
// ONLY when the bucket can afford it (gated), so we never dig the hole deeper.
const DEFAULT_CONSOLIDATE_EVERY = 2;
const CONSOLIDATE_MIN_UTXO = 2;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface Trader {
  hint: string;
  party: string;
}

/**
 * Fisher-Yates derangement: returns a permutation `recv` of indices [0..n-1]
 * with no fixed point (recv[i] !== i for all i), so nobody sends to themselves.
 * Ported verbatim in spirit from cantonmixer performRandomTransfers().
 */
function derangement(n: number): number[] {
  const recv = Array.from({ length: n }, (_, i) => i);
  let ok = false;
  while (!ok) {
    for (let i = recv.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [recv[i], recv[j]] = [recv[j]!, recv[i]!];
    }
    ok = true;
    for (let i = 0; i < n; i++) {
      if (recv[i] === i) {
        ok = false;
        break;
      }
    }
  }
  return recv;
}

/** Random CBTC amount in [min,max], 8-decimal precision (cantonmixer toFixed(8)). */
function randomAmount(minUnits: bigint, maxUnits: bigint): string {
  const span = maxUnits - minUnits;
  const roll = BigInt(Math.floor(Math.random() * Number(span + 1n)));
  return fromBaseUnits(minUnits + roll, CBTC_ASSET.decimals);
}

/** Execute one CBTC leg sender→receiver through the node actAs path. Pure submit:
 *  pacing + logging live in gatedSend/runCycle. Throws on failure (traffic or
 *  otherwise); the caller classifies the error. */
async function sendCbtc(params: {
  jwt: string;
  sender: Trader;
  receiver: Trader;
  amount: string;
  dryRun: boolean;
}): Promise<void> {
  const { jwt, sender, receiver, amount, dryRun } = params;
  if (dryRun) return;

  const reg = await registrarForAsset(jwt, "CBTC");
  const holdings = await holdingsForAsset(jwt, sender.party, "CBTC");
  if (holdings.length === 0) {
    throw new Error(`${sender.hint} has no CBTC holdings`);
  }

  const leg = await buildTransferExercise({
    jwt,
    senderParty: sender.party,
    receiverParty: receiver.party,
    amount,
    inputHoldings: holdings,
    instrumentId: reg.instrumentId,
    registrarAdmin: reg.admin,
    registryKind: reg.kind,
    assetSymbol: "CBTC",
    memo: "farm-pingpong"
  });

  if (!isDirectTransferKind(leg.transferKind)) {
    // Traders have CBTC preapproval, so this should never happen; if it does,
    // the receiver would have to accept — surface it rather than silently stall.
    throw new Error(
      `${sender.hint}→${receiver.hint}: expected direct transfer but got kind='${leg.transferKind}' (receiver preapproval missing?)`
    );
  }

  const cmdId = `farm-pingpong-${sender.party.slice(0, 12)}-${receiver.party.slice(0, 12)}-${Date.now()}`;
  await submitLedgerCommands({
    jwt,
    actAs: [sender.party],
    commands: [leg.command],
    disclosedContracts: leg.disclosedContracts,
    commandId: cmdId,
    synchronizerId: leg.synchronizerId,
    workflowId: cmdId
  });
}

/**
 * Live run state shared across all sends: the token-bucket mirror, the runtime
 * byte-cost estimate (calibrated from real SEQUENCER trafficCosts), and the
 * ledger JWT. The JWT lives here (mutable) so that when a transfer hits a 401
 * (m2m tokens expire ~8h) and we re-auth, the fresh token propagates to every
 * subsequent transfer, cycle, and consolidation without re-threading it.
 */
interface Pacing {
  bucket: TokenBucket;
  estBytes: number;
  utilization: number;
  jwt: string;
}

/**
 * Submit ONE transfer with traffic-aware pacing:
 *  1. wait until the local bucket can afford it (gate BEFORE the send);
 *  2. attempt it (network transients still use the fast retry() path);
 *  3. on success, spend the bucket;
 *  4. on a TRAFFIC rejection, reset the bucket from the node's real
 *     baseTrafficRemainder, bump the byte estimate from the real trafficCost,
 *     sleep one refill window, and retry — up to MAX_TRAFFIC_BACKOFFS times.
 * Returns whether the transfer ultimately succeeded.
 */
async function gatedSend(params: {
  sender: Trader;
  receiver: Trader;
  amount: string;
  dryRun: boolean;
  pacing: Pacing;
}): Promise<{ ok: boolean; error?: string }> {
  const { sender, receiver, amount, dryRun, pacing } = params;

  if (dryRun) {
    console.log(`  [dry-run] ${sender.hint} → ${receiver.hint}  ${amount} CBTC`);
    return { ok: true };
  }

  let authRetried = false;
  for (let backoff = 0; backoff <= MAX_TRAFFIC_BACKOFFS; backoff++) {
    // 1) Gate: wait for local bucket headroom for this transfer's estimated cost.
    const waitMs = pacing.bucket.waitMsFor(pacing.estBytes, Date.now());
    if (waitMs > 0) {
      console.log(`  ⏳ pacing: wait ${Math.round(waitMs / 1000)}s (bucket) before ${sender.hint}→${receiver.hint}`);
      await sleep(waitMs);
    }
    try {
      // 2) Attempt; network transients (not traffic) use the fast retry path.
      await retry(() => sendCbtc({ jwt: pacing.jwt, sender, receiver, amount, dryRun }), {
        retries: 3,
        baseMs: 1000,
        maxMs: 8000,
        label: `${sender.hint}→${receiver.hint}`
      });
      // 3) Success → charge the bucket.
      pacing.bucket.spend(pacing.estBytes, Date.now());
      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 4a) Expired/invalid JWT → re-auth ONCE and retry this same leg. The fresh
      // token lands in pacing.jwt so every later transfer uses it too. Does not
      // count against the traffic-backoff budget.
      if (isAuthError(e) && !authRetried) {
        authRetried = true;
        try {
          console.warn(`  🔑 JWT rejected (401) — refreshing token…`);
          pacing.jwt = await getLedgerJwt();
          console.warn(`  🔑 token refreshed; retrying ${sender.hint}→${receiver.hint}`);
        } catch (re) {
          return { ok: false, error: `JWT refresh failed: ${re instanceof Error ? re.message : re}` };
        }
        backoff--; // this attempt shouldn't consume a traffic-backoff slot
        continue;
      }
      if (!isTrafficError(e)) {
        return { ok: false, error: msg }; // genuine non-traffic failure
      }
      // 4b) Traffic rejection → learn the node's real numbers and back off.
      const parsed = parseTrafficError(e);
      // Track the node's REAL cost with an EWMA rather than a one-way Math.max
      // ratchet: a single fragmented sample used to pin estBytes at the worst case
      // permanently, over-waiting on every later gate. Clamped to
      // [MIN_BYTES_PER_TRANSFER, burst] so it can neither under-budget nor exceed
      // what one transfer could ever cost.
      if (parsed.trafficCost) {
        const blended =
          pacing.estBytes * (1 - BYTES_EWMA_ALPHA) + parsed.trafficCost * BYTES_EWMA_ALPHA;
        pacing.estBytes = Math.min(
          FREE_BURST_BYTES,
          Math.max(MIN_BYTES_PER_TRANSFER, Math.ceil(blended))
        );
      }
      if (parsed.baseTrafficRemainder !== null) {
        pacing.bucket.reset(parsed.baseTrafficRemainder, Date.now());
      } else {
        pacing.bucket.reset(0, Date.now()); // unknown → assume empty
      }
      if (backoff === MAX_TRAFFIC_BACKOFFS) {
        return { ok: false, error: `traffic-starved after ${MAX_TRAFFIC_BACKOFFS} backoffs: ${msg.slice(0, 80)}` };
      }
      // Wait for the (now node-synced) bucket to accrue this transfer's cost.
      const w = Math.max(1000, pacing.bucket.waitMsFor(pacing.estBytes, Date.now()));
      console.log(
        `  ⏳ traffic backoff ${backoff + 1}/${MAX_TRAFFIC_BACKOFFS}: node bucket=${parsed.baseTrafficRemainder ?? "?"}B, ` +
          `cost=${parsed.trafficCost ?? "?"}B → wait ${Math.round(w / 1000)}s`
      );
      await sleep(w);
    }
  }
  return { ok: false, error: "unreachable" };
}

/** One cycle: derangement-paired CBTC sends, SERIAL with per-transfer pacing.
 *  The JWT is carried in `pacing` (mutable) so a 401 re-auth mid-cycle sticks. */
async function runCycle(params: {
  traders: Trader[];
  minUnits: bigint;
  maxUnits: bigint;
  dryRun: boolean;
  cycle: number;
  pacing: Pacing;
}): Promise<{ ok: number; fail: number }> {
  const { traders, minUnits, maxUnits, dryRun, cycle, pacing } = params;
  const n = traders.length;
  const recv = derangement(n);
  console.log(`Cycle: ${n} derangement-paired CBTC sends (serial, no self-sends)`);

  let ok = 0;
  let fail = 0;
  for (let i = 0; i < n; i++) {
    const sender = traders[i]!;
    const receiver = traders[recv[i]!]!;
    const amount = randomAmount(minUnits, maxUnits);
    const r = await gatedSend({ sender, receiver, amount, dryRun, pacing });
    if (!dryRun) {
      logPingpongTransfer({ cycle, from: sender.hint, to: receiver.hint, amount, ok: r.ok, error: r.error });
    }
    if (r.ok) {
      ok++;
      console.log(`  ✓ ${sender.hint} → ${receiver.hint}  ${amount} CBTC`);
    } else {
      fail++;
      console.error(`  ✗ ${sender.hint}→${receiver.hint}: ${r.error}`);
    }
    if (i < n - 1) await sleep(SERIAL_STAGGER_MS);
  }
  console.log(`Cycle done: ${ok}/${n} ok, ${fail} failed\n`);
  return { ok, fail };
}

/**
 * Merge each trader's CBTC UTXOs back down to one, undoing the per-cycle
 * fragmentation. Each trader self-transfers its own holdings (actAs the trader),
 * so no cross-party accept is needed. Skips traders below CONSOLIDATE_MIN_UTXO.
 * Each merge is a real submission, so we GATE it through the shared bucket first
 * (one transfer's worth of credit) and spend on success — otherwise consolidation
 * would silently overdraw the bucket that the transfers just paced.
 */
async function consolidateTraders(params: {
  traders: Trader[];
  dryRun: boolean;
  pacing: Pacing;
}): Promise<void> {
  const { traders, dryRun, pacing } = params;
  console.log(`Consolidating trader CBTC UTXOs (minUtxo=${CONSOLIDATE_MIN_UTXO})…`);
  for (const t of traders) {
    if (!dryRun) {
      const waitMs = pacing.bucket.waitMsFor(pacing.estBytes, Date.now());
      if (waitMs > 0) {
        console.log(`  ⏳ pacing: wait ${Math.round(waitMs / 1000)}s before merging ${t.hint}`);
        await sleep(waitMs);
      }
    }
    try {
      const merged = await runWithLedgerReadSession(pacing.jwt, () =>
        consolidatePartyAsset({
          jwt: pacing.jwt,
          party: t.party,
          label: t.hint,
          asset: "CBTC",
          minUtxo: CONSOLIDATE_MIN_UTXO,
          dryRun,
          maxRounds: 10
        })
      );
      if (merged > 0 && !dryRun) pacing.bucket.spend(pacing.estBytes * merged, Date.now());
      if (merged > 0) console.log(`  ✓ ${t.hint}: ${merged} merge round(s)`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isAuthError(e)) {
        // Expired token mid-consolidation → re-auth so later merges + cycles work.
        try {
          pacing.jwt = await getLedgerJwt();
          console.warn(`  🔑 token refreshed during consolidation`);
        } catch {
          console.warn(`  consolidate skipped for ${t.hint}: JWT refresh failed`);
        }
      } else if (isTrafficError(e)) {
        const parsed = parseTrafficError(e);
        if (parsed.baseTrafficRemainder !== null) pacing.bucket.reset(parsed.baseTrafficRemainder, Date.now());
        console.warn(`  consolidate deferred for ${t.hint} (traffic) — bucket recovering`);
      } else {
        console.warn(`  consolidate skipped for ${t.hint}: ${msg.slice(0, 120)}`);
      }
    }
    await sleep(1500);
  }
  console.log("");
}

export async function runPingPong(): Promise<void> {
  assertNodeVersion();
  assertMainnetNetwork();
  requireMainnetGuard();

  const dryRun = parseFlag("dry-run");
  const cycles = parseNumberArg("cycles", 0); // 0 = loop forever
  const consolidateEvery = parseNumberArg("consolidate-every", DEFAULT_CONSOLIDATE_EVERY);
  const bytesPerTransfer = parseNumberArg("bytes-per-transfer", DEFAULT_BYTES_PER_TRANSFER);
  const forceFast = parseFlag("force-fast");
  const minStr = parseArg("min", DEFAULT_MIN)!;
  const maxStr = parseArg("max", DEFAULT_MAX)!;
  const minUnits = toBaseUnitsFloor(minStr, CBTC_ASSET.decimals);
  const maxUnits = toBaseUnitsFloor(maxStr, CBTC_ASSET.decimals);
  if (maxUnits < minUnits) throw new Error("--max must be >= --min");

  const fleet = loadFleet();
  const traders: Trader[] = fleet.traders.map((t) => ({ hint: t.hint, party: t.party }));
  if (traders.length < 2) throw new Error("need >= 2 traders for ping-pong");

  const utilization = parseNumberArg("utilization", TARGET_UTILIZATION);

  // Token-bucket pacing that MIRRORS the shared Canton free bucket. Critically it
  // starts EMPTY (startFull=false): the bucket is shared with other node activity
  // and observed near-empty, so we pace conservatively from transfer #1 and only
  // speed up after refill has actually accrued headroom. Live rejections reset the
  // mirror to the node's real level (see gatedSend). --force-fast disables gating.
  const bucket = new TokenBucket(
    {
      burstBytes: FREE_BURST_BYTES,
      refillBytesPerSec: FREE_REFILL_BYTES_PER_SEC,
      targetUtilization: utilization
    },
    Date.now(),
    forceFast // startFull only when the user explicitly forces fast (spike mode)
  );
  const perTransferSec = Math.round(bytesPerTransfer / (FREE_REFILL_BYTES_PER_SEC * utilization));

  const pacing: Pacing = {
    bucket,
    estBytes: bytesPerTransfer,
    utilization,
    jwt: await getLedgerJwt()
  };

  console.log(`Ping-pong farm — network=${process.env.NEXT_PUBLIC_NETWORK ?? "mainnet"} dryRun=${dryRun}`);
  console.log(`Traders: ${traders.length} (${traders.map((t) => t.hint).join(", ")})`);
  console.log(`Amount:  random [${minStr}, ${maxStr}] CBTC per leg`);
  console.log(
    `Traffic: ~${bytesPerTransfer}B/transfer, free refill ${FREE_REFILL_BYTES_PER_SEC}B/s, util ${utilization}`
  );
  console.log(
    `Pacing:  SERIAL, per-transfer bucket-gated — ~${perTransferSec}s/transfer sustained` +
      (forceFast ? " (--force-fast: gating OFF, will overdraw)" : " (starts empty, self-calibrates from rejections)")
  );
  console.log(`Consolidate: every ${consolidateEvery} cycle(s), down to ${CONSOLIDATE_MIN_UTXO} UTXO (0 = never)\n`);

  // Show starting balances (skip in dry-run to avoid noise).
  if (!dryRun) {
    for (const t of traders) {
      const bal = await cbtcBalance(pacing.jwt, t.party).catch(() => "?");
      console.log(`  ${t.hint}: ${bal} CBTC`);
    }
    console.log("");
  }

  let cycle = 0;
  let totalOk = 0;
  let totalFail = 0;
  while (cycles === 0 || cycle < cycles) {
    cycle++;
    console.log(`──── Cycle ${cycle}${cycles ? `/${cycles}` : ""} ────`);
    let cycleFail = 0;
    try {
      const { ok, fail } = await runCycle({ traders, minUnits, maxUnits, dryRun, cycle, pacing });
      totalOk += ok;
      totalFail += fail;
      cycleFail = fail;
      if (!dryRun) {
        const stats = readPingpongStats();
        console.log(
          `  running total (all runs): ${stats.ok} transfers, ${stats.totalCbtcMoved} CBTC moved`
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`  cycle error: ${msg.slice(0, 200)}`);
      if (isAuthError(e)) {
        console.warn("  refreshing JWT…");
        pacing.jwt = await getLedgerJwt();
      }
    }

    // Consolidate toward ≤2 UTXOs — but SKIP entirely if this cycle already hit
    // traffic starvation (fails > 0). Consolidating a starved node just fails and
    // fragments UTXOs further; better to let the bucket recover. The merges route
    // through the SAME per-transfer gate so they can't overdraw either.
    const didConsolidate = consolidateEvery > 0 && cycle % consolidateEvery === 0 && cycleFail === 0;
    if (didConsolidate) {
      await consolidateTraders({ traders, dryRun, pacing });
    } else if (consolidateEvery > 0 && cycle % consolidateEvery === 0 && cycleFail > 0) {
      console.log(`  (skipping consolidation — ${cycleFail} traffic failure(s) this cycle; letting bucket recover)`);
    }
  }

  console.log(`\n✓ Ping-pong complete: ${cycle} cycle(s), ${totalOk} ok, ${totalFail} failed.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runPingPong().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}

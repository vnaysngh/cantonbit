/**
 * MAKE-OR-BREAK PROBE (R1 Shape B) — does an executor-fired, STANDARD
 * Allocation_ExecuteTransfer confirm when the RECEIVER is on ANOTHER participant
 * (a Loop party)?
 *
 * This is the ONE unproven thing Shape B (fully-trustless Loop swap) rests on.
 * It deliberately uses ZERO custom DAR — only the standard Splice Allocation
 * primitives (allocate + Allocation_ExecuteTransfer), so it isolates the registry's
 * authority model from our HtlcLock. If this confirms, our executor (our node) can
 * release cBTC to a cross-participant Loop receiver → Shape B is possible.
 *
 * Why this matters: lib/htlc-onledger.ts claims the executor fires alone, but
 * swap-solver/src/canton.ts says we "verified live" the cBTC DvpLegAllocation needs
 * the RECEIVER to co-authorize (DAML_AUTHORIZATION_ERROR otherwise). Every prior
 * "proven" run used a receiver our JWT controls (self-swap / local CanActAs), so it
 * never tested cross-participant. This resolves the contradiction.
 *
 *   PASS = ExecuteTransfer confirms with the Loop receiver → Shape B works.
 *   FAIL = DAML_AUTHORIZATION_ERROR (receiver co-auth needed, can't for x-participant)
 *          → Shape B impossible; the standard transfer-accept flow is required.
 *   SAFETY: on ANY failure after the lock, Allocation_Withdraw recovers the cBTC.
 *
 * Reuses the SAME env the solver already uses — no new secrets, nothing printed.
 * Run:
 *   npx tsx --env-file=.env --env-file=../.env.local src/probe-xparticipant-execute.mts
 */
import { CantonClient } from "./canton.js";

function reqEnv(k: string): string { const v = process.env[k]; if (!v) throw new Error(`missing env ${k}`); return v; }

const LEDGER = reqEnv("CANTON_LEDGER_HOST");
const REGISTRY = reqEnv("CANTON_REGISTRY_URL");
const ADMIN = reqEnv("CANTON_ADMIN_PARTY");
const SOLVER = reqEnv("SOLVER_CANTON_PARTY");
const TOKEN_URL = reqEnv("KEYCLOAK_TOKEN_URL");
// The solver party is on warpx DEVNET, so we MUST use the devnet m2m client/secret.
// .env.local's plain KEYCLOAK_CLIENT_ID is the MAINNET one — prefer the _DEVNET pair
// (falls back to swap-solver/.env's devnet default), matching lib/auth.ts's logic.
const CLIENT_ID = process.env.KEYCLOAK_CLIENT_ID_DEVNET ?? "validator-devnet-m2m";
const SECRET = reqEnv("KEYCLOAK_CLIENT_SECRET_DEVNET");
const SCOPE = process.env.KEYCLOAK_SCOPE ?? "daml_ledger_api";

// The cross-participant receiver — the devnet Loop party (on Loop's participant).
const LOOP_RECEIVER =
  process.env.RECEIVER ??
  "8f5ca108eb208e8826f868952ede00a5::12200fe103931833a6cb6f080dff41df997dbb9abd8d06384e6405434a04efcf8e2b";

const AMOUNT = process.env.AMOUNT ?? "0.0001";
const WINDOW_MS = 10 * 60 * 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`\n=== X-PARTICIPANT EXECUTE PROBE — ${AMOUNT} cBTC ===`);
  console.log(`executor/sender (us): ${SOLVER.slice(0, 30)}…`);
  console.log(`receiver (Loop, x-participant): ${LOOP_RECEIVER.slice(0, 30)}…\n`);

  const canton = new CantonClient(
    { ledgerHost: LEDGER, registryUrl: REGISTRY, decentralizedPartyId: ADMIN, instrumentId: { admin: ADMIN, id: "CBTC" }, solverParty: SOLVER },
    { tokenUrl: TOKEN_URL, clientId: CLIENT_ID, clientSecret: SECRET, scope: SCOPE },
  );

  const float0 = await canton.getFloatSats();
  console.log(`[0] float: ${Number(float0) / 1e8} cBTC`);
  if (float0 < 10000n) throw new Error("need >= 0.0001 cBTC float");

  // 1. Lock via a STANDARD Allocation: sender=executor=us, receiver=Loop party.
  const holdings = await canton.getHoldings(SOLVER);
  const now = Date.now();
  console.log(`[1] allocating ${AMOUNT} cBTC (executor=sender=us, receiver=Loop)…`);
  const { allocationCid } = await canton.allocate({
    receiverParty: LOOP_RECEIVER, amountBtc: AMOUNT, inputHoldings: holdings,
    settlementId: `xpart-probe-${now}`,
    allocateBefore: new Date(now + WINDOW_MS / 2),
    settleBefore: new Date(now + WINDOW_MS),
  });
  console.log(`    ✓ Allocation: ${allocationCid.slice(0, 24)}…`);

  let done = false;
  try {
    // 2. THE DECISIVE STEP — fire the STANDARD Allocation_ExecuteTransfer as the
    //    executor ALONE (no receiver co-auth; we can't act for a x-participant party).
    console.log(`[2] Allocation_ExecuteTransfer as executor ALONE — THE TEST…`);
    const { updateId } = await canton.executeAllocation(allocationCid); // no receiverParty → executor-only
    done = true;
    console.log(`\n    ✅✅ PASS — executor-fired ExecuteTransfer CONFIRMED to a x-participant Loop receiver.`);
    console.log(`    update ${updateId.slice(0, 20)}… → Shape B (fully-trustless Loop swap) is POSSIBLE.`);
    await sleep(2000);
    const float1 = await canton.getFloatSats();
    console.log(`[3] float after: ${Number(float1) / 1e8} cBTC (down by ${AMOUNT} → cBTC left to Loop).`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`\n    ❌ FAIL at ExecuteTransfer: ${msg}`);
    if (/AUTHORIZATION/i.test(msg)) {
      console.error(`    → DAML_AUTHORIZATION_ERROR: the registry DEMANDS receiver co-auth.`);
      console.error(`    → For a x-participant Loop receiver we CAN'T provide it → Shape B IMPOSSIBLE.`);
      console.error(`    → The standard transfer-accept flow (Loop user accepts) would be required.`);
    }
  } finally {
    if (!done) {
      console.error(`\n[safety] Allocation_Withdraw to recover the locked cBTC…`);
      try { const { updateId } = await canton.withdrawAllocation(allocationCid); console.error(`[safety] ✓ recovered (${updateId.slice(0, 16)}…).`); }
      catch (e) { console.error(`[safety] ✗ withdraw FAILED — MANUAL RECOVERY for ${allocationCid}: ${e instanceof Error ? e.message : e}`); }
    }
  }
  console.log(`\n=== PROBE DONE ===`);
}

main().catch((e) => { console.error("\n[probe] FATAL:", e instanceof Error ? e.message : e); process.exit(1); });

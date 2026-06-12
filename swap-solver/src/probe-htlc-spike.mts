/**
 * T1 SPIKE — the make-or-break test: does our custom HtlcLock template drive a
 * REAL CBTC Allocation release on the WarpX node?
 *
 * Flow (SELF-SWAP: solver = locker = receiver = executor, all LOCAL party):
 *   1. read solver CBTC holdings
 *   2. allocate() — lock `amount` CBTC, executor=solver, receiver=solver,
 *      settleBefore = now + WINDOW. (Pre-delegates execute authority to executor.)
 *   3. create HtlcLock on-ledger wrapping that allocationCid (hashLock, unlockTime)
 *   4. fetch the execute-transfer choice-context from the registry
 *   5. exercise HtlcLock.Claim(preimage, ctx) as solver →
 *        our Daml checks keccak256(preimage)==hashLock, then exercises
 *        Allocation_ExecuteTransfer.
 *   PASS  = Claim succeeds, CBTC moved (self → self, net-zero). Mechanism PROVEN.
 *   FAIL  = capture the error (esp. DAML_AUTHORIZATION_ERROR) — tells us exactly
 *           what authority the registry still demands.
 *   SAFETY: on ANY failure after the lock, attempt Allocation_Withdraw so the
 *           CBTC is never stuck.
 *
 * Run:
 *   CC_SECRET=... npx tsx --env-file=.env --env-file=../.env.local src/probe-htlc-spike.mts
 */
import { randomUUID } from "node:crypto";
import { CantonClient } from "./canton.js";

const PKG = "df826e7cfc7476ca32d8dc06f79bce65401ff45feaa411c80e6f833f02dab652"; // cbtc-htlc v0.1.1 (receiver no longer observer)
const HTLC_TID = `${PKG}:CbtcHtlc:HtlcLock`;
const ALLOCATION_INTERFACE =
  "#splice-api-token-allocation-v1:Splice.Api.Token.AllocationV1:Allocation";

const LEDGER = reqEnv("CANTON_LEDGER_HOST");
const REGISTRY = reqEnv("CANTON_REGISTRY_URL");
const ADMIN = reqEnv("CANTON_ADMIN_PARTY");
const SOLVER = reqEnv("SOLVER_CANTON_PARTY");
const TOKEN_URL = reqEnv("KEYCLOAK_TOKEN_URL");
const SCOPE = process.env.KEYCLOAK_SCOPE ?? "daml_ledger_api";
const SECRET = reqEnv("CC_SECRET"); // pass via CC_SECRET=... (don't commit)

const AMOUNT = process.env.AMOUNT ?? "0.001";
const WINDOW_MS = 10 * 60 * 1000;
// Receiver: override via RECEIVER=..., else self-swap (SOLVER).
const RECEIVER = process.env.RECEIVER ?? SOLVER;

// Canonical secret (raw bytes → hex). keccak256(hex) on Daml == keccak256(raw) on EVM.
const PREIMAGE_HEX =
  "7468652d63726f73732d636861696e2d7365637265742d333262797465732121";
const HASHLOCK =
  "94277b389401042e35f8709846050797955e2b321bee500555c2fbdc2f4e9903"; // keccak256 of it

function reqEnv(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJwt(): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: "validator-devnet-m2m",
    client_secret: SECRET,
    scope: SCOPE
  });
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!r.ok) throw new Error(`token failed ${r.status}: ${await r.text()}`);
  return ((await r.json()) as { access_token: string }).access_token;
}

async function submit(
  jwt: string,
  commands: unknown[],
  disclosed: unknown[] = []
): Promise<any> {
  const commandId = randomUUID();
  const r = await fetch(
    `${LEDGER}/v2/commands/submit-and-wait-for-transaction-tree`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`
      },
      body: JSON.stringify({
        applicationId: "cbtc-htlc-spike",
        workflowId: `spike-${commandId}`,
        commandId,
        actAs: [SOLVER],
        readAs: [SOLVER],
        commands,
        disclosedContracts: disclosed
      })
    }
  );
  const text = await r.text();
  if (!r.ok) throw new Error(`submit failed (${r.status}): ${text}`);
  return JSON.parse(text);
}

async function allocChoiceContext(
  jwt: string,
  allocationCid: string,
  kind: string
) {
  const url = `${REGISTRY}/api/token-standard/v0/registrars/${ADMIN}/registry/allocations/v1/${encodeURIComponent(allocationCid)}/choice-contexts/${kind}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ meta: {} })
  });
  if (!r.ok)
    throw new Error(
      `choice-context ${kind} failed (${r.status}): ${await r.text()}`
    );
  const ctx = (await r.json()) as {
    choiceContextData: unknown;
    disclosedContracts: any[];
  };
  return {
    data: ctx.choiceContextData,
    disclosed: (ctx.disclosedContracts ?? []).map((d) => ({
      ...d,
      synchronizerId: d.synchronizerId ?? ""
    }))
  };
}

async function main() {
  console.log(
    `\n=== T1 SPIKE (self-swap) — ${AMOUNT} CBTC, hashLock ${HASHLOCK.slice(0, 12)}… ===`
  );
  console.log(`solver/locker/receiver/executor: ${SOLVER.slice(0, 30)}…\n`);

  const canton = new CantonClient(
    {
      ledgerHost: LEDGER,
      registryUrl: REGISTRY,
      decentralizedPartyId: ADMIN,
      instrumentId: { admin: ADMIN, id: "CBTC" },
      solverParty: SOLVER
    },
    {
      tokenUrl: TOKEN_URL,
      clientId: "validator-devnet-m2m",
      clientSecret: SECRET,
      scope: SCOPE
    }
  );

  const float0 = await canton.getFloatSats();
  console.log(`[0] float: ${Number(float0) / 1e8} CBTC`);
  if (float0 < 100000n) throw new Error("need >= 0.001 CBTC float");

  // 1+2. lock via Allocation (executor=solver, receiver=solver)
  const holdings = await canton.getHoldings(SOLVER);
  const now = Date.now();
  console.log(`[1] allocating ${AMOUNT} CBTC (executor=receiver=solver)…`);
  const { allocationCid } = await canton.allocate({
    receiverParty: RECEIVER,
    amountBtc: AMOUNT,
    inputHoldings: holdings,
    settlementId: `htlc-spike-${now}`,
    allocateBefore: new Date(now + WINDOW_MS / 2),
    settleBefore: new Date(now + WINDOW_MS)
  });
  console.log(`    ✓ Allocation: ${allocationCid.slice(0, 24)}…`);

  let done = false;
  const jwt = await getJwt();
  try {
    // 3. create HtlcLock wrapping the allocation. unlockTime <= settleBefore.
    const unlockTime = new Date(now + WINDOW_MS - 60_000).toISOString(); // settleBefore - 1min
    console.log(`[2] creating HtlcLock (unlockTime=${unlockTime})…`);
    const createRes = await submit(jwt, [
      {
        CreateCommand: {
          templateId: HTLC_TID,
          createArguments: {
            locker: SOLVER,
            receiver: RECEIVER,
            executor: SOLVER,
            allocationCid,
            hashLock: HASHLOCK,
            unlockTime
          }
        }
      }
    ]);
    const htlcCid = findCreated(createRes, HTLC_TID);
    console.log(`    ✓ HtlcLock: ${htlcCid.slice(0, 24)}…`);

    // 4. fetch execute-transfer choice-context
    console.log(`[3] fetching execute-transfer choice-context…`);
    const ctx = await allocChoiceContext(
      jwt,
      allocationCid,
      "execute-transfer"
    );

    // 5. THE DECISIVE EXERCISE — Claim with the preimage → fires Allocation_ExecuteTransfer
    console.log(
      `[4] exercising HtlcLock.Claim(preimage) as solver — THE TEST…`
    );
    await submit(
      jwt,
      [
        {
          ExerciseCommand: {
            templateId: HTLC_TID,
            contractId: htlcCid,
            choice: "Claim",
            choiceArgument: {
              preimage: PREIMAGE_HEX,
              allocationContext: { context: ctx.data, meta: { values: {} } }
            }
          }
        }
      ],
      ctx.disclosed
    );
    done = true;
    console.log(
      `\n    ✅✅ CLAIM SUCCEEDED — Allocation_ExecuteTransfer fired via our HtlcLock.`
    );
    console.log(
      `    The custom Daml HTLC drives a real CBTC release. MECHANISM PROVEN.`
    );

    await sleep(2000);
    const float1 = await canton.getFloatSats();
    console.log(
      `[5] float after: ${Number(float1) / 1e8} CBTC (self-swap → net-zero expected)`
    );
  } catch (e) {
    console.error(
      `\n    ❌ FAILED at the decisive step: ${e instanceof Error ? e.message : e}`
    );
    console.error(
      `    (If DAML_AUTHORIZATION_ERROR → the registry still demands receiver/other auth.)`
    );
  } finally {
    if (!done) {
      console.error(
        `\n[safety] attempting Allocation_Withdraw to recover the locked CBTC…`
      );
      try {
        const { updateId } = await canton.withdrawAllocation(allocationCid);
        console.error(
          `[safety] ✓ withdrawn (${updateId.slice(0, 16)}…) — CBTC recovered.`
        );
      } catch (e) {
        console.error(
          `[safety] ✗ withdraw FAILED — MANUAL RECOVERY for ${allocationCid}: ${e instanceof Error ? e.message : e}`
        );
      }
    }
  }
  console.log(`\n=== SPIKE DONE ===`);
}

function findCreated(txTreeRes: any, templateSuffix: string): string {
  const events = txTreeRes?.transactionTree?.eventsById ?? {};
  for (const ev of Object.values(events) as any[]) {
    const c = ev?.CreatedTreeEvent?.value;
    if (c?.contractId && (c.templateId ?? "").includes("HtlcLock"))
      return c.contractId;
  }
  // fallback: any created contract
  for (const ev of Object.values(events) as any[]) {
    const c = ev?.CreatedTreeEvent?.value;
    if (c?.contractId) return c.contractId;
  }
  throw new Error("no HtlcLock created in tx tree");
}

main().catch((e) => {
  console.error("\n[spike] FATAL:", e instanceof Error ? e.message : e);
  process.exit(1);
});

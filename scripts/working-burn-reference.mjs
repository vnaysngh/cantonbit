/**
 * working-burn-reference.mjs
 *
 * REFERENCE COPY of the manual burn that succeeded end-to-end on mainnet
 * (party 008937fb, 0.00002 cBTC, btcTxId 1cae9818…fbc0 — confirmed on Bitcoin).
 *
 * Kept verbatim so the UI redeem path can be diffed against a known-good burn,
 * byte for byte. This script:
 *   1. gets a JWT from Authentik (client_credentials, scope daml_ledger_api)
 *   2. lists the party's unlocked Holding contracts
 *   3. creates a FRESH 43a8452a CBTCWithdrawAccount
 *   4. re-reads that account's templateId + createdEventBlob from ACS as a pair
 *   5. exercises CBTCWithdrawAccount_Withdraw { tokens, amount }, actAs [user]
 *
 * It does NOT call findExistingWithdrawAccount (the UI does) — it always
 * creates fresh. It reads templateId+blob from the SAME ACS row (no hardcoded
 * package fallback).
 *
 * Usage:
 *   node scripts/working-burn-reference.mjs            # dry-run: print the request bodies, DO NOT submit
 *   node scripts/working-burn-reference.mjs --execute  # actually run the burn (destroys cBTC)
 *
 * Configure the target party + BTC address below.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "fs";

const EXECUTE = process.argv.includes("--execute");

const ENV_PATH = "/Users/vinaysingh/Desktop/cantonops/cantonbit/.env.local";
const env = Object.fromEntries(
  readFileSync(ENV_PATH, "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const LEDGER = "https://ledger-api.validator.warpx.fivenorth.io";
const COORD = "https://api.mainnet.bitsafe.finance";
const USER =
  "cbtc-user-008937fb-8b38-4791-a9e9-b4ebc19c4429::1220517bfd86ef5732610705a35b7b2d56e36112550d6a2b778971dbd099a3d36e99";
const BTC = "bc1qqz7grzuntqn5p7cmslmrrag9edux30vaxt4ftg";

// --- AUTH (identical to lib/auth.ts: client_credentials, scope daml_ledger_api) ---
const tok = await (
  await fetch(env.KEYCLOAK_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.KEYCLOAK_CLIENT_ID,
      client_secret: env.KEYCLOAK_CLIENT_SECRET,
      scope: env.KEYCLOAK_SCOPE ?? "daml_ledger_api",
    }),
  })
).json();
const jwt = tok.access_token;
console.log("[auth] token_url:", env.KEYCLOAK_TOKEN_URL);
console.log("[auth] client_id:", env.KEYCLOAK_CLIENT_ID);
console.log("[auth] scope:", env.KEYCLOAK_SCOPE ?? "daml_ledger_api");
console.log("[auth] jwt length:", jwt?.length);

const submit = async (b) => {
  const r = await fetch(
    `${LEDGER}/v2/commands/submit-and-wait-for-transaction-tree`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
        Connection: "close",
      },
      body: JSON.stringify(b),
    },
  );
  const t = await r.text();
  let j;
  try {
    j = JSON.parse(t);
  } catch {
    j = t;
  }
  return { status: r.status, body: j };
};
const lend = async () =>
  (
    await (
      await fetch(`${LEDGER}/v2/state/ledger-end`, {
        headers: { Authorization: `Bearer ${jwt}` },
      })
    ).json()
  ).offset;

// 1. gather user holdings (unlocked) + total
let off = await lend();
const acs = await (
  await fetch(`${LEDGER}/v2/state/active-contracts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
      Connection: "close",
    },
    body: JSON.stringify({
      filter: {
        filtersByParty: {
          [USER]: {
            cumulative: [
              {
                identifierFilter: {
                  WildcardFilter: { value: { includeCreatedEventBlob: false } },
                },
              },
            ],
          },
        },
      },
      verbose: true,
      activeAtOffset: off,
    }),
  })
).json();
const tokens = [];
let totalSats = 0;
for (const i of Array.isArray(acs) ? acs : []) {
  const ev = i.contractEntry?.JsActiveContract?.createdEvent;
  if (!ev) continue;
  if (
    ev.templateId.includes("Holding.V0.Holding:Holding") &&
    !ev.createArgument?.lock
  ) {
    tokens.push(ev.contractId);
    totalSats += Math.round(Number(ev.createArgument?.amount) * 1e8);
  }
}
const amount = (totalSats / 1e8).toFixed(10);
console.log("\nholdings to burn:", tokens.length, " total:", amount, "cBTC");
if (tokens.length === 0) {
  console.log("nothing to burn");
  process.exit(0);
}

// 2. create a FRESH 43a8452a withdraw account (current package)
// The coordinator's account-contract-rules endpoint can intermittently 500.
// Retry a few times and surface the raw error instead of crashing on bad JSON.
async function getRules() {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(`${COORD}/cbtc/v1/account-contract-rules`, {
      headers: { "Content-Type": "application/json" },
    });
    const text = await res.text();
    if (res.status === 200 && text.trim().startsWith("{")) {
      return JSON.parse(text);
    }
    console.log(
      `[coordinator] attempt ${attempt}/5 failed: HTTP ${res.status} body=${text.slice(0, 120) || "<empty>"} — retrying in 3s`,
    );
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("coordinator account-contract-rules unavailable after 5 attempts");
}
const rules = await getRules();
const wa = rules.wa_rules;
console.log("\n[coordinator] wa_rules.template_id:", wa.template_id);

const createBody = {
  applicationId: "cbtc-app",
  workflowId: `user-burn-wa-${randomUUID()}`,
  commandId: randomUUID(),
  actAs: [USER],
  readAs: [USER],
  commands: [
    {
      ExerciseCommand: {
        templateId: wa.template_id,
        contractId: wa.contract_id,
        choice: "CBTCWithdrawAccountRules_CreateWithdrawAccount",
        choiceArgument: { owner: USER, destinationBtcAddress: BTC },
      },
    },
  ],
  disclosedContracts: [
    {
      templateId: wa.template_id,
      contractId: wa.contract_id,
      createdEventBlob: wa.created_event_blob,
      synchronizerId: "",
    },
  ],
};

// NOTE: dry-run still CREATES the withdraw account (a harmless ledger write —
// it touches no holdings, moves no funds), exactly like the UI does, so we get
// a REAL templateId + blob to build the burn body from. Only the final burn
// submit (step 4) is gated on --execute. Funds never leave in dry-run.
console.log(`\n=== mode: ${EXECUTE ? "EXECUTE (will burn)" : "DRY RUN (no burn — funds untouched)"} ===`);

let r = await submit(createBody);
console.log("\ncreate WA status:", r.status);
if (r.status !== 200) {
  console.log(JSON.stringify(r.body).slice(0, 400));
  process.exit(1);
}
let waCid;
for (const e of Object.values(r.body?.transactionTree?.eventsById ?? {})) {
  const c = e.CreatedTreeEvent?.value ?? e.CreatedEvent;
  if (
    c?.templateId?.includes("CBTCWithdrawAccount") &&
    !c.templateId.includes("Rules")
  ) {
    waCid = c.contractId;
    break;
  }
}

// 3. fetch its blob + tpl from ACS — SAME ROW, consistent pair
off = await lend();
const acs2 = await (
  await fetch(`${LEDGER}/v2/state/active-contracts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
      Connection: "close",
    },
    body: JSON.stringify({
      filter: {
        filtersByParty: {
          [USER]: {
            cumulative: [
              {
                identifierFilter: {
                  TemplateFilter: {
                    value: {
                      templateId: "#cbtc:CBTC.WithdrawAccount:CBTCWithdrawAccount",
                      includeCreatedEventBlob: true,
                    },
                  },
                },
              },
            ],
          },
        },
      },
      verbose: true,
      activeAtOffset: off,
    }),
  })
).json();
let waBlob, waTpl;
for (const i of Array.isArray(acs2) ? acs2 : []) {
  const ev = i.contractEntry?.JsActiveContract?.createdEvent;
  if (ev?.contractId === waCid) {
    waBlob = ev.createdEventBlob;
    waTpl = ev.templateId;
  }
}
console.log(
  "WA cid:",
  waCid?.slice(0, 20),
  "pkg:",
  waTpl?.slice(0, 16),
  "blob:",
  waBlob?.length,
);

// 4. burn ALL holdings with minimal arg { tokens, amount }, actAs [user]
console.log("\n=== burning", amount, "cBTC (", tokens.length, "tokens ) ===");
const burnBody = {
  applicationId: "cbtc-app",
  workflowId: `user-burn-${randomUUID()}`,
  commandId: randomUUID(),
  actAs: [USER],
  readAs: [USER],
  commands: [
    {
      ExerciseCommand: {
        templateId: waTpl,
        contractId: waCid,
        choice: "CBTCWithdrawAccount_Withdraw",
        choiceArgument: { tokens, amount },
      },
    },
  ],
  disclosedContracts: [
    {
      templateId: waTpl,
      contractId: waCid,
      createdEventBlob: waBlob,
      synchronizerId: "",
    },
  ],
};

// ── BURN DIFF LOG (mirror of the UI route's log) ──
console.log("\n[script] ===== BURN DIFF LOG =====");
console.log("[script] actAs=" + JSON.stringify([USER]));
console.log("[script] readAs=" + JSON.stringify([USER]));
console.log("[script] applicationId=cbtc-app");
console.log("[script] choice=CBTCWithdrawAccount_Withdraw");
console.log("[script] withdrawAccount.templateId=" + waTpl);
console.log("[script] withdrawAccount.package=" + (waTpl || "").split(":")[0]);
console.log("[script] withdrawAccount.contractId=" + waCid);
console.log("[script] withdrawAccount.createdEventBlob.length=" + (waBlob || "").length);
console.log("[script] withdrawAccount.createdEventBlob.head=" + (waBlob || "").slice(0, 40));
console.log("[script] choiceArgument.amount=" + amount);
console.log("[script] choiceArgument.tokens=" + JSON.stringify(tokens));
console.log("[script] ledgerHost=" + LEDGER);
console.log("[script] jwt.length=" + jwt.length);
console.log("[script] FULL burn body=" + JSON.stringify(burnBody));
console.log("[script] =========================");

// Always write the burn body to disk for byte-level comparison with the UI.
const { writeFile } = await import("node:fs/promises");
await writeFile(
  "/tmp/script-burn-body.json",
  JSON.stringify(
    {
      source: "scripts/working-burn-reference.mjs",
      capturedAt: new Date().toISOString(),
      withdrawAccountPackage: (waTpl || "").split(":")[0],
      body: burnBody,
    },
    null,
    2,
  ),
);
console.log("[script] burn body written to /tmp/script-burn-body.json");

if (!EXECUTE) {
  console.log("\n[script] DRY RUN — burn NOT submitted. Funds untouched.");
  process.exit(0);
}

r = await submit(burnBody);
console.log("BURN status:", r.status);
console.log("BURN updateId:", r.body?.transactionTree?.updateId);
console.log("BURN offset:", r.body?.transactionTree?.offset);

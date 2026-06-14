#!/usr/bin/env npx tsx
/**
 * Run EnableCC (TransferPreapproval) for a hosted Canton party — no browser session.
 *
 * Usage:
 *   npm run enable-cc:devnet -- <party-id>
 *   PARTY_ID=party-… npm run enable-cc:devnet
 */
import { randomUUID } from "node:crypto";

import { MIN_CC_TO_ENABLE, NETWORK } from "../lib/constants";

const party = process.argv[2]?.trim() || process.env.PARTY_ID?.trim();
if (!party) {
  console.error("Usage: enable-cc-party.mts <party-id>");
  console.error("   or: PARTY_ID=party-… npm run enable-cc:devnet");
  process.exit(1);
}

async function getLedgerJwt(): Promise<string> {
  const tokenUrl = process.env.KEYCLOAK_TOKEN_URL;
  const scope = process.env.KEYCLOAK_SCOPE ?? "daml_ledger_api";
  const isDevnet = process.env.NEXT_PUBLIC_NETWORK?.toLowerCase() === "devnet";
  const clientId = isDevnet
    ? process.env.KEYCLOAK_CLIENT_ID_DEVNET || process.env.KEYCLOAK_CLIENT_ID
    : process.env.KEYCLOAK_CLIENT_ID;
  const clientSecret = isDevnet
    ? process.env.KEYCLOAK_CLIENT_SECRET_DEVNET || process.env.KEYCLOAK_CLIENT_SECRET
    : process.env.KEYCLOAK_CLIENT_SECRET;
  if (!tokenUrl || !clientId || !clientSecret) {
    throw new Error("Missing KEYCLOAK_* env vars for ledger JWT");
  }
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      scope
    })
  });
  if (!res.ok) {
    throw new Error(`JWT fetch failed (${res.status}): ${await res.text()}`);
  }
  const j = (await res.json()) as { access_token: string };
  return j.access_token;
}

function validatorUrl(path: string): string {
  return `${NETWORK.validatorHost}/api/validator${path}`;
}

async function hasCcEnabled(jwt: string, p: string): Promise<boolean> {
  const r = await fetch(
    validatorUrl(
      `/v0/scan-proxy/transfer-preapprovals/by-party/${encodeURIComponent(p)}`
    ),
    { headers: { Authorization: `Bearer ${jwt}` }, cache: "no-store" }
  );
  if (r.status === 404) return false;
  if (!r.ok) return false;
  const j = (await r.json().catch(() => null)) as {
    transfer_preapproval?: unknown;
  } | null;
  return !!j?.transfer_preapproval;
}

async function getAmuletBalance(jwt: string, p: string): Promise<string> {
  // Prefer validator wallet API (Splice external-party balance).
  const r = await fetch(
    validatorUrl(
      `/v0/admin/external-party/balance?party_id=${encodeURIComponent(p)}`
    ),
    { headers: { Authorization: `Bearer ${jwt}` }, cache: "no-store" }
  );
  if (r.ok) {
    const j = (await r.json()) as { balance?: string; total?: string };
    const bal = j.balance ?? j.total;
    if (bal != null) return bal;
  }
  return "unknown";
}

async function findPendingSetupProposal(
  jwt: string,
  p: string
): Promise<string | null> {
  const r = await fetch(validatorUrl("/v0/admin/external-party/setup-proposal"), {
    headers: { Authorization: `Bearer ${jwt}` },
    cache: "no-store"
  });
  if (!r.ok) return null;
  const j = (await r.json()) as {
    contracts?: { contract?: { contract_id?: string; payload?: { user?: string } } }[];
  };
  for (const row of j.contracts ?? []) {
    const cid = row.contract?.contract_id;
    const user = row.contract?.payload?.user;
    if (cid && user === p) return cid;
  }
  return null;
}

async function acceptSetupProposal(
  jwt: string,
  p: string,
  proposalCid: string
): Promise<void> {
  const res = await fetch(
    `${NETWORK.ledgerHost}/v2/commands/submit-and-wait-for-transaction-tree`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`
      },
      cache: "no-store",
      body: JSON.stringify({
        applicationId: "cbtc-app",
        commandId: randomUUID(),
        workflowId: `enable-cc-${randomUUID()}`,
        actAs: [p],
        readAs: [p],
        commands: [
          {
            ExerciseCommand: {
              templateId:
                "#splice-amulet:Splice.AmuletRules:ExternalPartySetupProposal",
              contractId: proposalCid,
              choice: "ExternalPartySetupProposal_Accept",
              choiceArgument: {}
            }
          }
        ]
      })
    }
  );
  if (!res.ok) {
    throw new Error(
      `EnableCC accept failed (${res.status}): ${await res.text()}`
    );
  }
}

async function enableCcForParty(jwt: string, p: string): Promise<void> {
  if (await hasCcEnabled(jwt, p)) {
    console.log("CC already enabled");
    return;
  }

  let proposalCid = await findPendingSetupProposal(jwt, p);
  if (!proposalCid) {
    const createRes = await fetch(
      validatorUrl("/v0/admin/external-party/setup-proposal"),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ user_party_id: p })
      }
    );
    if (!createRes.ok) {
      proposalCid = await findPendingSetupProposal(jwt, p);
      if (!proposalCid) {
        throw new Error(
          `setup-proposal failed (${createRes.status}): ${await createRes.text()}`
        );
      }
    } else {
      const j = (await createRes.json()) as { contract_id?: string };
      proposalCid = j.contract_id ?? null;
      if (!proposalCid) {
        throw new Error("setup-proposal returned no contract_id");
      }
      console.log(`Created setup proposal ${proposalCid.slice(0, 20)}…`);
    }
  }

  await acceptSetupProposal(jwt, p, proposalCid);
  console.log("Accepted setup proposal — waiting for TransferPreapproval…");
  for (let i = 0; i < 15; i++) {
    if (await hasCcEnabled(jwt, p)) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

console.log(`=== Enable CC (${NETWORK.name}) ===\n`);
console.log(`Party: ${party.slice(0, 40)}…\n`);

const jwt = await getLedgerJwt();
const ccTotal = await getAmuletBalance(jwt, party);
const ccNum = parseFloat(ccTotal);
const ccReady =
  ccTotal === "unknown" ||
  (Number.isFinite(ccNum) &&
    (ccNum >= MIN_CC_TO_ENABLE || NETWORK.name === "devnet"));
const ccEnabledBefore = await hasCcEnabled(jwt, party);

console.log("Before:", {
  ccTotal,
  ccMinToEnable: MIN_CC_TO_ENABLE,
  ccReadyForEnable: ccReady,
  ccEnabled: ccEnabledBefore
});

if (!ccReady) {
  console.error(`\nNeed at least ${MIN_CC_TO_ENABLE} CC on party before EnableCC.`);
  process.exit(1);
}

if (!ccEnabledBefore) {
  console.log("\nRunning EnableCC…");
  await enableCcForParty(jwt, party);
}

const ccEnabledAfter = await hasCcEnabled(jwt, party);
console.log("\nAfter:", { ccTotal, ccEnabled: ccEnabledAfter });

if (!ccEnabledAfter) {
  console.error("\nEnableCC finished but TransferPreapproval not visible yet.");
  process.exit(1);
}

console.log("\n✓ Enable CC complete.");

#!/usr/bin/env npx tsx
/**
 * Allocate Loop C2C settlement receiver party on WarpX + grant m2m CanActAs.
 * Does NOT enable CBTC/CC TransferPreapproval (offer-only path).
 *
 * Usage:
 *   npm run provision-settlement:devnet
 *   npm run provision-settlement:devnet -- oranj-settle-devnet
 */
import { NETWORK } from "../lib/constants";

const hint =
  process.argv[2]?.trim() ||
  process.env.SETTLEMENT_PARTY_HINT?.trim() ||
  "oranj-settle-devnet";

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
  return ((await res.json()) as { access_token: string }).access_token;
}

function ledger(path: string): string {
  return `${NETWORK.ledgerHost}${path}`;
}

async function ledgerUserId(jwt: string): Promise<string> {
  const payload = JSON.parse(
    Buffer.from(jwt.split(".")[1], "base64").toString()
  );
  return String(payload.sub);
}

async function allocateParty(jwt: string, partyIdHint: string): Promise<string> {
  const r = await fetch(ledger("/v2/parties"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`
    },
    body: JSON.stringify({ partyIdHint })
  });
  if (!r.ok) {
    throw new Error(`allocate party failed (${r.status}): ${await r.text()}`);
  }
  const j = (await r.json()) as { partyDetails?: { party?: string } };
  const party = j.partyDetails?.party;
  if (!party) throw new Error("allocate party: no party in response");
  return party;
}

async function grantCanActAs(jwt: string, party: string): Promise<void> {
  const userId = await ledgerUserId(jwt);
  const r = await fetch(ledger(`/v2/users/${encodeURIComponent(userId)}/rights`), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`
    },
    body: JSON.stringify({
      userId,
      rights: [{ kind: { CanActAs: { value: { party } } } }]
    })
  });
  if (!r.ok) {
    const text = await r.text();
    if (!/already|exists/i.test(text)) {
      throw new Error(`grant CanActAs failed (${r.status}): ${text}`);
    }
  }
}

async function ccPreapproval(jwt: string, party: string): Promise<boolean> {
  const r = await fetch(
    `${NETWORK.validatorHost}/api/validator/v0/scan-proxy/transfer-preapprovals/by-party/${encodeURIComponent(party)}`,
    { headers: { Authorization: `Bearer ${jwt}` }, cache: "no-store" }
  );
  if (r.status === 404 || !r.ok) return false;
  const body = (await r.json().catch(() => null)) as {
    transfer_preapproval?: unknown;
  } | null;
  return !!body?.transfer_preapproval;
}

async function cbtcTransferKind(receiver: string): Promise<string> {
  const admin = NETWORK.decentralizedPartyId;
  const now = new Date().toISOString();
  const body = {
    choiceArguments: {
      expectedAdmin: admin,
      transfer: {
        sender: "dummy-sender::1220",
        receiver,
        amount: "0.001",
        instrumentId: NETWORK.instrumentId,
        lock: null,
        requestedAt: now,
        executeBefore: new Date(Date.now() + 600_000).toISOString(),
        inputHoldingCids: [],
        meta: { values: {} }
      },
      extraArgs: { context: { values: {} }, meta: { values: {} } }
    }
  };
  const r = await fetch(
    `${NETWORK.registryUrl}/api/token-standard/v0/registrars/${admin}/registry/transfer-instruction/v1/transfer-factory`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }
  );
  if (!r.ok) return `ERROR ${r.status}`;
  return ((await r.json()) as { transferKind?: string }).transferKind ?? "?";
}

async function main(): Promise<void> {
  console.log(`Network: ${NETWORK.name}`);
  console.log(`Ledger: ${NETWORK.ledgerHost}`);
  console.log(`Allocating settlement party (hint=${hint})…\n`);

  const jwt = await getLedgerJwt();
  const party = await allocateParty(jwt, hint);
  await grantCanActAs(jwt, party);

  const cc = await ccPreapproval(jwt, party);
  const cbtcKind = await cbtcTransferKind(party);

  console.log("Settlement party provisioned:\n");
  console.log(`  Party ID: ${party}`);
  console.log(`  CanActAs: granted for m2m ledger user`);
  console.log(`  CC TransferPreapproval: ${cc ? "YES (unexpected)" : "NO"}`);
  console.log(`  CBTC transferKind preview (dummy sender→receiver): ${cbtcKind}`);
  console.log(`\nAdd to .env.${NETWORK.name}:`);
  console.log(`  CANTON_SWAP_SETTLEMENT_PARTY=${party}`);
  if (cbtcKind === "direct") {
    console.warn(
      "\n⚠️  transferKind is direct — settlement party may have CBTC preapproval. Do not enable preapproval on this party."
    );
  } else if (cbtcKind === "offer") {
    console.log("\n✓ CBTC path previews as offer — ready for Loop C2C swaps.");
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

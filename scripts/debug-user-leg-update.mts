/** Debug user-leg confirm: fetch update tree + solver ACS offers. Read-only. */
import "dotenv/config";

import { extractEventsByIdFromSubmitResult } from "../lib/mint-processor-logic";
import { parseUserLegEvidenceFromEvents } from "../lib/canton-swap-leg-verify-logic";
import { readTransferInstructionPayload } from "../lib/transfer-instruction-read";
import { NETWORK } from "../lib/constants";

const HOST = NETWORK.ledgerHost;
const USER =
  process.argv[3] ??
  "8f5ca108eb208e8826f868952ede00a5::12200fe103931833a6cb6f080dff41df997dbb9abd8d06384e6405434a04efcf8e2b";
const SOLVER = process.env.HTLC_SOLVER_CANTON_PARTY ?? "";
const updateId =
  process.argv[2] ??
  "1220568575d9483485a9472b2f662f7563df0b0a977e0d1c93235a276eaa0f962102";
const inAmount = process.argv[4] ?? "0.001";

async function jwt(): Promise<string> {
  const isDevnet = process.env.NEXT_PUBLIC_NETWORK?.toLowerCase() === "devnet";
  const clientId = isDevnet
    ? process.env.KEYCLOAK_CLIENT_ID_DEVNET || process.env.KEYCLOAK_CLIENT_ID
    : process.env.KEYCLOAK_CLIENT_ID;
  const clientSecret = isDevnet
    ? process.env.KEYCLOAK_CLIENT_SECRET_DEVNET || process.env.KEYCLOAK_CLIENT_SECRET
    : process.env.KEYCLOAK_CLIENT_SECRET;
  const b = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId!,
    client_secret: clientSecret!,
    scope: process.env.KEYCLOAK_SCOPE ?? "daml_ledger_api"
  });
  const r = await fetch(process.env.KEYCLOAK_TOKEN_URL!, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: b
  });
  return ((await r.json()) as { access_token: string }).access_token;
}

const TRANSFER_IFACE =
  "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction";

async function listTransferOffers(partyId: string, token: string) {
  const end = (
    await (
      await fetch(`${HOST}/v2/state/ledger-end`, {
        headers: { Authorization: `Bearer ${token}` }
      })
    ).json()
  ) as { offset: number };
  const res = await fetch(`${HOST}/v2/state/active-contracts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      filter: {
        filtersByParty: {
          [partyId]: {
            cumulative: [
              {
                identifierFilter: {
                  InterfaceFilter: {
                    value: {
                      interfaceId: TRANSFER_IFACE,
                      includeCreatedEventBlob: false,
                      includeInterfaceView: true
                    }
                  }
                }
              }
            ]
          }
        }
      },
      verbose: false,
      activeAtOffset: end.offset
    })
  });
  const raw = (await res.json()) as unknown[];
  const out: Array<{
    contractId: string;
    sender: string;
    receiver: string;
    amount: string;
  }> = [];
  for (const e of raw) {
    const ev = (
      e as {
        contractEntry?: { JsActiveContract?: { createdEvent?: unknown } };
      }
    ).contractEntry?.JsActiveContract?.createdEvent;
    if (!ev) continue;
    const payload = readTransferInstructionPayload(
      ev as Parameters<typeof readTransferInstructionPayload>[0]
    );
    if (!payload || payload.receiver !== partyId) continue;
    out.push({
      contractId: (ev as { contractId: string }).contractId,
      sender: payload.sender,
      receiver: payload.receiver,
      amount: payload.amount
    });
  }
  return out;
}

async function main() {
  const token = await jwt();
  console.log("solver env", SOLVER.slice(0, 40), "...");
  console.log("user", USER.slice(0, 40), "...");

  const url = `${HOST}/v2/updates/update/${encodeURIComponent(updateId)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  console.log("\nGET update", res.status, url.slice(-20));
  if (!res.ok) {
    console.log(await res.text());
  } else {
    const data = await res.json();
    console.log("top keys", Object.keys(data as object));
    const events = extractEventsByIdFromSubmitResult(data);
    console.log("event count", events ? Object.keys(events).length : 0);
    if (events) {
      for (const [k, v] of Object.entries(events)) {
        const c =
          (v as { CreatedTreeEvent?: { value?: Record<string, unknown> } })
            ?.CreatedTreeEvent?.value ??
          (v as { CreatedEvent?: Record<string, unknown> })?.CreatedEvent;
        if (!c?.templateId) continue;
        const tid = String(c.templateId);
        if (!tid.includes("TransferInstruction") && !tid.includes("Holding")) {
          continue;
        }
        const payload = readTransferInstructionPayload(
          c as Parameters<typeof readTransferInstructionPayload>[0]
        );
        console.log(
          " event",
          k,
          tid.slice(-40),
          payload
            ? `${payload.sender.slice(0, 20)}→${payload.receiver.slice(0, 20)} amt=${payload.amount}`
            : "(no payload)"
        );
      }
    }
    const evidence = parseUserLegEvidenceFromEvents(events, {
      userParty: USER,
      solverParty: SOLVER,
      inAmount,
      fromAsset: "CBTC",
      expectedInstrument: NETWORK.instrumentId
    });
    console.log("parse evidence", evidence);
  }

  if (SOLVER) {
    const offers = await listTransferOffers(SOLVER, token);
    console.log("\nsolver incoming offers", offers.length);
    for (const o of offers) {
      const match =
        o.sender === USER &&
        o.receiver === SOLVER &&
        o.amount.startsWith("0.001");
      console.log(
        match ? " *" : " ",
        o.contractId.slice(0, 24),
        o.sender.slice(0, 24),
        "→",
        o.receiver.slice(0, 24),
        o.amount
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

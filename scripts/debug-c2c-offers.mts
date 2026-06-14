/**
 * Debug: list TransferInstructions visible to solver on devnet ACS.
 * Run: npx tsx --env-file=.env.local --env-file=.env.devnet scripts/debug-c2c-offers.mts
 */
const HOST =
  process.env.NEXT_PUBLIC_LEDGER_HOST ??
  "https://ledger-api.validator.devnet.warpx.fivenorth.io";

async function jwt(): Promise<string> {
  const b = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.KEYCLOAK_CLIENT_ID!,
    client_secret:
      process.env.KEYCLOAK_CLIENT_SECRET_DEVNET ??
      process.env.KEYCLOAK_CLIENT_SECRET!,
    scope: process.env.KEYCLOAK_SCOPE ?? "daml_ledger_api"
  });
  const r = await fetch(process.env.KEYCLOAK_TOKEN_URL!, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: b
  });
  return ((await r.json()) as { access_token: string }).access_token;
}

function readTransfer(ev: {
  createArgument?: { transfer?: Record<string, unknown> };
  interfaceViews?: Array<{ viewValue?: unknown; viewStatus?: { code?: number } }>;
}): Record<string, unknown> | null {
  const arg = ev.createArgument?.transfer;
  if (arg?.receiver) return arg;
  for (const v of ev.interfaceViews ?? []) {
    if (v.viewStatus?.code) continue;
    const vv = v.viewValue as { transfer?: Record<string, unknown> } | undefined;
    if (vv?.transfer?.receiver) return vv.transfer;
    if ((vv as Record<string, unknown> | undefined)?.receiver) {
      return vv as Record<string, unknown>;
    }
  }
  return null;
}

async function main() {
  const solver =
    process.env.SOLVER_CANTON_PARTY ??
    process.env.NEXT_PUBLIC_SOLVER_CANTON ??
    "";
  if (!solver) throw new Error("SOLVER_CANTON_PARTY / NEXT_PUBLIC_SOLVER_CANTON missing");

  console.log("ledger", HOST);
  console.log("solver", solver);

  const t = await jwt();
  const end = (await (
    await fetch(`${HOST}/v2/state/ledger-end`, {
      headers: { Authorization: `Bearer ${t}` }
    })
  ).json()) as { offset: number };

  const iface =
    "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction";
  const acsRes = await fetch(`${HOST}/v2/state/active-contracts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${t}`
    },
    body: JSON.stringify({
      filter: {
        filtersByParty: {
          [solver]: {
            cumulative: [
              {
                identifierFilter: {
                  InterfaceFilter: {
                    value: {
                      interfaceId: iface,
                      includeInterfaceView: true,
                      includeCreatedEventBlob: false
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
  console.log("ACS status", acsRes.status);
  const raw = (await acsRes.json()) as unknown[];
  const items = Array.isArray(raw) ? raw : [];
  console.log("raw ACS entries", items.length);

  let matched = 0;
  for (const item of items) {
    const ev =
      (item as { contractEntry?: { JsActiveContract?: { createdEvent?: unknown } } })
        ?.contractEntry?.JsActiveContract?.createdEvent ??
      (item as { JsActiveContract?: { createdEvent?: unknown } })?.JsActiveContract
        ?.createdEvent;
    if (!ev || typeof ev !== "object") continue;
    const e = ev as {
      contractId?: string;
      createArgument?: { transfer?: Record<string, unknown> };
      interfaceViews?: Array<{ viewValue?: unknown; viewStatus?: { code?: number } }>;
    };
    const tr = readTransfer(e);
    if (!tr || tr.receiver !== solver) continue;
    matched++;
    console.log(
      JSON.stringify({
        cid: e.contractId?.slice(0, 24),
        sender: String(tr.sender).slice(0, 40),
        amount: tr.amount,
        instrument: tr.instrumentId
      })
    );
  }
  console.log("incoming offers to solver", matched);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

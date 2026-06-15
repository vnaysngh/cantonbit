#!/usr/bin/env npx tsx
/**
 * Read-only CBTC + CC balances for a WarpX-hosted party (settlement, solver, etc.).
 * Standalone — does not import server-only lib modules.
 *
 * Usage:
 *   npm run party-balances:devnet
 *   npm run party-balances:devnet -- oranj-settle-devnet::1220…
 *   PARTY_ID=warpx-devnet-1::1220… npm run party-balances:devnet
 *
 * Defaults to CANTON_SWAP_SETTLEMENT_PARTY, then NEXT_PUBLIC_SOLVER_CANTON.
 */
import { fromBaseUnits, toBaseUnitsFloor } from "../lib/amount-units";
import { NETWORK } from "../lib/constants";
import { CantonClient } from "../swap-solver/src/canton.js";

const party =
  process.argv[2]?.trim() ||
  process.env.PARTY_ID?.trim() ||
  process.env.CANTON_SWAP_SETTLEMENT_PARTY?.trim() ||
  process.env.NEXT_PUBLIC_CANTON_SWAP_SETTLEMENT_PARTY?.trim() ||
  process.env.SOLVER_CANTON_PARTY?.trim() ||
  process.env.NEXT_PUBLIC_SOLVER_CANTON?.trim() ||
  "";

if (!party) {
  console.error(
    "Usage: party-swap-balances.mts <party-id>\n" +
      "   or set CANTON_SWAP_SETTLEMENT_PARTY / PARTY_ID in env"
  );
  process.exit(1);
}

const CBTC_DECIMALS = 8;
const CC_DECIMALS = 10;

function authEnv() {
  const isDevnet = process.env.NEXT_PUBLIC_NETWORK?.toLowerCase() === "devnet";
  const tokenUrl = process.env.KEYCLOAK_TOKEN_URL;
  const clientId = isDevnet
    ? process.env.KEYCLOAK_CLIENT_ID_DEVNET || process.env.KEYCLOAK_CLIENT_ID
    : process.env.KEYCLOAK_CLIENT_ID;
  const clientSecret = isDevnet
    ? process.env.KEYCLOAK_CLIENT_SECRET_DEVNET || process.env.KEYCLOAK_CLIENT_SECRET
    : process.env.KEYCLOAK_CLIENT_SECRET;
  const scope = process.env.KEYCLOAK_SCOPE ?? "daml_ledger_api";
  if (!tokenUrl || !clientId || !clientSecret) {
    throw new Error("Missing KEYCLOAK_* env vars");
  }
  return { tokenUrl, clientId, clientSecret, scope };
}

function validatorUrl(path: string): string {
  return `${NETWORK.validatorHost}/api/validator${path}`;
}

const HOLDING_INTERFACE =
  "#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding";

async function ccBalanceFromLedger(jwt: string, p: string): Promise<string> {
  const endRes = await fetch(`${NETWORK.ledgerHost}/v2/state/ledger-end`, {
    headers: { Authorization: `Bearer ${jwt}` }
  });
  if (!endRes.ok) return "unknown";
  const { offset } = (await endRes.json()) as { offset: number };
  const r = await fetch(`${NETWORK.ledgerHost}/v2/state/active-contracts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`
    },
    body: JSON.stringify({
      filter: {
        filtersByParty: {
          [p]: {
            cumulative: [
              {
                identifierFilter: {
                  InterfaceFilter: {
                    value: {
                      interfaceId: HOLDING_INTERFACE,
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
      activeAtOffset: offset
    })
  });
  if (!r.ok) return "unknown";
  const entries = (await r.json()) as Array<{
    contractEntry?: {
      JsActiveContract?: {
        createdEvent?: {
          interfaceViews?: Array<{
            viewValue?: { owner?: string; amount?: string; instrumentId?: { id?: string } };
            viewStatus?: { code?: number };
          }>;
        };
      };
    };
  }>;
  let units = 0n;
  for (const e of entries) {
    const iv = e.contractEntry?.JsActiveContract?.createdEvent?.interfaceViews?.[0];
    if (!iv || iv.viewStatus?.code) continue;
    const v = iv.viewValue;
    if (!v || v.owner !== p || v.instrumentId?.id !== "Amulet") continue;
    units += toBaseUnitsFloor(String(v.amount ?? "0"), CC_DECIMALS);
  }
  return fromBaseUnits(units, CC_DECIMALS);
}

async function ccBalance(jwt: string, p: string): Promise<string> {
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
  const fromLedger = await ccBalanceFromLedger(jwt, p);
  return fromLedger === "unknown" ? "0" : fromLedger;
}

async function ccPreapproval(jwt: string, p: string): Promise<boolean> {
  const r = await fetch(
    validatorUrl(
      `/v0/scan-proxy/transfer-preapprovals/by-party/${encodeURIComponent(p)}`
    ),
    { headers: { Authorization: `Bearer ${jwt}` }, cache: "no-store" }
  );
  if (r.status === 404 || !r.ok) return false;
  const j = (await r.json().catch(() => null)) as {
    transfer_preapproval?: unknown;
  } | null;
  return !!j?.transfer_preapproval;
}

async function cbtcPreapproval(jwt: string, p: string): Promise<boolean> {
  const endRes = await fetch(`${NETWORK.ledgerHost}/v2/state/ledger-end`, {
    headers: { Authorization: `Bearer ${jwt}` }
  });
  if (!endRes.ok) return false;
  const { offset } = (await endRes.json()) as { offset: number };
  const template =
    "#utility-registry-app-v0:Utility.Registry.App.V0.Model.TransferPreapproval:TransferPreapproval";
  const r = await fetch(`${NETWORK.ledgerHost}/v2/state/active-contracts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`
    },
    body: JSON.stringify({
      filter: {
        filtersByParty: {
          [p]: {
            cumulative: [
              {
                identifierFilter: {
                  TemplateFilter: {
                    value: {
                      templateId: template,
                      includeCreatedEventBlob: false
                    }
                  }
                }
              }
            ]
          }
        }
      },
      verbose: true,
      activeAtOffset: offset
    })
  });
  if (!r.ok) return false;
  const entries = (await r.json()) as Array<{
    contractEntry?: {
      JsActiveContract?: {
        createdEvent?: {
          createArgument?: { receiver?: string; instrumentAdmin?: string };
        };
      };
    };
  }>;
  const admin = NETWORK.decentralizedPartyId;
  for (const e of entries) {
    const arg = e.contractEntry?.JsActiveContract?.createdEvent?.createArgument;
    if (arg?.receiver === p && arg?.instrumentAdmin === admin) return true;
  }
  return false;
}

async function getLedgerJwt(): Promise<string> {
  const auth = authEnv();
  const res = await fetch(auth.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: auth.clientId,
      client_secret: auth.clientSecret,
      scope: auth.scope
    })
  });
  if (!res.ok) throw new Error(`JWT fetch failed (${res.status}): ${await res.text()}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

async function main(): Promise<void> {
  const auth = authEnv();
  const client = new CantonClient(
    {
      ledgerHost: NETWORK.ledgerHost,
      registryUrl: NETWORK.registryUrl,
      decentralizedPartyId: NETWORK.decentralizedPartyId,
      instrumentId: NETWORK.instrumentId,
      solverParty: party
    },
    auth
  );

  console.log(`Network: ${NETWORK.name}`);
  console.log(`Party:   ${party}\n`);

  const jwt = await getLedgerJwt();

  const [holdings, ccTotal, ccPre, cbtcPre] = await Promise.all([
    client.getHoldings(party),
    ccBalance(jwt, party),
    ccPreapproval(jwt, party),
    cbtcPreapproval(jwt, party)
  ]);

  let cbtcUnits = 0n;
  let unlocked = 0;
  let locked = 0;

  console.log("CBTC (Utility Registry holdings)");
  if (holdings.length === 0) {
    console.log("    (none)");
  } else {
    for (const h of holdings) {
      const u = toBaseUnitsFloor(h.amount, CBTC_DECIMALS);
      cbtcUnits += u;
      if (h.locked) locked++;
      else unlocked++;
      console.log(
        `    ${fromBaseUnits(u, CBTC_DECIMALS).padStart(14)}  ${h.locked ? "[locked]" : "        "}  cid ${h.contractId.slice(0, 28)}…`
      );
    }
  }
  console.log(`  TOTAL: ${fromBaseUnits(cbtcUnits, CBTC_DECIMALS)} CBTC`);
  console.log(
    `  UTXOs: ${holdings.length} (${unlocked} unlocked, ${locked} locked) / 10 max\n`
  );

  console.log("CC (Amulet, unlocked via ledger ACS)");
  console.log(`  TOTAL: ${ccTotal} CC\n`);

  console.log("TransferPreapproval (should be OFF for settlement receiver)");
  console.log(`  CC (Splice EnableCC):     ${ccPre ? "YES" : "NO"}`);
  console.log(`  CBTC (utility registry):  ${cbtcPre ? "YES" : "NO"}`);

  const isSettlement =
    party === process.env.CANTON_SWAP_SETTLEMENT_PARTY ||
    party.includes("settle");
  if (isSettlement) {
    if (ccPre || cbtcPre) {
      console.warn(
        "\n⚠ Settlement party has preapproval — Loop user legs may auto-settle (direct)."
      );
    } else if (cbtcUnits > 0n) {
      console.log(
        "\nℹ CBTC on settlement party is normal after fills (accepted user sell legs)."
      );
    }
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

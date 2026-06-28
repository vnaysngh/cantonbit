#!/usr/bin/env npx tsx
/**
 * Fund the C2C settlement vault from the HTLC solver party (warpx-devnet-1).
 * Transfers CBTC + CC via offer → vault accept (vault must stay preapproval-free).
 *
 * Usage:
 *   npm run fund-swap-vault:devnet
 *   npm run fund-swap-vault:devnet -- --cbtc=0.25 --cc=50000
 *
 * Env:
 *   NEXT_PUBLIC_SOLVER_CANTON or SOLVER_CANTON_PARTY — source
 *   CANTON_SWAP_SETTLEMENT_PARTY — destination vault
 */
import { spawnSync } from "node:child_process";

import { NETWORK } from "../lib/constants";
import { toBaseUnitsFloor } from "../lib/amount-units";
import { extractCreatedOfferCid } from "../lib/mint-processor-logic";
import { selectHoldingsForAmount } from "../lib/transfer-holdings";
import { CantonClient } from "../swap-solver/src/canton.js";
import {
  configureVaultCbtcCache,
  ingestVaultCbtcFromSubmit
} from "./farm/lib/vault-cbtc-holdings";

const DEFAULT_CC = "100000";
const DEFAULT_CBTC = "0.5";
const CBTC_HOLDING_TEMPLATE_FQN =
  "8107899ac4723ce986bf7d27416534e576e54b92161e46150a595fb78ff3d3a1:Utility.Registry.Holding.V0.Holding:Holding";

function parseArg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.split("=", 2)[1]?.trim() || fallback;
}

const sourceParty =
  process.env.SOLVER_CANTON_PARTY?.trim() ||
  process.env.NEXT_PUBLIC_SOLVER_CANTON?.trim() ||
  "";
const destParty =
  process.env.CANTON_SWAP_SETTLEMENT_PARTY?.trim() ||
  process.env.NEXT_PUBLIC_CANTON_SWAP_SETTLEMENT_PARTY?.trim() ||
  "";

const ccAmount = parseArg("cc", DEFAULT_CC);
const cbtcAmount = parseArg("cbtc", DEFAULT_CBTC);

if (!sourceParty || !destParty) {
  console.error(
    "Set NEXT_PUBLIC_SOLVER_CANTON (source) and CANTON_SWAP_SETTLEMENT_PARTY (vault)."
  );
  process.exit(1);
}

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

function printBalances(label: string, party: string): void {
  console.log(`\n--- ${label} (${party.slice(0, 32)}…) ---`);
  const npmScript =
    NETWORK.name === "mainnet" ? "party-balances:mainnet" : "party-balances:devnet";
  const r = spawnSync(
    "npm",
    ["run", npmScript, "--", party],
    { stdio: "inherit", cwd: process.cwd(), env: process.env }
  );
  if (r.status !== 0) {
    console.warn(`(balance check exited ${r.status})`);
  }
}

const TRANSFER_FACTORY_INTERFACE =
  "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory";
const TRANSFER_INSTRUCTION_INTERFACE =
  "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction";
const AMULET_HOLDING_TEMPLATE_FQN =
  "a31be0483f3175647053f28965a4e6d97e3dbc433ea2338be303fae69bbcff6a:Splice.Amulet:Amulet";
const HOLDING_INTERFACE =
  "#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding";

function validatorUrl(path: string): string {
  return `${NETWORK.validatorHost}/api/validator${path}`;
}

async function getDsoPartyId(jwt: string): Promise<string> {
  const r = await fetch(validatorUrl("/v0/scan-proxy/dso-party-id"), {
    headers: { Authorization: `Bearer ${jwt}` },
    cache: "no-store"
  });
  if (!r.ok) throw new Error(`DSO lookup failed (${r.status})`);
  const j = (await r.json()) as { dso_party_id?: string };
  const dso = j.dso_party_id?.trim();
  if (!dso) throw new Error("DSO party missing");
  return dso;
}

async function listCcHoldings(jwt: string, party: string, dsoAdmin: string) {
  const endRes = await fetch(`${NETWORK.ledgerHost}/v2/state/ledger-end`, {
    headers: { Authorization: `Bearer ${jwt}` }
  });
  if (!endRes.ok) throw new Error("ledger-end failed");
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
          [party]: {
            cumulative: [
              {
                identifierFilter: {
                  InterfaceFilter: {
                    value: {
                      interfaceId: HOLDING_INTERFACE,
                      includeInterfaceView: true,
                      includeCreatedEventBlob: true
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
  if (!r.ok) throw new Error(`ACS read failed (${r.status})`);
  const entries = (await r.json()) as Array<{
    contractEntry?: {
      JsActiveContract?: {
        createdEvent?: {
          contractId?: string;
          createdEventBlob?: string;
          interfaceViews?: Array<{
            viewValue?: { owner?: string; amount?: string; instrumentId?: { id?: string } };
            viewStatus?: { code?: number };
          }>;
        };
      };
    };
  }>;
  const out: Array<{
    contractId: string;
    createdEventBlob: string;
    payload: {
      owner: string;
      amount: string;
      instrumentId: { admin: string; id: string };
    };
  }> = [];
  for (const e of entries) {
    const ev = e.contractEntry?.JsActiveContract?.createdEvent;
    const iv = ev?.interfaceViews?.[0];
    if (!ev?.contractId || !iv || iv.viewStatus?.code) continue;
    const v = iv.viewValue;
    if (!v || v.owner !== party || v.instrumentId?.id !== "Amulet") continue;
    out.push({
      contractId: ev.contractId,
      createdEventBlob: ev.createdEventBlob ?? "",
      payload: {
        owner: party,
        amount: String(v.amount ?? "0"),
        instrumentId: { admin: dsoAdmin, id: "Amulet" }
      }
    });
  }
  return out;
}

function readTransferFromCreatedEvent(ev: {
  contractId?: string;
  templateId?: string;
  createArgument?: unknown;
  interfaceViews?: Array<{
    interfaceId?: string;
    viewValue?: unknown;
    viewStatus?: { code?: number };
  }>;
}): { sender?: string; receiver?: string; amount?: string; instrumentId?: { id?: string } } | null {
  const arg = ev.createArgument as
    | { transfer?: { sender?: string; receiver?: string; amount?: string; instrumentId?: { id?: string } } }
    | undefined;
  if (arg?.transfer?.sender && arg.transfer.receiver) {
    return arg.transfer;
  }
  for (const view of ev.interfaceViews ?? []) {
    if (view.viewStatus?.code) continue;
    const vv = view.viewValue as
      | { transfer?: { sender?: string; receiver?: string; amount?: string; instrumentId?: { id?: string } } }
      | { sender?: string; receiver?: string; amount?: string; instrumentId?: { id?: string } }
      | undefined;
    const t =
      vv && "transfer" in vv && vv.transfer ? vv.transfer : (vv as typeof arg.transfer);
    if (t?.sender && t.receiver) return t;
  }
  return null;
}

/** Re-use pending offer from a prior failed fund run (e.g. createOffer locked inputs). */
async function findPendingOfferOnVault(
  jwt: string,
  params: {
    senderParty: string;
    amount: string;
    decimals: number;
    instrumentId: string;
  }
): Promise<string | null> {
  const endRes = await fetch(`${NETWORK.ledgerHost}/v2/state/ledger-end`, {
    headers: { Authorization: `Bearer ${jwt}` }
  });
  if (!endRes.ok) return null;
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
          [destParty]: {
            cumulative: [
              {
                identifierFilter: {
                  WildcardFilter: { value: { includeCreatedEventBlob: false } }
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
  if (!r.ok) return null;
  const need = toBaseUnitsFloor(params.amount, params.decimals);
  const entries = (await r.json()) as Array<{
    contractEntry?: {
      JsActiveContract?: {
        createdEvent?: {
          contractId?: string;
          templateId?: string;
          createArgument?: unknown;
          interfaceViews?: Array<{
            interfaceId?: string;
            viewValue?: unknown;
            viewStatus?: { code?: number };
          }>;
        };
      };
    };
  }>;
  for (const e of entries) {
    const ev = e.contractEntry?.JsActiveContract?.createdEvent;
    if (!ev?.contractId || !ev.templateId) continue;
    if (
      !ev.templateId.includes("TransferInstruction") &&
      !ev.templateId.includes("TransferOffer")
    ) {
      continue;
    }
    const t = readTransferFromCreatedEvent(ev);
    if (!t || t.sender !== params.senderParty || t.receiver !== destParty) continue;
    if (t.instrumentId?.id && t.instrumentId.id !== params.instrumentId) continue;
    try {
      if (toBaseUnitsFloor(String(t.amount ?? "0"), params.decimals) !== need) continue;
    } catch {
      continue;
    }
    return ev.contractId;
  }
  return null;
}

async function submitLedger(
  jwt: string,
  actAs: string[],
  commands: unknown[],
  disclosedContracts: Array<{
    templateId: string;
    contractId: string;
    createdEventBlob: string;
    synchronizerId: string;
  }>,
  commandId: string
): Promise<{ updateId: string; eventsById: Record<string, unknown> }> {
  const res = await fetch(
    `${NETWORK.ledgerHost}/v2/commands/submit-and-wait-for-transaction-tree`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`
      },
      body: JSON.stringify({
        applicationId: "fund-swap-vault",
        workflowId: commandId,
        commandId,
        actAs,
        readAs: actAs,
        commands,
        disclosedContracts
      }),
      cache: "no-store"
    }
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`ledger submit failed (${res.status}): ${text}`);
  }
  const json = JSON.parse(text) as {
    transactionTree?: { updateId: string; eventsById?: Record<string, unknown> };
  };
  return {
    updateId: json.transactionTree?.updateId ?? "",
    eventsById: json.transactionTree?.eventsById ?? {}
  };
}

async function acceptOffer(params: {
  jwt: string;
  receiverParty: string;
  offerContractId: string;
  registrarAdmin: string;
  registryKind: "cbtc" | "cc";
  commandId: string;
}): Promise<{ updateId: string; eventsById: Record<string, unknown> }> {
  const ctxUrl =
    params.registryKind === "cc"
      ? validatorUrl(
          `/v0/scan-proxy/registry/transfer-instruction/v1/${params.offerContractId}/choice-contexts/accept`
        )
      : `${NETWORK.registryUrl}/api/token-standard/v0/registrars/${params.registrarAdmin}/registry/transfer-instruction/v1/${params.offerContractId}/choice-contexts/accept`;
  const ctxRes = await fetch(ctxUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.jwt}`
    },
    body: JSON.stringify({ meta: {} }),
    cache: "no-store"
  });
  if (!ctxRes.ok) {
    throw new Error(`accept context failed (${ctxRes.status}): ${await ctxRes.text()}`);
  }
  const ctx = (await ctxRes.json()) as {
    choiceContextData: unknown;
    disclosedContracts: Array<{
      templateId: string;
      contractId: string;
      createdEventBlob: string;
      synchronizerId: string;
    }>;
  };
  return submitLedger(
    params.jwt,
    [params.receiverParty],
    [
      {
        ExerciseCommand: {
          templateId: TRANSFER_INSTRUCTION_INTERFACE,
          contractId: params.offerContractId,
          choice: "TransferInstruction_Accept",
          choiceArgument: {
            extraArgs: { context: ctx.choiceContextData, meta: { values: {} } }
          }
        }
      }
    ],
    ctx.disclosedContracts ?? [],
    params.commandId
  );
}

async function ingestVaultCbtcFromFund(
  jwt: string,
  updateId: string,
  eventsById: Record<string, unknown>
): Promise<void> {
  configureVaultCbtcCache(destParty);
  const n = await ingestVaultCbtcFromSubmit({
    jwt,
    vaultParty: destParty,
    updateId,
    submitEventsById: eventsById
  });
  if (n > 0) {
    console.log(`Vault CBTC cache: ingested ${n} spendable holding(s) from fund`);
  }
}

async function fundCbtc(jwt: string, client: CantonClient): Promise<void> {
  if (parseFloat(cbtcAmount) <= 0) {
    console.log("\nSkipping CBTC (amount <= 0)");
    return;
  }
  console.log(`\nFunding ${cbtcAmount} CBTC: ${sourceParty.slice(0, 28)}… → vault`);

  const existingCbtc = await findPendingOfferOnVault(jwt, {
    senderParty: sourceParty,
    amount: cbtcAmount,
    decimals: 8,
    instrumentId: "CBTC"
  });
  if (existingCbtc) {
    console.log(
      `Found pending CBTC offer ${existingCbtc.slice(0, 16)}… — accepting on vault`
    );
    const accepted = await acceptOffer({
      jwt,
      receiverParty: destParty,
      offerContractId: existingCbtc,
      registrarAdmin: NETWORK.decentralizedPartyId,
      registryKind: "cbtc",
      commandId: `fund-vault-cbtc-accept-${Date.now()}`
    });
    console.log(`CBTC accepted on vault (offer ${existingCbtc.slice(0, 16)}…)`);
    await ingestVaultCbtcFromFund(jwt, accepted.updateId, accepted.eventsById);
    return;
  }

  const holdings = await client.getHoldings(sourceParty);
  const unlocked = holdings.filter((h) => !h.locked);
  if (unlocked.length === 0) throw new Error("source has no unlocked CBTC holdings");

  const mapped = unlocked.map((h) => ({
    contractId: h.contractId,
    createdEventBlob: h.createdEventBlob,
    payload: {
      owner: sourceParty,
      amount: h.amount,
      instrumentId: NETWORK.instrumentId
    }
  }));
  const picked = selectHoldingsForAmount(mapped, cbtcAmount, 8, "CBTC");

  const admin = NETWORK.decentralizedPartyId;
  const now = new Date().toISOString();
  const executeBefore = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const transferPayload = {
    sender: sourceParty,
    receiver: destParty,
    amount: cbtcAmount,
    instrumentId: NETWORK.instrumentId,
    lock: null,
    requestedAt: now,
    executeBefore,
    inputHoldingCids: picked.map((h) => h.contractId),
    meta: { values: {} }
  };

  const factoryUrl = `${NETWORK.registryUrl}/api/token-standard/v0/registrars/${admin}/registry/transfer-instruction/v1/transfer-factory`;
  const factoryRes = await fetch(factoryUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      choiceArguments: {
        expectedAdmin: admin,
        transfer: transferPayload,
        extraArgs: { context: { values: {} }, meta: { values: {} } }
      }
    }),
    cache: "no-store"
  });
  if (!factoryRes.ok) {
    throw new Error(`CBTC factory failed (${factoryRes.status}): ${await factoryRes.text()}`);
  }
  const factory = (await factoryRes.json()) as {
    factoryId: string;
    transferKind?: string;
    choiceContext: {
      choiceContextData: unknown;
      disclosedContracts: Array<{
        templateId: string;
        contractId: string;
        createdEventBlob: string;
        synchronizerId: string;
      }>;
    };
  };

  const disclosed = [
    ...factory.choiceContext.disclosedContracts.map((dc) => ({
      ...dc,
      synchronizerId: dc.synchronizerId ?? ""
    })),
    ...picked.map((h) => ({
      templateId: CBTC_HOLDING_TEMPLATE_FQN,
      contractId: h.contractId,
      createdEventBlob: h.createdEventBlob,
      synchronizerId: ""
    }))
  ];

  const commandId = `fund-vault-cbtc-${Date.now()}`;
  const { updateId, eventsById } = await submitLedger(
    jwt,
    [sourceParty],
    [
      {
        ExerciseCommand: {
          templateId: TRANSFER_FACTORY_INTERFACE,
          contractId: factory.factoryId,
          choice: "TransferFactory_Transfer",
          choiceArgument: {
            expectedAdmin: admin,
            transfer: transferPayload,
            extraArgs: {
              context: factory.choiceContext.choiceContextData,
              meta: { values: {} }
            }
          }
        }
      }
    ],
    disclosed,
    commandId
  );

  const kind = (factory.transferKind ?? "").toLowerCase();
  if (kind.includes("direct") || kind === "self") {
    console.log(
      `CBTC delivered (direct/auto-accept) update=${updateId.slice(0, 16)}…`
    );
    await ingestVaultCbtcFromFund(jwt, updateId, eventsById);
    return;
  }

  const offerCid = extractCreatedOfferCid(eventsById);
  if (!offerCid) {
    throw new Error(
      "CBTC offer CID missing from submit tree — vault has no preapproval so offer+accept is required"
    );
  }
  const accepted = await acceptOffer({
    jwt,
    receiverParty: destParty,
    offerContractId: offerCid,
    registrarAdmin: admin,
    registryKind: "cbtc",
    commandId: `fund-vault-cbtc-accept-${Date.now()}`
  });
  console.log(`CBTC accepted on vault (offer ${offerCid.slice(0, 16)}…)`);
  await ingestVaultCbtcFromFund(jwt, accepted.updateId, accepted.eventsById);
}

async function fundCc(jwt: string): Promise<void> {
  if (parseFloat(ccAmount) <= 0) {
    console.log("\nSkipping CC (amount <= 0)");
    return;
  }
  console.log(`\nFunding ${ccAmount} CC: ${sourceParty.slice(0, 28)}… → vault`);
  const dso = await getDsoPartyId(jwt);

  const existingCc = await findPendingOfferOnVault(jwt, {
    senderParty: sourceParty,
    amount: ccAmount,
    decimals: 10,
    instrumentId: "Amulet"
  });
  if (existingCc) {
    console.log(`Found pending CC offer ${existingCc.slice(0, 16)}… — accepting on vault`);
    await acceptOffer({
      jwt,
      receiverParty: destParty,
      offerContractId: existingCc,
      registrarAdmin: dso,
      registryKind: "cc",
      commandId: `fund-vault-cc-accept-${Date.now()}`
    });
    console.log(`CC accepted on vault (offer ${existingCc.slice(0, 16)}…)`);
    return;
  }

  const holdings = await listCcHoldings(jwt, sourceParty, dso);
  const picked = selectHoldingsForAmount(holdings, ccAmount, 10, "CC");
  const now = new Date().toISOString();
  const executeBefore = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const transferPayload = {
    sender: sourceParty,
    receiver: destParty,
    amount: ccAmount,
    instrumentId: { admin: dso, id: "Amulet" },
    lock: null,
    requestedAt: now,
    executeBefore,
    inputHoldingCids: picked.map((h) => h.contractId),
    meta: { values: {} }
  };

  const factoryRes = await fetch(
    validatorUrl("/v0/scan-proxy/registry/transfer-instruction/v1/transfer-factory"),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`
      },
      body: JSON.stringify({
        choiceArguments: {
          expectedAdmin: dso,
          transfer: transferPayload,
          extraArgs: { context: { values: {} }, meta: { values: {} } }
        }
      }),
      cache: "no-store"
    }
  );
  if (!factoryRes.ok) {
    throw new Error(`CC factory failed (${factoryRes.status}): ${await factoryRes.text()}`);
  }
  const factory = (await factoryRes.json()) as {
    factoryId: string;
    transferKind?: string;
    choiceContext: {
      choiceContextData: unknown;
      disclosedContracts: Array<{
        templateId: string;
        contractId: string;
        createdEventBlob: string;
        synchronizerId: string;
      }>;
    };
  };

  const disclosed = [
    ...factory.choiceContext.disclosedContracts.map((dc) => ({
      ...dc,
      synchronizerId: dc.synchronizerId ?? ""
    })),
    ...picked.map((h) => ({
      templateId: AMULET_HOLDING_TEMPLATE_FQN,
      contractId: h.contractId,
      createdEventBlob: h.createdEventBlob,
      synchronizerId: ""
    }))
  ];

  const commandId = `fund-vault-cc-${Date.now()}`;
  const { eventsById } = await submitLedger(
    jwt,
    [sourceParty],
    [
      {
        ExerciseCommand: {
          templateId: TRANSFER_FACTORY_INTERFACE,
          contractId: factory.factoryId,
          choice: "TransferFactory_Transfer",
          choiceArgument: {
            expectedAdmin: dso,
            transfer: transferPayload,
            extraArgs: {
              context: factory.choiceContext.choiceContextData,
              meta: { values: {} }
            }
          }
        }
      }
    ],
    disclosed,
    commandId
  );

  const kind = (factory.transferKind ?? "").toLowerCase();
  if (kind.includes("direct") || kind === "self") {
    console.log("CC delivered (direct/auto-accept)");
    return;
  }

  const offerCid = extractCreatedOfferCid(eventsById);
  if (!offerCid) throw new Error("CC offer CID missing from submit tree");
  await acceptOffer({
    jwt,
    receiverParty: destParty,
    offerContractId: offerCid,
    registrarAdmin: dso,
    registryKind: "cc",
    commandId: `fund-vault-cc-accept-${Date.now()}`
  });
  console.log(`CC accepted on vault (offer ${offerCid.slice(0, 16)}…)`);
}

async function main(): Promise<void> {
  console.log(`Network: ${NETWORK.name}`);
  console.log(`Source:  ${sourceParty}`);
  console.log(`Vault:   ${destParty}`);
  console.log(`Amounts: ${cbtcAmount} CBTC, ${ccAmount} CC`);

  printBalances("Before — source", sourceParty);
  printBalances("Before — vault", destParty);

  const auth = authEnv();
  const jwt = await getLedgerJwt();
  const client = new CantonClient(
    {
      ledgerHost: NETWORK.ledgerHost,
      registryUrl: NETWORK.registryUrl,
      decentralizedPartyId: NETWORK.decentralizedPartyId,
      instrumentId: NETWORK.instrumentId,
      solverParty: sourceParty
    },
    auth
  );

  await fundCbtc(jwt, client);
  await fundCc(jwt);

  printBalances("After — source", sourceParty);
  printBalances("After — vault", destParty);
  console.log("\n✓ Fund swap vault complete.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

/**
 * EnableCC — one-time Canton Coin (Amulet) onboarding for hosted parties.
 *
 * Creates ValidatorRight + TransferPreapproval via the validator's
 * ExternalPartySetupProposal flow (what venues like Cancore call "EnableCC").
 * Idempotent: skips when a TransferPreapproval already exists for the party.
 */
import "server-only";

import { randomUUID } from "node:crypto";

import { getLedgerJwt } from "./auth";
import { NETWORK } from "./constants";

const TAG = "[enable-cc]";

function validatorUrl(path: string): string {
  return `${NETWORK.validatorHost}/api/validator${path}`;
}

/** True when the party can hold/send CC (TransferPreapproval exists). */
export async function hasCcEnabled(party: string): Promise<boolean> {
  const jwt = await getLedgerJwt();
  const r = await fetch(
    validatorUrl(
      `/v0/scan-proxy/transfer-preapprovals/by-party/${encodeURIComponent(party)}`
    ),
    { headers: { Authorization: `Bearer ${jwt}` }, cache: "no-store" }
  );
  if (r.status === 404) return false;
  if (!r.ok) {
    console.warn(
      `${TAG} preapproval lookup failed (${r.status}) for ${party.slice(0, 28)}…`
    );
    return false;
  }
  const j = (await r.json().catch(() => null)) as {
    transfer_preapproval?: unknown;
  } | null;
  return !!j?.transfer_preapproval;
}

async function findPendingSetupProposal(
  party: string
): Promise<string | null> {
  const jwt = await getLedgerJwt();
  const r = await fetch(validatorUrl("/v0/admin/external-party/setup-proposal"), {
    headers: { Authorization: `Bearer ${jwt}` }, cache: "no-store"
  });
  if (!r.ok) return null;
  const j = (await r.json()) as {
    contracts?: { contract?: { contract_id?: string; payload?: { user?: string } } }[];
  };
  for (const row of j.contracts ?? []) {
    const cid = row.contract?.contract_id;
    const user = row.contract?.payload?.user;
    if (cid && user === party) return cid;
  }
  return null;
}

async function resolveProposalTemplateId(
  jwt: string,
  proposalCid: string
): Promise<string> {
  const endRes = await fetch(`${NETWORK.ledgerHost}/v2/state/ledger-end`, {
    headers: { Authorization: `Bearer ${jwt}` }
  });
  const offset = ((await endRes.json()) as { offset: number }).offset;
  const r = await fetch(`${NETWORK.ledgerHost}/v2/state/active-contracts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`
    },
    body: JSON.stringify({
      filter: {
        filtersForAnyParty: {
          cumulative: [
            {
              identifierFilter: {
                TemplateFilter: {
                  value: {
                    templateId:
                      "#splice-amulet:Splice.AmuletRules:ExternalPartySetupProposal",
                    includeCreatedEventBlob: false
                  }
                }
              }
            }
          ]
        }
      },
      verbose: true,
      activeAtOffset: offset
    })
  });
  if (r.ok) {
    const entries = (await r.json()) as Array<{
      contractEntry?: {
        JsActiveContract?: {
          createdEvent?: { contractId?: string; templateId?: string };
        };
      };
    }>;
    for (const e of entries) {
      const ev = e?.contractEntry?.JsActiveContract?.createdEvent;
      if (ev?.contractId === proposalCid && ev?.templateId) {
        return ev.templateId as string;
      }
    }
  }
  return "#splice-amulet:Splice.AmuletRules:ExternalPartySetupProposal";
}

async function acceptSetupProposal(
  party: string,
  proposalCid: string
): Promise<void> {
  const jwt = await getLedgerJwt();
  const templateId = await resolveProposalTemplateId(jwt, proposalCid);
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
        actAs: [party],
        readAs: [party],
        commands: [
          {
            ExerciseCommand: {
              templateId,
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
  console.log(
    `${TAG} accepted setup proposal for ${party.slice(0, 28)}… → CC enabled`
  );
}

/**
 * Run EnableCC for a participant-managed party. Safe to call on every provision —
 * no-ops when CC is already enabled.
 */
export async function enableCcForParty(party: string): Promise<void> {
  if (await hasCcEnabled(party)) {
    console.log(`${TAG} already enabled for ${party.slice(0, 28)}…`);
    return;
  }

  const jwt = await getLedgerJwt();
  let proposalCid = await findPendingSetupProposal(party);

  if (!proposalCid) {
    const createRes = await fetch(
      validatorUrl("/v0/admin/external-party/setup-proposal"),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ user_party_id: party })
      }
    );
    if (!createRes.ok) {
      const text = await createRes.text();
      proposalCid = await findPendingSetupProposal(party);
      if (!proposalCid) {
        throw new Error(
          `EnableCC setup-proposal failed (${createRes.status}): ${text}`
        );
      }
    } else {
      const j = (await createRes.json()) as { contract_id?: string };
      proposalCid = j.contract_id ?? null;
      if (!proposalCid) {
        throw new Error("EnableCC: setup-proposal returned no contract_id");
      }
      console.log(
        `${TAG} created setup proposal ${proposalCid.slice(0, 20)}… for ${party.slice(0, 28)}…`
      );
    }
  }

  await acceptSetupProposal(party, proposalCid);

  if (!(await hasCcEnabled(party))) {
    console.warn(
      `${TAG} accept submitted but TransferPreapproval not yet visible for ${party.slice(0, 28)}…`
    );
  }
}

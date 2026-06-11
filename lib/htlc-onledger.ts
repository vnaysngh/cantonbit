/**
 * ON-LEDGER cBTC HTLC (the real DAR path) — G1/G2.
 *
 * Drives our uploaded `cbtc-htlc` DAR (HtlcLock template) so the cBTC hash check
 * is enforced ON THE DAML LEDGER, not in the backend. Three steps:
 *
 *   1. allocate()   — lock the solver's cBTC in a Splice Allocation, naming the
 *                     SOLVER as executor (pre-delegation: sender+receiver consent
 *                     is granted to the executor at allocation creation, so the
 *                     executor fires Allocation_ExecuteTransfer ALONE — confirmed
 *                     in Splice AllocationV1 source lines 126-129).
 *   2. createHtlcLock() — wrap that Allocation in our HtlcLock (records hashLock,
 *                     unlockTime). The cBTC is now locked on-ledger.
 *   3. claimHtlcLock(preimage) — exercise HtlcLock.Claim. The DAML LEDGER checks
 *                     keccak256(preimage)==hashLock (CbtcHtlc.daml), then fires
 *                     Allocation_ExecuteTransfer → cBTC moves to the receiver and
 *                     the preimage is revealed on-ledger.
 *
 * Ported from the PROVEN swap-solver/src/probe-htlc-spike.mts + canton.ts allocate().
 */
import "server-only";

import { getLedgerJwt } from "./auth";
import { NETWORK } from "./constants";
import type { Holding } from "./types";

const TAG = "[htlc-onledger]";

// Our uploaded cbtc-htlc DAR (v0.1.3 — Claim controller=receiver, observer=executor
// ONLY). The receiver is NOT a static observer (that would force their participant to
// vet our DAR → NO_SYNCHRONIZER for cross-participant Loop users). Instead the receiver
// sees the HtlcLock via EXPLICIT DISCLOSURE (createdEventBlob) — no vetting needed.
// This is how Cancore does it (works for both local and Loop receivers).
const HTLC_PKG = "791eb59c536045c33cb33154498d6d28cf0b1538513a9edecdb97562db661734";
const HTLC_TID = `${HTLC_PKG}:CbtcHtlc:HtlcLock`;

const ALLOCATION_FACTORY_INTERFACE =
  "#splice-api-token-allocation-instruction-v1:Splice.Api.Token.AllocationInstructionV1:AllocationFactory";
const HOLDING_TEMPLATE_FQN =
  "8107899ac4723ce986bf7d27416534e576e54b92161e46150a595fb78ff3d3a1:Utility.Registry.Holding.V0.Holding:Holding";

interface DisclosedContract {
  templateId: string;
  contractId: string;
  createdEventBlob: string;
  synchronizerId: string;
}

function reg(path: string): string {
  return `${NETWORK.registryUrl}/api/token-standard/v0/registrars/${NETWORK.decentralizedPartyId}${path}`;
}

async function submit(
  jwt: string,
  actAs: string[],
  commands: unknown[],
  disclosed: DisclosedContract[] = [],
): Promise<{ updateId: string; createdCids: string[]; created: { contractId: string; templateId: string; createdEventBlob: string }[]; tree: any }> {
  const commandId =
    "htlc-" + Math.random().toString(16).slice(2) + Date.now().toString(16);
  const res = await fetch(
    `${NETWORK.ledgerHost}/v2/commands/submit-and-wait-for-transaction-tree`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
      cache: "no-store",
      body: JSON.stringify({
        applicationId: "cbtc-htlc",
        workflowId: `htlc-${commandId}`,
        commandId,
        actAs,
        readAs: actAs,
        commands,
        disclosedContracts: disclosed,
      }),
    },
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`submit failed (${res.status}): ${text}`);
  const tree = JSON.parse(text);
  const events = tree?.transactionTree?.eventsById ?? {};
  const createdCids: string[] = [];
  const created: { contractId: string; templateId: string; createdEventBlob: string }[] = [];
  for (const ev of Object.values(events) as any[]) {
    const c = ev?.CreatedTreeEvent?.value;
    if (!c?.contractId) continue;
    const tpl = c.templateId ?? "";
    created.push({ contractId: c.contractId, templateId: tpl, createdEventBlob: c.createdEventBlob ?? "" });
    // Skip plain Holding change-outputs (the leftover cBTC from an allocation) —
    // otherwise createdCids[0] would be a Holding, not the Allocation, and the
    // registry's execute-transfer choice-context can't decode it ("Unknown field
    // registrar"). Match the entity name, since the Allocation path also contains
    // "Holding" (…Holding.Allocation:DvpLegAllocation).
    const isPlainHolding = tpl.endsWith(":Holding") || tpl.includes("Holding.V0.Holding:Holding");
    if (!isPlainHolding) createdCids.push(c.contractId);
  }
  return { updateId: tree?.transactionTree?.updateId ?? "", createdCids, created, tree };
}

const ALLOCATION_INTERFACE =
  "#splice-api-token-allocation-v1:Splice.Api.Token.AllocationV1:Allocation";

/**
 * CLEANUP — withdraw an Allocation directly (Allocation_Withdraw, sender-alone).
 * For orphaned allocations (no HtlcLock) left by a failed/retried lock. Returns the
 * solver's cBTC to the solver. Safe: sender-only, no receiver co-sign needed.
 */
export async function withdrawAllocation(solverParty: string, allocationCid: string): Promise<{ updateId: string }> {
  const jwt = await getLedgerJwt();
  const ctx = await allocationChoiceContext(allocationCid, "withdraw");
  const { updateId } = await submit(
    jwt,
    [solverParty],
    [{
      ExerciseCommand: {
        templateId: ALLOCATION_INTERFACE,
        contractId: allocationCid,
        choice: "Allocation_Withdraw",
        choiceArgument: { extraArgs: { context: ctx.data, meta: { values: {} } } },
      },
    }],
    ctx.disclosed,
  );
  console.log(`${TAG} withdrew orphan allocation ${allocationCid.slice(0, 16)}… → cBTC recovered. update ${updateId.slice(0, 16)}…`);
  return { updateId };
}

/** List the solver's active Allocation contract ids (to find orphans to clean up). */
export async function listSolverAllocations(solverParty: string): Promise<string[]> {
  const jwt = await getLedgerJwt();
  const endRes = await fetch(`${NETWORK.ledgerHost}/v2/state/ledger-end`, { headers: { Authorization: `Bearer ${jwt}` } });
  const offset = ((await endRes.json()) as { offset: number }).offset;
  const wildcard = { cumulative: [{ identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } }] };
  const r = await fetch(`${NETWORK.ledgerHost}/v2/state/active-contracts`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ filter: { filtersByParty: { [solverParty]: wildcard } }, verbose: false, activeAtOffset: offset }),
  });
  if (!r.ok) return [];
  const entries = (await r.json()) as any[];
  const out: string[] = [];
  for (const e of entries) {
    const c = e?.contractEntry?.JsActiveContract?.createdEvent;
    const tpl = c?.templateId ?? "";
    // Allocation template path contains "Allocation:DvpLegAllocation" (not plain Holding).
    if (c?.contractId && /Allocation/i.test(tpl) && !/:Holding$/.test(tpl)) out.push(c.contractId);
  }
  return out;
}

/** Registry choice-context for an Allocation lifecycle choice. */
async function allocationChoiceContext(
  allocationCid: string,
  kind: "execute-transfer" | "withdraw",
): Promise<{ data: unknown; disclosed: DisclosedContract[] }> {
  const url = reg(
    `/registry/allocations/v1/${encodeURIComponent(allocationCid)}/choice-contexts/${kind}`,
  );
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}), // this registry version wants an empty body, not {meta:{}}
  });
  if (!r.ok) throw new Error(`choice-context ${kind} failed (${r.status}): ${await r.text()}`);
  const ctx = (await r.json()) as { choiceContextData: unknown; disclosedContracts: DisclosedContract[] };
  return {
    data: ctx.choiceContextData,
    disclosed: (ctx.disclosedContracts ?? []).map((d) => ({ ...d, synchronizerId: d.synchronizerId ?? "" })),
  };
}

/** STEP 1 — lock cBTC in an Allocation (solver = sender = executor). */
export async function allocate(params: {
  solverParty: string;
  receiverParty: string;
  amountBtc: string;
  inputHoldings: Holding[];
  inputHoldingCids: string[];
  settlementId: string;
  settleBefore: Date;
  allocateBefore: Date;
}): Promise<{ updateId: string; allocationCid: string }> {
  const jwt = await getLedgerJwt();
  const now = new Date().toISOString();
  const allocation = {
    settlement: {
      executor: params.solverParty,
      settlementRef: { id: params.settlementId, cid: null },
      requestedAt: now,
      allocateBefore: params.allocateBefore.toISOString(),
      settleBefore: params.settleBefore.toISOString(),
      meta: { values: {} },
    },
    transferLegId: "leg-0",
    transferLeg: {
      sender: params.solverParty,
      receiver: params.receiverParty,
      amount: params.amountBtc,
      instrumentId: NETWORK.instrumentId,
      meta: { values: {} },
    },
  };

  const factoryRes = await fetch(reg(`/registry/allocation-instruction/v1/allocation-factory`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      choiceArguments: {
        expectedAdmin: NETWORK.decentralizedPartyId,
        allocation,
        requestedAt: now,
        inputHoldingCids: params.inputHoldingCids,
        extraArgs: { context: { values: {} }, meta: { values: {} } },
      },
    }),
  });
  if (!factoryRes.ok) throw new Error(`AllocationFactory failed (${factoryRes.status}): ${await factoryRes.text()}`);
  const factory = (await factoryRes.json()) as {
    factoryId: string;
    choiceContext: { choiceContextData: unknown; disclosedContracts: DisclosedContract[] };
  };

  const disclosed: DisclosedContract[] = [
    ...factory.choiceContext.disclosedContracts.map((dc) => ({ ...dc, synchronizerId: dc.synchronizerId ?? "" })),
    ...params.inputHoldings
      .filter((h) => params.inputHoldingCids.includes(h.contractId))
      .map((h) => ({
        templateId: HOLDING_TEMPLATE_FQN,
        contractId: h.contractId,
        createdEventBlob: h.createdEventBlob ?? "",
        synchronizerId: "",
      })),
  ];

  const { updateId, createdCids } = await submit(
    jwt,
    [params.solverParty],
    [{
      ExerciseCommand: {
        templateId: ALLOCATION_FACTORY_INTERFACE,
        contractId: factory.factoryId,
        choice: "AllocationFactory_Allocate",
        choiceArgument: {
          expectedAdmin: NETWORK.decentralizedPartyId,
          allocation,
          requestedAt: now,
          inputHoldingCids: params.inputHoldingCids,
          extraArgs: { context: factory.choiceContext.choiceContextData, meta: { values: {} } },
        },
      },
    }],
    disclosed,
  );
  const allocationCid = createdCids[0] ?? "";
  if (!allocationCid) throw new Error("allocate: no Allocation created");
  console.log(`${TAG} allocated ${params.amountBtc} cBTC → alloc ${allocationCid.slice(0, 20)}…`);
  return { updateId, allocationCid };
}

/** STEP 2 — wrap the Allocation in our HtlcLock (records hashLock + timelock). */
export async function createHtlcLock(params: {
  solverParty: string;
  receiverParty: string;
  allocationCid: string;
  hashLock: string; // lowercase hex, no 0x — keccak256 of the preimage hex
  unlockTime: Date;
}): Promise<{ htlcCid: string; htlcBlob: string }> {
  const jwt = await getLedgerJwt();
  const { created } = await submit(jwt, [params.solverParty], [{
    CreateCommand: {
      templateId: HTLC_TID,
      createArguments: {
        locker: params.solverParty,
        receiver: params.receiverParty,
        executor: params.solverParty,
        allocationCid: params.allocationCid,
        hashLock: params.hashLock.startsWith("0x") ? params.hashLock.slice(2) : params.hashLock,
        unlockTime: params.unlockTime.toISOString(),
      },
    },
  }]);
  const htlc = created.find((c) => c.templateId.includes("HtlcLock"));
  if (!htlc) throw new Error("createHtlcLock: no HtlcLock created");
  console.log(`${TAG} HtlcLock created ${htlc.contractId.slice(0, 20)}…`);
  return { htlcCid: htlc.contractId, htlcBlob: htlc.createdEventBlob };
}

/**
 * STEP 6 — PREPARE the user's Claim command. The Claim is `controller receiver`,
 * so it MUST be submitted by the USER from their own Loop wallet (their participant
 * supplies the receiver authority; Preapproval auto-accepts). The backend cannot
 * submit it. This returns the exact command + disclosed contracts for the browser
 * to hand to provider.submitTransaction().
 */
export async function prepareClaimCommand(params: {
  htlcCid: string;
  htlcBlob?: string; // the HtlcLock's createdEventBlob — disclosed so the receiver can see it
  allocationCid: string;
  solverParty: string; // to read the Allocation blob from the solver's ACS for disclosure
  preimageHex: string; // lowercase hex of the raw secret bytes, no 0x
}): Promise<{ command: unknown; disclosedContracts: DisclosedContract[]; synchronizerId: string }> {
  const ctx = await allocationChoiceContext(params.allocationCid, "execute-transfer");
  const preimage = params.preimageHex.startsWith("0x") ? params.preimageHex.slice(2) : params.preimageHex;
  const command = {
    ExerciseCommand: {
      templateId: HTLC_TID,
      contractId: params.htlcCid,
      choice: "Claim",
      choiceArgument: {
        preimage,
        allocationContext: { context: ctx.data, meta: { values: {} } },
      },
    },
  };
  // The receiver must SEE both the HtlcLock and the Allocation (which Claim fetches).
  // The HtlcLock they observe (DAR v0.1.4 observer=receiver). The Allocation is
  // disclosed via the registry choice-context — but if the receiver still can't read
  // it (created by the solver, receiver reading at a different offset), disclose it
  // explicitly from the solver's ACS.
  const disclosed = [...ctx.disclosed];
  // The synchronizer the contracts live on — the Loop SDK NEEDS this to route the
  // submission and resolve the disclosed templates (without it → TEMPLATES_NOT_FOUND).
  let syncId = disclosed.find((d) => d.synchronizerId)?.synchronizerId ?? "";
  const hasAlloc = disclosed.some((d) => d.contractId === params.allocationCid);
  if (!hasAlloc) {
    const allocBlob = await fetchContractBlob(params.allocationCid, params.solverParty);
    if (allocBlob) { disclosed.push(allocBlob); if (!syncId) syncId = allocBlob.synchronizerId; }
  }
  // Disclose the HtlcLock so the receiver can SEE it (they're NOT a static observer —
  // disclosure avoids needing their participant to vet our DAR). Fetch from ACS (the
  // tx-tree blob is empty) — this also gives us the real synchronizerId.
  if (!disclosed.some((d) => d.contractId === params.htlcCid)) {
    const htlcBlob = await fetchContractBlob(params.htlcCid, params.solverParty);
    if (htlcBlob) { disclosed.push(htlcBlob); if (!syncId) syncId = htlcBlob.synchronizerId; }
  }
  // Stamp the resolved synchronizerId on every disclosed contract that lacks one.
  for (const d of disclosed) if (!d.synchronizerId) d.synchronizerId = syncId;
  return { command, disclosedContracts: disclosed, synchronizerId: syncId };
}

/** Fetch a contract's createdEventBlob + templateId from the solver's ACS (for disclosure). */
async function fetchContractBlob(contractId: string, party: string): Promise<DisclosedContract | null> {
  const jwt = await getLedgerJwt();
  const endRes = await fetch(`${NETWORK.ledgerHost}/v2/state/ledger-end`, { headers: { Authorization: `Bearer ${jwt}` } });
  const offset = ((await endRes.json()) as { offset: number }).offset;
  const wildcard = { cumulative: [{ identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: true } } } }] };
  const r = await fetch(`${NETWORK.ledgerHost}/v2/state/active-contracts`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ filter: { filtersByParty: { [party]: wildcard } }, verbose: false, activeAtOffset: offset }),
  });
  if (!r.ok) return null;
  const entries = (await r.json()) as any[];
  for (const e of entries) {
    const ac = e?.contractEntry?.JsActiveContract;
    const c = ac?.createdEvent;
    if (c?.contractId === contractId) {
      // Capture the REAL synchronizerId — the Loop SDK needs it to route the submission.
      const synchronizerId = ac?.synchronizerId ?? c?.synchronizerId ?? "";
      return { templateId: c.templateId, contractId, createdEventBlob: c.createdEventBlob ?? "", synchronizerId };
    }
  }
  return null;
}

/**
 * TEST PATH — submit the Claim AS THE RECEIVER using the m2m JWT (which has
 * authority over every cbtc-user party hosted on this validator). This is the
 * receiver exercising HtlcLock.Claim (controller=receiver) — the same action the
 * user's Loop wallet does in production, but driven server-side when the receiver
 * party is local to our validator. Proves the on-ledger keccak check + Execute
 * Transfer fire. If the receiver is NOT local, this throws an authorization error
 * (and the real Loop-wallet path is required).
 */
export async function claimAsReceiver(params: {
  receiverParty: string;
  solverParty: string;
  htlcCid: string;
  htlcBlob?: string;
  allocationCid: string;
  preimageHex: string;
}): Promise<{ updateId: string }> {
  const jwt = await getLedgerJwt();
  const { command, disclosedContracts } = await prepareClaimCommand({
    htlcCid: params.htlcCid,
    htlcBlob: params.htlcBlob,
    allocationCid: params.allocationCid,
    solverParty: params.solverParty,
    preimageHex: params.preimageHex,
  });
  const { updateId } = await submit(jwt, [params.receiverParty], [command as unknown], disclosedContracts);
  console.log(`${TAG} HtlcLock.Claim by receiver — on-ledger keccak check passed, cBTC released. update ${updateId.slice(0, 16)}…`);
  return { updateId };
}

/** Refund path — after timelock, locker withdraws the Allocation via HtlcLock.Refund. */
export async function refundHtlcLock(params: {
  solverParty: string;
  htlcCid: string;
  allocationCid: string;
}): Promise<{ updateId: string }> {
  const jwt = await getLedgerJwt();
  const ctx = await allocationChoiceContext(params.allocationCid, "withdraw");
  const { updateId } = await submit(
    jwt,
    [params.solverParty],
    [{
      ExerciseCommand: {
        templateId: HTLC_TID,
        contractId: params.htlcCid,
        choice: "Refund",
        choiceArgument: { allocationContext: { context: ctx.data, meta: { values: {} } } },
      },
    }],
    ctx.disclosed,
  );
  return { updateId };
}

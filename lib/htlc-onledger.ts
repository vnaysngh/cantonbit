/**
 * ON-LEDGER CBTC HTLC (the real DAR path) — G1/G2.
 *
 * Drives our uploaded `cbtc-htlc` DAR (HtlcLock template) so the CBTC hash check
 * is enforced ON THE DAML LEDGER, not in the backend. Three steps:
 *
 *   1. allocate()   — lock the solver's CBTC in a Splice Allocation, naming the
 *                     SOLVER as executor (pre-delegation: sender+receiver consent
 *                     is granted to the executor at allocation creation, so the
 *                     executor fires Allocation_ExecuteTransfer ALONE — confirmed
 *                     in Splice AllocationV1 source lines 126-129).
 *   2. createHtlcLock() — wrap that Allocation in our HtlcLock (records hashLock,
 *                     unlockTime). The CBTC is now locked on-ledger.
 *   3. claimHtlcLock(preimage) — exercise HtlcLock.Claim. The DAML LEDGER checks
 *                     keccak256(preimage)==hashLock (CbtcHtlc.daml), then fires
 *                     Allocation_ExecuteTransfer → CBTC moves to the receiver and
 *                     the preimage is revealed on-ledger.
 *
 * Ported from the PROVEN swap-solver/src/probe-htlc-spike.mts + canton.ts allocate().
 */
import "server-only";

import { getLedgerJwt } from "./auth";
import { fetchCcRegistry, getDsoPartyId } from "./cc-registry";
import type { InstrumentId } from "./constants";
import { NETWORK } from "./constants";
import {
  AMULET_HOLDING_TEMPLATE_FQN,
  isAllocationContract,
  isPlainChangeOutput,
  pickAllocationCid
} from "./htlc-allocation-pick";
import type { Holding } from "./types";

const TAG = "[htlc-onledger]";

// Uploaded hardened cbtc-htlc DAR. This package MUST contain the amount and
// instrumentId fields added to HtlcLock; the older v0.1.4 package does not.
function htlcTemplateId(): string {
  const pkg = process.env.CBTC_HTLC_PKG_ID;
  if (!pkg) {
    throw new Error(
      "CBTC_HTLC_PKG_ID must be set to the hardened cbtc-htlc package id"
    );
  }
  return `${pkg}:CbtcHtlc:HtlcLock`;
}

const ALLOCATION_FACTORY_INTERFACE =
  "#splice-api-token-allocation-instruction-v1:Splice.Api.Token.AllocationInstructionV1:AllocationFactory";
const HOLDING_TEMPLATE_FQN =
  "8107899ac4723ce986bf7d27416534e576e54b92161e46150a595fb78ff3d3a1:Utility.Registry.Holding.V0.Holding:Holding";

function holdingDisclosedTemplateId(holding: Holding): string {
  if (holding.templateId) return holding.templateId;
  const id = (holding.payload as { instrumentId?: { id?: string } }).instrumentId?.id;
  return id === "Amulet" ? AMULET_HOLDING_TEMPLATE_FQN : HOLDING_TEMPLATE_FQN;
}

interface DisclosedContract {
  templateId: string;
  contractId: string;
  createdEventBlob: string;
  synchronizerId: string;
}

function reg(path: string, registrarAdmin: string = NETWORK.decentralizedPartyId): string {
  return `${NETWORK.registryUrl}/api/token-standard/v0/registrars/${registrarAdmin}${path}`;
}

function isAmuletInstrument(instrumentId?: InstrumentId): boolean {
  return instrumentId?.id === "Amulet";
}

async function fetchAllocationFactory(
  registrarAdmin: string,
  instrumentId: InstrumentId,
  body: string
): Promise<Response> {
  if (isAmuletInstrument(instrumentId)) {
    return fetchCcRegistry("/allocation-instruction/v1/allocation-factory", {
      method: "POST",
      body
    });
  }
  return fetch(reg(`/registry/allocation-instruction/v1/allocation-factory`, registrarAdmin), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    cache: "no-store"
  });
}

async function fetchAllocationChoiceContext(
  allocationCid: string,
  kind: "execute-transfer" | "withdraw",
  instrumentId?: InstrumentId
): Promise<Response> {
  if (isAmuletInstrument(instrumentId)) {
    return fetchCcRegistry(
      `/allocations/v1/${encodeURIComponent(allocationCid)}/choice-contexts/${kind}`,
      { method: "POST", body: JSON.stringify({}) }
    );
  }
  return fetch(
    reg(
      `/registry/allocations/v1/${encodeURIComponent(allocationCid)}/choice-contexts/${kind}`
    ),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    }
  );
}

async function submit(
  jwt: string,
  actAs: string[],
  commands: unknown[],
  disclosed: DisclosedContract[] = []
): Promise<{
  updateId: string;
  createdCids: string[];
  created: {
    contractId: string;
    templateId: string;
    createdEventBlob: string;
  }[];
  tree: any;
}> {
  const commandId =
    "htlc-" + Math.random().toString(16).slice(2) + Date.now().toString(16);
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
        applicationId: "cbtc-htlc",
        workflowId: `htlc-${commandId}`,
        commandId,
        actAs,
        readAs: actAs,
        commands,
        disclosedContracts: disclosed
      })
    }
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`submit failed (${res.status}): ${text}`);
  const tree = JSON.parse(text);
  const events = tree?.transactionTree?.eventsById ?? {};
  const createdCids: string[] = [];
  const created: {
    contractId: string;
    templateId: string;
    createdEventBlob: string;
  }[] = [];
  for (const ev of Object.values(events) as any[]) {
    const c = ev?.CreatedTreeEvent?.value;
    if (!c?.contractId) continue;
    const tpl = c.templateId ?? "";
    created.push({
      contractId: c.contractId,
      templateId: tpl,
      createdEventBlob: c.createdEventBlob ?? ""
    });
    if (!isPlainChangeOutput(tpl)) createdCids.push(c.contractId);
  }
  return {
    updateId: tree?.transactionTree?.updateId ?? "",
    createdCids,
    created,
    tree
  };
}

const ALLOCATION_INTERFACE =
  "#splice-api-token-allocation-v1:Splice.Api.Token.AllocationV1:Allocation";

/**
 * CLEANUP — withdraw an Allocation directly (Allocation_Withdraw, sender-alone).
 * For orphaned allocations (no HtlcLock) left by a failed/retried lock. Returns the
 * solver's CBTC to the solver. Safe: sender-only, no receiver co-sign needed.
 */
export async function withdrawAllocation(
  solverParty: string,
  allocationCid: string
): Promise<{ updateId: string }> {
  const jwt = await getLedgerJwt();
  const ctx = await allocationChoiceContext(allocationCid, "withdraw");
  const { updateId } = await submit(
    jwt,
    [solverParty],
    [
      {
        ExerciseCommand: {
          templateId: ALLOCATION_INTERFACE,
          contractId: allocationCid,
          choice: "Allocation_Withdraw",
          choiceArgument: {
            extraArgs: { context: ctx.data, meta: { values: {} } }
          }
        }
      }
    ],
    ctx.disclosed
  );
  console.log(
    `${TAG} withdrew orphan allocation ${allocationCid.slice(0, 16)}… → CBTC recovered. update ${updateId.slice(0, 16)}…`
  );
  return { updateId };
}

/** List the solver's active Allocation contract ids (to find orphans to clean up). */
export async function listSolverAllocations(
  solverParty: string
): Promise<string[]> {
  const jwt = await getLedgerJwt();
  const endRes = await fetch(`${NETWORK.ledgerHost}/v2/state/ledger-end`, {
    headers: { Authorization: `Bearer ${jwt}` }
  });
  const offset = ((await endRes.json()) as { offset: number }).offset;
  const wildcard = {
    cumulative: [
      {
        identifierFilter: {
          WildcardFilter: { value: { includeCreatedEventBlob: false } }
        }
      }
    ]
  };
  const r = await fetch(`${NETWORK.ledgerHost}/v2/state/active-contracts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`
    },
    body: JSON.stringify({
      filter: { filtersByParty: { [solverParty]: wildcard } },
      verbose: false,
      activeAtOffset: offset
    })
  });
  if (!r.ok) return [];
  const entries = (await r.json()) as any[];
  const out: string[] = [];
  for (const e of entries) {
    const c = e?.contractEntry?.JsActiveContract?.createdEvent;
    const tpl = c?.templateId ?? "";
    // Allocation template path contains "Allocation:DvpLegAllocation" (not plain Holding).
    if (c?.contractId && /Allocation/i.test(tpl) && !/:Holding$/.test(tpl))
      out.push(c.contractId);
  }
  return out;
}

/** Registry choice-context for an Allocation lifecycle choice. */
async function allocationChoiceContext(
  allocationCid: string,
  kind: "execute-transfer" | "withdraw",
  instrumentId?: InstrumentId
): Promise<{ data: unknown; disclosed: DisclosedContract[] }> {
  const r = await fetchAllocationChoiceContext(allocationCid, kind, instrumentId);
  if (!r.ok)
    throw new Error(
      `choice-context ${kind} failed (${r.status}): ${await r.text()}`
    );
  const ctx = (await r.json()) as {
    choiceContextData: unknown;
    disclosedContracts: DisclosedContract[];
  };
  return {
    data: ctx.choiceContextData,
    disclosed: (ctx.disclosedContracts ?? []).map((d) => ({
      ...d,
      synchronizerId: d.synchronizerId ?? ""
    }))
  };
}

/** STEP 1 — lock CBTC in an Allocation.
 *  EVM→Canton (default): solver = sender = executor (locks its own float).
 *  Canton→EVM (reverse): senderParty = the USER's hosted party (backend CanActAs
 *  signs as them — platform auto-lock); executor stays the solver so
 *  ExecuteTransfer's receiver+executor authorizers are BOTH the solver (it claims
 *  alone after the on-ledger keccak gate). */
export async function allocate(params: {
  solverParty: string;
  receiverParty: string;
  amountBtc: string;
  inputHoldings: Holding[];
  inputHoldingCids: string[];
  settlementId: string;
  settleBefore: Date;
  allocateBefore: Date;
  /** transferLeg.sender + actAs party. Defaults to solverParty (forward direction). */
  senderParty?: string;
  /** Defaults to CBTC on this network. */
  instrumentId?: InstrumentId;
}): Promise<{ updateId: string; allocationCid: string }> {
  const sender = params.senderParty ?? params.solverParty;
  const instrumentId = params.instrumentId ?? NETWORK.instrumentId;
  const registrarAdmin = isAmuletInstrument(instrumentId)
    ? await getDsoPartyId()
    : instrumentId.admin;
  const jwt = await getLedgerJwt();
  const now = new Date().toISOString();
  const allocation = {
    settlement: {
      executor: params.solverParty,
      settlementRef: { id: params.settlementId, cid: null },
      requestedAt: now,
      allocateBefore: params.allocateBefore.toISOString(),
      settleBefore: params.settleBefore.toISOString(),
      meta: { values: {} }
    },
    transferLegId: "leg-0",
    transferLeg: {
      sender,
      receiver: params.receiverParty,
      amount: params.amountBtc,
      instrumentId,
      meta: { values: {} }
    }
  };

  const factoryBody = JSON.stringify({
    choiceArguments: {
      expectedAdmin: registrarAdmin,
      allocation,
      requestedAt: now,
      inputHoldingCids: params.inputHoldingCids,
      extraArgs: { context: { values: {} }, meta: { values: {} } }
    }
  });
  const factoryRes = await fetchAllocationFactory(
    registrarAdmin,
    instrumentId,
    factoryBody
  );
  if (!factoryRes.ok)
    throw new Error(
      `AllocationFactory failed (${factoryRes.status}): ${await factoryRes.text()}`
    );
  const factory = (await factoryRes.json()) as {
    factoryId: string;
    choiceContext: {
      choiceContextData: unknown;
      disclosedContracts: DisclosedContract[];
    };
  };

  const disclosed: DisclosedContract[] = [
    ...factory.choiceContext.disclosedContracts.map((dc) => ({
      ...dc,
      synchronizerId: dc.synchronizerId ?? ""
    })),
    ...params.inputHoldings
      .filter((h) => params.inputHoldingCids.includes(h.contractId))
      .map((h) => ({
        templateId: holdingDisclosedTemplateId(h),
        contractId: h.contractId,
        createdEventBlob: h.createdEventBlob ?? "",
        synchronizerId: ""
      }))
  ];

  const { updateId, created } = await submit(
    jwt,
    [sender], // sender authority locks the holdings (CanActAs covers hosted users)
    [
      {
        ExerciseCommand: {
          templateId: ALLOCATION_FACTORY_INTERFACE,
          contractId: factory.factoryId,
          choice: "AllocationFactory_Allocate",
          choiceArgument: {
            expectedAdmin: registrarAdmin,
            allocation,
            requestedAt: now,
            inputHoldingCids: params.inputHoldingCids,
            extraArgs: {
              context: factory.choiceContext.choiceContextData,
              meta: { values: {} }
            }
          }
        }
      }
    ],
    disclosed
  );
  const allocationCid = pickAllocationCid(created);
  if (!allocationCid) throw new Error("allocate: no Allocation created");
  console.log(
    `${TAG} allocated ${params.amountBtc} ${instrumentId.id} → alloc ${allocationCid.slice(0, 20)}…`
  );
  return { updateId, allocationCid };
}

/** STEP 2 — wrap the Allocation in our HtlcLock (records hashLock + timelock).
 *  Reverse direction (Canton→EVM): lockerParty = the USER's hosted party (signatory;
 *  backend CanActAs signs the create) — executor stays the solver. */
export async function createHtlcLock(params: {
  solverParty: string;
  receiverParty: string;
  allocationCid: string;
  amountBtc: string;
  hashLock: string; // lowercase hex, no 0x — keccak256 of the preimage hex
  unlockTime: Date;
  /** HtlcLock.locker + actAs party. Defaults to solverParty (forward direction). */
  lockerParty?: string;
  /** Defaults to CBTC on this network. */
  instrumentId?: InstrumentId;
}): Promise<{ htlcCid: string; htlcBlob: string }> {
  const locker = params.lockerParty ?? params.solverParty;
  const instrumentId = params.instrumentId ?? NETWORK.instrumentId;
  const jwt = await getLedgerJwt();
  const { created } = await submit(
    jwt,
    [locker],
    [
      {
        CreateCommand: {
          templateId: htlcTemplateId(),
          createArguments: {
            locker,
            receiver: params.receiverParty,
            executor: params.solverParty,
            allocationCid: params.allocationCid,
            amount: params.amountBtc,
            instrumentId,
            hashLock: params.hashLock.startsWith("0x")
              ? params.hashLock.slice(2)
              : params.hashLock,
            unlockTime: params.unlockTime.toISOString()
          }
        }
      }
    ]
  );
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
  instrumentId?: InstrumentId;
}): Promise<{
  command: unknown;
  disclosedContracts: DisclosedContract[];
  synchronizerId: string;
}> {
  const ctx = await allocationChoiceContext(
    params.allocationCid,
    "execute-transfer",
    params.instrumentId
  );
  const preimage = params.preimageHex.startsWith("0x")
    ? params.preimageHex.slice(2)
    : params.preimageHex;
  const command = {
    ExerciseCommand: {
      templateId: htlcTemplateId(),
      contractId: params.htlcCid,
      choice: "Claim",
      choiceArgument: {
        preimage,
        allocationContext: { context: ctx.data, meta: { values: {} } }
      }
    }
  };
  // The receiver must SEE both the HtlcLock and the Allocation (which Claim fetches).
  // The HtlcLock they observe comes from the hardened CBTC_HTLC_PKG_ID DAR. The Allocation is
  // disclosed via the registry choice-context — but if the receiver still can't read
  // it (created by the solver, receiver reading at a different offset), disclose it
  // explicitly from the solver's ACS.
  const disclosed = [...ctx.disclosed];
  // The synchronizer the contracts live on — the Loop SDK NEEDS this to route the
  // submission and resolve the disclosed templates (without it → TEMPLATES_NOT_FOUND).
  let syncId = disclosed.find((d) => d.synchronizerId)?.synchronizerId ?? "";
  const hasAlloc = disclosed.some((d) => d.contractId === params.allocationCid);
  if (!hasAlloc) {
    const allocBlob = await fetchContractBlob(
      params.allocationCid,
      params.solverParty
    );
    if (allocBlob) {
      disclosed.push(allocBlob);
      if (!syncId) syncId = allocBlob.synchronizerId;
    }
  }
  // Disclose the HtlcLock so the receiver can SEE it (they're NOT a static observer —
  // disclosure avoids needing their participant to vet our DAR). Fetch from ACS (the
  // tx-tree blob is empty) — this also gives us the real synchronizerId.
  if (!disclosed.some((d) => d.contractId === params.htlcCid)) {
    const htlcBlob = await fetchContractBlob(
      params.htlcCid,
      params.solverParty
    );
    if (htlcBlob) {
      disclosed.push(htlcBlob);
      if (!syncId) syncId = htlcBlob.synchronizerId;
    }
  }
  // Stamp the resolved synchronizerId on every disclosed contract that lacks one.
  for (const d of disclosed) if (!d.synchronizerId) d.synchronizerId = syncId;
  return { command, disclosedContracts: disclosed, synchronizerId: syncId };
}

/** Fetch a contract's createdEventBlob + templateId from the solver's ACS (for disclosure). */
async function fetchContractBlob(
  contractId: string,
  party: string
): Promise<DisclosedContract | null> {
  const jwt = await getLedgerJwt();
  const endRes = await fetch(`${NETWORK.ledgerHost}/v2/state/ledger-end`, {
    headers: { Authorization: `Bearer ${jwt}` }
  });
  const offset = ((await endRes.json()) as { offset: number }).offset;
  const wildcard = {
    cumulative: [
      {
        identifierFilter: {
          WildcardFilter: { value: { includeCreatedEventBlob: true } }
        }
      }
    ]
  };
  const r = await fetch(`${NETWORK.ledgerHost}/v2/state/active-contracts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`
    },
    body: JSON.stringify({
      filter: { filtersByParty: { [party]: wildcard } },
      verbose: false,
      activeAtOffset: offset
    })
  });
  if (!r.ok) return null;
  const entries = (await r.json()) as any[];
  for (const e of entries) {
    const ac = e?.contractEntry?.JsActiveContract;
    const c = ac?.createdEvent;
    if (c?.contractId === contractId) {
      // Capture the REAL synchronizerId — the Loop SDK needs it to route the submission.
      const synchronizerId = ac?.synchronizerId ?? c?.synchronizerId ?? "";
      return {
        templateId: c.templateId,
        contractId,
        createdEventBlob: c.createdEventBlob ?? "",
        synchronizerId
      };
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
  instrumentId?: InstrumentId;
}): Promise<{ updateId: string }> {
  const jwt = await getLedgerJwt();
  const { command, disclosedContracts } = await prepareClaimCommand({
    htlcCid: params.htlcCid,
    htlcBlob: params.htlcBlob,
    allocationCid: params.allocationCid,
    solverParty: params.solverParty,
    preimageHex: params.preimageHex,
    instrumentId: params.instrumentId
  });
  const { updateId } = await submit(
    jwt,
    [params.receiverParty],
    [command as unknown],
    disclosedContracts
  );
  console.log(
    `${TAG} HtlcLock.Claim by receiver — on-ledger keccak check passed, CBTC released. update ${updateId.slice(0, 16)}…`
  );
  return { updateId };
}

// ===================== LOOP SELLERS (canton-to-evm, external wallet) =====================
// The Loop user locks their CBTC via the STANDARD AllocationFactory_Allocate signed in
// THEIR wallet (sender=user, receiver=executor=solver, settleBefore=long timelock).
// No custom contract ever touches the Loop party. The solver later executes the
// allocation (receiver+executor = solver alone — the proven authority shape), and the
// user's unilateral exit is the standard Allocation_Withdraw (sender-alone).

/** Build the standard AllocationFactory_Allocate command for a LOOP user to sign in
 *  their own wallet. Returns {command, disclosedContracts, synchronizerId} for
 *  provider.submitAndWaitForTransaction. The user's input holdings live on THEIR
 *  participant (no disclosure needed for them); the registry's rule/config contracts
 *  are disclosed via the factory choice-context. */
export async function prepareAllocateCommand(params: {
  senderParty: string; // the Loop user (locks their CBTC)
  solverParty: string; // receiver AND executor
  amountBtc: string;
  inputHoldingCids: string[]; // read in the BROWSER via provider.getActiveContracts
  settlementId: string;
  settleBefore: Date;
  allocateBefore: Date;
  /** Defaults to CBTC on this network. */
  instrumentId?: InstrumentId;
}): Promise<{
  command: unknown;
  disclosedContracts: DisclosedContract[];
  synchronizerId: string;
}> {
  const instrumentId = params.instrumentId ?? NETWORK.instrumentId;
  const registrarAdmin = instrumentId.admin;
  const now = new Date().toISOString();
  const allocation = {
    settlement: {
      executor: params.solverParty,
      settlementRef: { id: params.settlementId, cid: null },
      requestedAt: now,
      allocateBefore: params.allocateBefore.toISOString(),
      settleBefore: params.settleBefore.toISOString(),
      meta: { values: {} }
    },
    transferLegId: "leg-0",
    transferLeg: {
      sender: params.senderParty,
      receiver: params.solverParty,
      amount: params.amountBtc,
      instrumentId,
      meta: { values: {} }
    }
  };
  const factoryRes = await fetch(
    reg(`/registry/allocation-instruction/v1/allocation-factory`, registrarAdmin),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        choiceArguments: {
          expectedAdmin: registrarAdmin,
          allocation,
          requestedAt: now,
          inputHoldingCids: params.inputHoldingCids,
          extraArgs: { context: { values: {} }, meta: { values: {} } }
        }
      })
    }
  );
  if (!factoryRes.ok)
    throw new Error(
      `AllocationFactory failed (${factoryRes.status}): ${await factoryRes.text()}`
    );
  const factory = (await factoryRes.json()) as {
    factoryId: string;
    choiceContext: {
      choiceContextData: unknown;
      disclosedContracts: DisclosedContract[];
    };
  };
  const disclosedContracts = factory.choiceContext.disclosedContracts.map(
    (dc) => ({
      ...dc,
      synchronizerId: dc.synchronizerId ?? ""
    })
  );
  const synchronizerId =
    disclosedContracts.find((d) => d.synchronizerId)?.synchronizerId ?? "";
  const command = {
    ExerciseCommand: {
      templateId: ALLOCATION_FACTORY_INTERFACE,
      contractId: factory.factoryId,
      choice: "AllocationFactory_Allocate",
      choiceArgument: {
        expectedAdmin: registrarAdmin,
        allocation,
        requestedAt: now,
        inputHoldingCids: params.inputHoldingCids,
        extraArgs: {
          context: factory.choiceContext.choiceContextData,
          meta: { values: {} }
        }
      }
    }
  };
  return { command, disclosedContracts, synchronizerId };
}

/** VERIFY-then-trust: find the Loop user's allocation in the SOLVER's own ACS (the
 *  solver is receiver+executor → stakeholder → sees it) and check its terms match
 *  the order. Returns the cid, or null if absent/mismatched (with the reason). */
export async function findAllocationBySettlement(params: {
  solverParty: string;
  settlementId: string;
  senderParty: string;
  minAmountBtc: string;
  minSettleBefore: Date; // must cover the order's long timelock
}): Promise<{ cid: string } | { cid: null; reason: string }> {
  const jwt = await getLedgerJwt();
  const endRes = await fetch(`${NETWORK.ledgerHost}/v2/state/ledger-end`, {
    headers: { Authorization: `Bearer ${jwt}` }
  });
  const offset = ((await endRes.json()) as { offset: number }).offset;
  const wildcard = {
    cumulative: [
      {
        identifierFilter: {
          WildcardFilter: { value: { includeCreatedEventBlob: false } }
        }
      }
    ]
  };
  const r = await fetch(`${NETWORK.ledgerHost}/v2/state/active-contracts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`
    },
    body: JSON.stringify({
      filter: { filtersByParty: { [params.solverParty]: wildcard } },
      verbose: false,
      activeAtOffset: offset
    })
  });
  if (!r.ok) return { cid: null, reason: `ACS read failed (${r.status})` };
  const entries = (await r.json()) as any[];
  for (const e of entries) {
    const c = e?.contractEntry?.JsActiveContract?.createdEvent;
    const tpl = c?.templateId ?? "";
    if (!c?.contractId || !isAllocationContract(tpl)) continue;
    const a = c.createArgument ?? {};
    const settlement = a.settlement ?? a.allocation?.settlement;
    const leg = a.transferLeg ?? a.allocation?.transferLeg;
    if (settlement?.settlementRef?.id !== params.settlementId) continue;
    // Terms check — the user signed OUR prepared command, but verify on-ledger anyway.
    if (leg?.sender !== params.senderParty)
      return { cid: null, reason: "allocation sender mismatch" };
    if (leg?.receiver !== params.solverParty)
      return { cid: null, reason: "allocation receiver is not the solver" };
    if (settlement?.executor !== params.solverParty)
      return { cid: null, reason: "allocation executor is not the solver" };
    if (parseFloat(leg?.amount ?? "0") + 1e-9 < parseFloat(params.minAmountBtc))
      return {
        cid: null,
        reason: `allocation amount too small (${leg?.amount})`
      };
    if (
      new Date(settlement?.settleBefore ?? 0).getTime() <
      params.minSettleBefore.getTime()
    ) {
      return {
        cid: null,
        reason: "allocation settleBefore is earlier than the order timelock"
      };
    }
    return { cid: c.contractId };
  }
  return { cid: null, reason: "allocation not found yet" };
}

/** LOOP-SELLER claim — the solver executes the user's allocation directly
 *  (Allocation_ExecuteTransfer; receiver+executor = solver ALONE — proven shape).
 *  No on-ledger hash gate here (standard allocation); the orchestrator validates the
 *  revealed preimage before calling this (custody-ordering, same trust as delivery). */
export async function executeAllocationAsSolver(params: {
  solverParty: string;
  allocationCid: string;
}): Promise<{ updateId: string }> {
  const jwt = await getLedgerJwt();
  const ctx = await allocationChoiceContext(
    params.allocationCid,
    "execute-transfer"
  );
  const ALLOCATION_INTERFACE =
    "#splice-api-token-allocation-v1:Splice.Api.Token.AllocationV1:Allocation";
  const { updateId } = await submit(
    jwt,
    [params.solverParty],
    [
      {
        ExerciseCommand: {
          templateId: ALLOCATION_INTERFACE,
          contractId: params.allocationCid,
          choice: "Allocation_ExecuteTransfer",
          choiceArgument: {
            extraArgs: { context: ctx.data, meta: { values: {} } }
          }
        }
      }
    ],
    ctx.disclosed
  );
  return { updateId };
}

/** LOOP-SELLER refund — prepare the standard Allocation_Withdraw for the USER to
 *  sign in their wallet (sender-alone, their unilateral on-ledger exit). */
export async function prepareWithdrawCommand(params: {
  allocationCid: string;
}): Promise<{
  command: unknown;
  disclosedContracts: DisclosedContract[];
  synchronizerId: string;
}> {
  const ctx = await allocationChoiceContext(params.allocationCid, "withdraw");
  const synchronizerId =
    ctx.disclosed.find((d) => d.synchronizerId)?.synchronizerId ?? "";
  return {
    command: {
      ExerciseCommand: {
        templateId:
          "#splice-api-token-allocation-v1:Splice.Api.Token.AllocationV1:Allocation",
        contractId: params.allocationCid,
        choice: "Allocation_Withdraw",
        choiceArgument: {
          extraArgs: { context: ctx.data, meta: { values: {} } }
        }
      }
    },
    disclosedContracts: ctx.disclosed,
    synchronizerId
  };
}

/** Refund path — after timelock, the LOCKER withdraws the Allocation via
 *  HtlcLock.Refund. Reverse direction: lockerParty = the user's hosted party
 *  (backend CanActAs); defaults to the solver (forward direction). */
export async function refundHtlcLock(params: {
  solverParty: string;
  htlcCid: string;
  allocationCid: string;
  lockerParty?: string;
  instrumentId?: InstrumentId;
}): Promise<{ updateId: string }> {
  const jwt = await getLedgerJwt();
  const ctx = await allocationChoiceContext(
    params.allocationCid,
    "withdraw",
    params.instrumentId
  );
  const { updateId } = await submit(
    jwt,
    [params.lockerParty ?? params.solverParty],
    [
      {
        ExerciseCommand: {
          templateId: htlcTemplateId(),
          contractId: params.htlcCid,
          choice: "Refund",
          choiceArgument: {
            allocationContext: { context: ctx.data, meta: { values: {} } }
          }
        }
      }
    ],
    ctx.disclosed
  );
  return { updateId };
}

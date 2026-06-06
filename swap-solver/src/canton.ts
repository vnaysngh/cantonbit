/**
 * Solver-local Canton client.
 *
 * A self-contained, minimal port of the proven flow in the Oranj app's
 * `lib/transfer.ts` + `lib/auth.ts`. We duplicate (rather than import) because
 * those modules are `server-only` (Next.js) and the solver is a standalone
 * process. SOURCE OF TRUTH for the transfer/registry semantics is
 * ../../lib/transfer.ts — keep this in sync if that flow changes.
 *
 * Scope for Task 7a: JWT, a holdings reader (float check), and Phase-1
 * createTransfer (offer creation). Phase-2 accept is the EXTERNAL USER's job
 * (Task 7b watches for it).
 */

import { randomUUID } from "node:crypto";

import { retry } from "./retry.js";

/** The subset of Canton network config the solver needs. */
export interface CantonConfig {
  ledgerHost: string;
  registryUrl: string;
  decentralizedPartyId: string;
  instrumentId: { admin: string; id: string };
  /** The solver's own cBTC party (the float). */
  solverParty: string;
}

/** Authentik client-credentials env (same vars the Oranj app uses). */
export interface CantonAuthEnv {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
}

// --- JWT (port of lib/auth.ts, simplified: cache in-memory) ---

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}
const REFRESH_BUFFER_MS = 60_000;

export class CantonClient {
  private cfg: CantonConfig;
  private auth: CantonAuthEnv;
  private cached: CachedToken | null = null;
  private inflight: Promise<CachedToken> | null = null;

  constructor(cfg: CantonConfig, auth: CantonAuthEnv) {
    this.cfg = cfg;
    this.auth = auth;
  }

  /** The solver's own cBTC party (the float source). */
  get solverParty(): string {
    return this.cfg.solverParty;
  }

  private async getJwt(): Promise<string> {
    const now = Date.now();
    if (this.cached && this.cached.expiresAt - now > REFRESH_BUFFER_MS) {
      return this.cached.accessToken;
    }
    if (!this.inflight) {
      this.inflight = this.fetchToken().then((t) => {
        this.cached = t;
        return t;
      }).finally(() => {
        this.inflight = null;
      });
    }
    return (await this.inflight).accessToken;
  }

  private async fetchToken(): Promise<CachedToken> {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.auth.clientId,
      client_secret: this.auth.clientSecret,
      scope: this.auth.scope,
    });
    const res = await fetch(this.auth.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "<no body>");
      throw new Error(`Authentik token request failed (${res.status}): ${text}`);
    }
    const data = (await res.json()) as { access_token: string; expires_in: number };
    return {
      accessToken: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
  }

  // --- Float check: total cBTC the solver party can spend ---

  /**
   * Sum of the solver party's spendable cBTC holdings, in satoshis (bigint).
   * Used to refuse delivery when the float is insufficient (never half-deliver).
   */
  /**
   * Spendable cBTC float = sum of UNLOCKED holdings only. Locked holdings (e.g.
   * allocated to an in-flight settlement) are excluded — counting them would
   * over-report the float and let the solver try to spend the same cBTC twice.
   */
  async getFloatSats(): Promise<bigint> {
    const holdings = await this.getHoldings(this.cfg.solverParty);
    let total = 0n;
    for (const h of holdings) {
      if (h.locked) continue; // exclude locked-in-allocation holdings
      total += btcStringToSats(h.amount);
    }
    return total;
  }

  /** Only the spendable (unlocked) holdings — for transfer/allocate inputs. */
  async getSpendableHoldings(party: string): Promise<HoldingLite[]> {
    return (await this.getHoldings(party)).filter((h) => !h.locked);
  }

  /** Holdings (contractId + amount + blob) owned by `party`. Minimal shape. */
  async getHoldings(party: string): Promise<HoldingLite[]> {
    const jwt = await this.getJwt();
    const offset = await this.getLedgerEnd(jwt);

    const res = await fetch(`${this.cfg.ledgerHost}/v2/state/active-contracts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({
        filter: {
          filtersByParty: {
            [party]: {
              cumulative: [
                {
                  identifierFilter: {
                    InterfaceFilter: {
                      value: {
                        interfaceId:
                          "#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding",
                        includeInterfaceView: true,
                        includeCreatedEventBlob: true,
                      },
                    },
                  },
                },
              ],
            },
          },
        },
        verbose: false,
        activeAtOffset: offset,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "<no body>");
      throw new Error(`getHoldings ACS query failed (${res.status}): ${text}`);
    }
    const raw = (await res.json()) as unknown[];
    const out: HoldingLite[] = [];
    const nowIso = new Date().toISOString();
    for (const entry of raw) {
      const ev = (entry as ActiveContractEntry).contractEntry?.JsActiveContract?.createdEvent;
      if (!ev?.contractId) continue;

      // Only cBTC holdings (the splice Utility.Registry Holding template) — NOT
      // Canton Coin / Amulet, which also surface under the Holding interface.
      const tpl = ev.templateId ?? "";
      if (!tpl.includes("Utility.Registry.Holding")) continue;

      // Amount + owner: prefer the rendered interface view (matches the Oranj
      // app's getHoldings), but fall back to createArgument when the view can't
      // render. On DevNet the view currently fails with
      // NOT_CONNECTED_TO_ANY_SYNCHRONIZER (viewStatus.code set, viewValue null);
      // createArgument still carries amount/owner, so we read it as the fallback.
      const iv = ev.interfaceViews?.[0];
      const view = (iv && !iv.viewStatus?.code ? iv.viewValue : undefined) as
        | { amount?: string; owner?: string; lock?: HoldingLock | null }
        | undefined;
      const arg = ev.createArgument as
        | { amount?: string; owner?: string; lock?: HoldingLock | null }
        | undefined;

      const amount = view?.amount ?? arg?.amount;
      const owner = view?.owner ?? arg?.owner;
      if (!amount) continue;
      if (owner && owner !== party) continue;

      // Read the lock from whichever source rendered (view preferred, arg
      // fallback) — a locked holding is unspendable and must be flagged so it's
      // excluded from float/transfer/allocate inputs.
      const lock = view?.lock ?? arg?.lock ?? null;
      const locked = isActivelyLocked(lock, nowIso);

      out.push({
        contractId: ev.contractId,
        amount,
        createdEventBlob: ev.createdEventBlob ?? "",
        locked,
      });
    }
    return out;
  }

  private async getLedgerEnd(jwt: string): Promise<number> {
    // Read-only + idempotent → safe to retry on transient RPC/network blips.
    return retry(async () => {
      const res = await fetch(`${this.cfg.ledgerHost}/v2/state/ledger-end`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      if (!res.ok) throw new Error(`getLedgerEnd failed (${res.status})`);
      const { offset } = (await res.json()) as { offset: number };
      return offset;
    }, { label: "getLedgerEnd" });
  }

  /**
   * Has the receiver ACCEPTED the delivery for these locked input holdings?
   * Detected from the SOLVER's own ACS (sender-readable, no 403): while the offer
   * is pending, a TransferInstruction / locked Holding for these inputs is in our
   * active contracts; once accepted (or rejected), it disappears. This is the
   * reliable accept signal — we cannot read the receiver's offer set directly.
   * Returns true only when we can confirm the pending transfer is gone.
   */
  async isDeliveryAccepted(inputHoldingCids: string[]): Promise<boolean> {
    const { pending } = await this.floatHasPendingTransfer(inputHoldingCids);
    return !pending;
  }

  // --- Phase 1: create the cBTC transfer offer (solver float → user party) ---

  /**
   * Port of lib/transfer.ts createTransfer (Phase 1 only). Creates a
   * TransferInstruction offer from the solver party to `receiverParty`. The
   * external user accepts it later (Task 7b). Returns the offer contract id +
   * the updateId of the create transaction.
   */
  async createOffer(params: {
    receiverParty: string;
    amountBtc: string;
    inputHoldings: HoldingLite[];
    /**
     * Deterministic command id for LEDGER-ENFORCED dedup. Pass a stable id keyed
     * by the swap (e.g. `deliver-<orderId>`). Two submissions with the same
     * (actAs, userId, commandId) inside the dedup window are rejected by Canton
     * (DUPLICATE_COMMAND / SUBMISSION_ALREADY_IN_FLIGHT) — the ledger guarantees
     * at-most-once delivery, the same way CoW's filledAmount / UniswapX's Permit2
     * nonce do on the EVM. Falls back to a random UUID if omitted (no dedup).
     */
    commandId?: string;
  }): Promise<{ updateId: string; offerContractId: string; autoAccepted: boolean; inputHoldingCids: string[] }> {
    const jwt = await this.getJwt();
    const now = new Date().toISOString();
    const executeBefore = new Date(Date.now() + TRANSFER_TTL_MS).toISOString();

    // Never fund from a locked holding — exclude them before selection.
    const picked = selectHoldings(
      params.inputHoldings.filter((h) => !h.locked),
      params.amountBtc,
    );
    const inputHoldingCids = picked.map((h) => h.contractId);

    // Registry: fetch the TransferFactory + disclosed contracts.
    const registryUrl = `${this.cfg.registryUrl}/api/token-standard/v0/registrars/${this.cfg.decentralizedPartyId}/registry/transfer-instruction/v1/transfer-factory`;
    const transferArgs = {
      sender: this.cfg.solverParty,
      receiver: params.receiverParty,
      amount: params.amountBtc,
      instrumentId: this.cfg.instrumentId,
      lock: null,
      requestedAt: now,
      executeBefore,
      inputHoldingCids,
      meta: { values: {} },
    };
    const factoryRes = await fetch(registryUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        choiceArguments: {
          expectedAdmin: this.cfg.decentralizedPartyId,
          transfer: transferArgs,
          extraArgs: { context: { values: {} }, meta: { values: {} } },
        },
      }),
    });
    if (!factoryRes.ok) {
      const text = await factoryRes.text().catch(() => "<no body>");
      throw new Error(`TransferFactory registry call failed (${factoryRes.status}): ${text}`);
    }
    const factory = (await factoryRes.json()) as TransferFactoryResponse;

    // Submit TransferFactory_Transfer as the solver (sender).
    // LEDGER-ENFORCED DEDUP: a deterministic commandId (keyed by the swap) makes
    // Canton reject a concurrent/repeat delivery of the SAME order with the same
    // change id — the chain-level guard, like CoW's filledAmount. Random fallback
    // only for callers that don't pass one (e.g. ad-hoc tests).
    const commandId = params.commandId ?? randomUUID();
    const disclosed: DisclosedContract[] = [
      ...factory.choiceContext.disclosedContracts.map((dc) => ({
        ...dc,
        synchronizerId: dc.synchronizerId ?? "",
      })),
      ...picked.map((h) => ({
        templateId: HOLDING_TEMPLATE_FQN,
        contractId: h.contractId,
        createdEventBlob: h.createdEventBlob,
        synchronizerId: "",
      })),
    ];

    const submitRes = await fetch(
      `${this.cfg.ledgerHost}/v2/commands/submit-and-wait-for-transaction-tree`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({
          applicationId: "cbtc-app",
          workflowId: `swap-transfer-${commandId}`,
          commandId,
          // LEDGER-ENFORCED at-most-once (the CoW-aligned, chain-level guard):
          //  (1) deterministic commandId → Canton rejects a same-change-id
          //      submission already in-flight (SUBMISSION_ALREADY_IN_FLIGHT).
          //  (2) STRONGER, intrinsic: this transfer exercises a CONSUMING choice
          //      that archives the input holdings, so a duplicate that reaches
          //      the ledger is rejected with CONTRACT_NOT_ACTIVE (a contract can
          //      be archived at most once) — Canton's docs guarantee this with no
          //      configuration. This is our equivalent of CoW's filledAmount.
          // NOTE: an explicit `deduplicationPeriod` is intentionally omitted until
          // its exact JSON-Ledger-API-v2 shape is verified — (1)+(2) already give
          // at-most-once; shipping an unverified field could break every delivery.
          actAs: [this.cfg.solverParty],
          readAs: [this.cfg.solverParty],
          commands: [
            {
              ExerciseCommand: {
                templateId: TRANSFER_FACTORY_INTERFACE,
                contractId: factory.factoryId,
                choice: "TransferFactory_Transfer",
                choiceArgument: {
                  expectedAdmin: this.cfg.decentralizedPartyId,
                  transfer: transferArgs,
                  extraArgs: {
                    context: factory.choiceContext.choiceContextData,
                    meta: { values: {} },
                  },
                },
              },
            },
          ],
          disclosedContracts: disclosed,
        }),
      },
    );
    if (!submitRes.ok) {
      const text = await submitRes.text().catch(() => "<no body>");
      throw new Error(`TransferFactory_Transfer submit failed (${submitRes.status}): ${text}`);
    }
    const submitJson = (await submitRes.json()) as {
      transactionTree?: { updateId: string };
    };
    const updateId = submitJson.transactionTree?.updateId ?? "";

    // Decide whether the offer is PENDING (awaiting accept) or was AUTO-ACCEPTED
    // (consumed instantly by the receiver's wallet).
    //
    // We CANNOT infer this from the receiver's offer set alone: our m2m token
    // often cannot read the receiver's party (it lives on another participant →
    // 403). "Can't read the offer" must NOT be confused with "offer was
    // auto-accepted" — that's a correctness bug that releases the WBTC before the
    // cBTC is really accepted.
    //
    // Decide PENDING vs AUTO-ACCEPTED. We CANNOT infer this from the receiver's
    // offer set — our m2m token usually can't read the receiver's party (403),
    // and "can't read" must never be confused with "auto-accepted" (that bug
    // releases WBTC before the cBTC is accepted).
    //
    // The authoritative, solver-readable signal is the TransferInstruction
    // contract: in the Canton token standard the SENDER (our float) is a
    // stakeholder, so a pending instruction appears in OUR OWN active contracts
    // and disappears once the receiver accepts/rejects. (Confirmed against the
    // Loop SDK server docs + the live mainnet ledger.) A locked cBTC holding is
    // a corroborating secondary signal.
    const found = await this.findOfferForInputs(params.receiverParty, inputHoldingCids);
    if (found.kind === "found") {
      // We can see the pending offer directly → definitely pending.
      return { updateId, offerContractId: found.contractId, autoAccepted: false, inputHoldingCids };
    }
    const pending = await this.floatHasPendingTransfer(inputHoldingCids);
    return { updateId, offerContractId: pending.cid ?? "", autoAccepted: !pending.pending, inputHoldingCids };
  }

  // --- Allocation (cBTC escrow) — lock / release / refund ----------------------
  // Mirrors createOffer exactly (same registry-factory → submit pattern). The
  // ONLY difference is the choice (AllocationFactory_Allocate) and the args. The
  // allocation LOCKS the solver's cBTC until either the executor releases it
  // (Allocation_ExecuteTransfer, after verifying WBTC) or it's refunded
  // (Allocation_Withdraw). settleBefore is the timeout after which release is
  // impossible and the cBTC is recoverable by the sender.

  /**
   * Lock cBTC into an Allocation (solver float → held for `receiverParty`).
   * Returns the created Allocation contractId + the locked holding cids.
   */
  async allocate(params: {
    receiverParty: string;
    amountBtc: string;
    inputHoldings: HoldingLite[];
    settlementId: string;
    settleBefore: Date;
    allocateBefore?: Date;
  }): Promise<{ updateId: string; allocationCid: string; lockedHoldingCids: string[] }> {
    const jwt = await this.getJwt();
    const now = new Date().toISOString();
    const allocateBefore = (params.allocateBefore ?? params.settleBefore).toISOString();
    const settleBefore = params.settleBefore.toISOString();

    // Never fund from a locked holding — exclude them before selection.
    const picked = selectHoldings(
      params.inputHoldings.filter((h) => !h.locked),
      params.amountBtc,
    );
    const inputHoldingCids = picked.map((h) => h.contractId);

    const registryUrl = `${this.cfg.registryUrl}/api/token-standard/v0/registrars/${this.cfg.decentralizedPartyId}/registry/allocation-instruction/v1/allocation-factory`;
    const allocation = {
      settlement: {
        executor: this.cfg.solverParty, // solver releases after verifying WBTC
        settlementRef: { id: params.settlementId, cid: null },
        requestedAt: now,
        allocateBefore,
        settleBefore,
        meta: { values: {} },
      },
      transferLegId: "leg-0",
      transferLeg: {
        sender: this.cfg.solverParty,
        receiver: params.receiverParty,
        amount: params.amountBtc,
        instrumentId: this.cfg.instrumentId,
        meta: { values: {} },
      },
    };
    const factoryRes = await fetch(registryUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        choiceArguments: {
          expectedAdmin: this.cfg.decentralizedPartyId,
          allocation,
          requestedAt: now,
          inputHoldingCids,
          extraArgs: { context: { values: {} }, meta: { values: {} } },
        },
      }),
    });
    if (!factoryRes.ok) {
      const text = await factoryRes.text().catch(() => "<no body>");
      throw new Error(`AllocationFactory registry call failed (${factoryRes.status}): ${text}`);
    }
    const factory = (await factoryRes.json()) as TransferFactoryResponse;

    const disclosed: DisclosedContract[] = [
      ...factory.choiceContext.disclosedContracts.map((dc) => ({
        ...dc,
        synchronizerId: dc.synchronizerId ?? "",
      })),
      ...picked.map((h) => ({
        templateId: HOLDING_TEMPLATE_FQN,
        contractId: h.contractId,
        createdEventBlob: h.createdEventBlob,
        synchronizerId: "",
      })),
    ];

    const { updateId, createdCids } = await this.submitExercise({
      jwt,
      workflow: "swap-allocate",
      templateId: ALLOCATION_FACTORY_INTERFACE,
      contractId: factory.factoryId,
      choice: "AllocationFactory_Allocate",
      choiceArgument: {
        expectedAdmin: this.cfg.decentralizedPartyId,
        allocation,
        requestedAt: now,
        inputHoldingCids,
        extraArgs: { context: factory.choiceContext.choiceContextData, meta: { values: {} } },
      },
      disclosed,
    });
    // The created Allocation contract is the new non-holding contract in the tree.
    const allocationCid = createdCids[0] ?? "";
    return { updateId, allocationCid, lockedHoldingCids: inputHoldingCids };
  }

  /** Release locked cBTC to the receiver (executor authority). Before settleBefore. */
  async executeAllocation(allocationCid: string): Promise<{ updateId: string }> {
    const jwt = await this.getJwt();
    const { updateId } = await this.submitExercise({
      jwt,
      workflow: "swap-allocation-execute",
      templateId: ALLOCATION_INTERFACE,
      contractId: allocationCid,
      choice: "Allocation_ExecuteTransfer",
      choiceArgument: { extraArgs: { context: { values: {} }, meta: { values: {} } } },
      disclosed: [],
    });
    return { updateId };
  }

  /** Refund locked cBTC back to the sender (solver). The escape hatch / timeout path. */
  async withdrawAllocation(allocationCid: string): Promise<{ updateId: string }> {
    const jwt = await this.getJwt();
    const { updateId } = await this.submitExercise({
      jwt,
      workflow: "swap-allocation-withdraw",
      templateId: ALLOCATION_INTERFACE,
      contractId: allocationCid,
      choice: "Allocation_Withdraw",
      choiceArgument: { extraArgs: { context: { values: {} }, meta: { values: {} } } },
      disclosed: [],
    });
    return { updateId };
  }

  /**
   * Shared submit helper — exercises a choice as the solver and returns the
   * updateId + any created contract ids (non-holding). Extracted so the
   * allocate/execute/withdraw paths share the exact submit semantics createOffer
   * uses inline.
   */
  private async submitExercise(p: {
    jwt: string;
    workflow: string;
    templateId: string;
    contractId: string;
    choice: string;
    choiceArgument: unknown;
    disclosed: DisclosedContract[];
  }): Promise<{ updateId: string; createdCids: string[] }> {
    const commandId = randomUUID();
    const res = await fetch(
      `${this.cfg.ledgerHost}/v2/commands/submit-and-wait-for-transaction-tree`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.jwt}` },
        body: JSON.stringify({
          applicationId: "cbtc-app",
          workflowId: `${p.workflow}-${commandId}`,
          commandId,
          actAs: [this.cfg.solverParty],
          readAs: [this.cfg.solverParty],
          commands: [
            {
              ExerciseCommand: {
                templateId: p.templateId,
                contractId: p.contractId,
                choice: p.choice,
                choiceArgument: p.choiceArgument,
              },
            },
          ],
          disclosedContracts: p.disclosed,
        }),
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "<no body>");
      throw new Error(`${p.choice} submit failed (${res.status}): ${text}`);
    }
    const json = (await res.json()) as {
      transactionTree?: {
        updateId: string;
        eventsById?: Record<string, { CreatedTreeEvent?: { value?: { contractId?: string; templateId?: string } } }>;
      };
    };
    const tree = json.transactionTree;
    const createdCids: string[] = [];
    for (const ev of Object.values(tree?.eventsById ?? {})) {
      const c = ev.CreatedTreeEvent?.value;
      if (!c?.contractId) continue;
      const tpl = c.templateId ?? "";
      // Keep the Allocation contract; skip plain Holding change-outputs. NOTE the
      // Allocation template path is "...V0.Holding.Allocation:DvpLegAllocation"
      // — it CONTAINS "Holding", so match on the entity name, not a substring.
      const isPlainHolding = tpl.endsWith(":Holding") || tpl.includes("Holding.V0.Holding:Holding");
      if (!isPlainHolding) createdCids.push(c.contractId);
    }
    return { updateId: tree?.updateId ?? "", createdCids };
  }

  /**
   * Is a transfer the float just created still PENDING? Readable with our own
   * token (the sender is a stakeholder), so this never hits the receiver-party
   * 403. Pending ⇔ a TransferInstruction is active on our float, OR a cBTC
   * holding we own is still locked (the in-flight transfer's lock).
   *
   * Returns the TransferInstruction contract id when found, so the caller can
   * track it for the accept/expiry watch.
   */
  private async floatHasPendingTransfer(
    inputHoldingCids: string[],
  ): Promise<{ pending: boolean; cid?: string }> {
    const jwt = await this.getJwt();
    const offset = await this.getLedgerEnd(jwt);
    const res = await fetch(`${this.cfg.ledgerHost}/v2/state/active-contracts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({
        filter: { filtersByParty: { [this.cfg.solverParty]: { cumulative: [{ identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } }] } } },
        verbose: false,
        activeAtOffset: offset,
      }),
    });
    // Can't read our own float (shouldn't happen) → conservatively "pending" so
    // we never wrongly auto-finalise.
    if (!res.ok) return { pending: true };

    const items = (await res.json()) as ActiveContractEntry[];
    const wantInputs = new Set(inputHoldingCids);
    let instructionCid: string | undefined;
    let locked = false;
    for (const item of items) {
      const ev = item.contractEntry?.JsActiveContract?.createdEvent;
      if (!ev) continue;
      const tid = ev.templateId ?? "";
      if (tid.includes("TransferInstruction")) {
        instructionCid = ev.contractId; // a pending transfer the float is party to
      } else if (tid.includes("Holding")) {
        const arg = ev.createArgument as { lock?: unknown } | undefined;
        // a locked holding, or one of our original inputs still active → in-flight
        if (arg?.lock != null || wantInputs.has(ev.contractId)) locked = true;
      }
    }
    return { pending: !!instructionCid || locked, cid: instructionCid };
  }

  /** Find the offer just created for `receiver` that uses one of our inputs.
   *  Returns kind "found" with the cid, "absent" (not in the readable set), or
   *  "unreadable" (the receiver's party isn't readable by our token — 403). */
  private async findOfferForInputs(
    receiverParty: string,
    sourceHoldingCids: string[],
  ): Promise<{ kind: "found"; contractId: string } | { kind: "absent" } | { kind: "unreadable" }> {
    const jwt = await this.getJwt();
    const offset = await this.getLedgerEnd(jwt);
    const res = await fetch(`${this.cfg.ledgerHost}/v2/state/active-contracts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({
        filter: {
          filtersByParty: {
            [receiverParty]: {
              cumulative: [
                { identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } },
              ],
            },
          },
        },
        verbose: false,
        activeAtOffset: offset,
      }),
    });
    if (!res.ok) return { kind: "unreadable" }; // typically 403 on another participant's party
    const items = (await res.json()) as ActiveContractEntry[];
    const sourceSet = new Set(sourceHoldingCids);
    for (const item of items) {
      const ev = item.contractEntry?.JsActiveContract?.createdEvent;
      if (!ev) continue;
      if (!ev.templateId?.includes("TransferOffer") && !ev.templateId?.includes("TransferInstruction")) {
        continue;
      }
      const cids = (ev.createArgument as { transfer?: { inputHoldingCids?: string[] } } | undefined)
        ?.transfer?.inputHoldingCids ?? [];
      if (cids.some((c) => sourceSet.has(c))) return { kind: "found", contractId: ev.contractId };
    }
    return { kind: "absent" };
  }

  // --- Task 7b: offer resolution (accepted / expired) ---

  /**
   * Is the offer contract still active in the receiver's ACS?
   * `true`  → still pending (user hasn't accepted/rejected; may be expired).
   * `false` → archived (accepted OR expired — disambiguate via resolveOffer).
   */
  async isOfferActive(receiverParty: string, offerContractId: string): Promise<boolean> {
    const jwt = await this.getJwt();
    const offset = await this.getLedgerEnd(jwt);
    const res = await fetch(`${this.cfg.ledgerHost}/v2/state/active-contracts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({
        filter: {
          filtersByParty: {
            [receiverParty]: {
              cumulative: [
                { identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } },
              ],
            },
          },
        },
        verbose: false,
        activeAtOffset: offset,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "<no body>");
      throw new Error(`isOfferActive ACS query failed (${res.status}): ${text}`);
    }
    const items = (await res.json()) as ActiveContractEntry[];
    return items.some(
      (it) => it.contractEntry?.JsActiveContract?.createdEvent?.contractId === offerContractId,
    );
  }

  /**
   * Once an offer is no longer active, find the update that archived it and
   * classify the outcome. An ACCEPT archives the offer AND creates a new Holding
   * for the receiver in the same transaction; an EXPIRY/withdraw archives the
   * offer without a new receiver Holding.
   *
   * Scans `/v2/updates` for the receiver from `fromOffset`. Returns the outcome
   * + the transaction's ledger record-time (`effectiveAt`) — the authoritative
   * fill timestamp for an accept.
   */
  async resolveOffer(params: {
    receiverParty: string;
    offerContractId: string;
    fromOffset: number;
  }): Promise<OfferResolution> {
    const jwt = await this.getJwt();
    const end = await this.getLedgerEnd(jwt);
    if (params.fromOffset >= end) return { kind: "unknown" };

    const res = await fetch(`${this.cfg.ledgerHost}/v2/updates`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({
        beginExclusive: params.fromOffset,
        endInclusive: end,
        filter: {
          filtersByParty: {
            [params.receiverParty]: {
              cumulative: [
                { identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } },
              ],
            },
          },
        },
        verbose: true,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "<no body>");
      throw new Error(`resolveOffer updates query failed (${res.status}): ${text}`);
    }
    const data = (await res.json()) as unknown[];

    for (const item of data) {
      const txn = (item as { update?: { Transaction?: { value?: RawTransaction } } })
        .update?.Transaction?.value;
      if (!txn) continue;

      const archivedOffer = txn.events.some(
        (e) => e.ArchivedEvent?.contractId === params.offerContractId,
      );
      if (!archivedOffer) continue;

      // Same tx: did a Holding get created for the receiver? -> accepted.
      const createdReceiverHolding = txn.events.some((e) => {
        const c = e.CreatedEvent;
        if (!c) return false;
        const isHolding = (c.templateId ?? "").includes("Holding");
        const owner = (c.createArgument as { owner?: string } | undefined)?.owner;
        return isHolding && owner === params.receiverParty;
      });

      if (createdReceiverHolding) {
        return { kind: "accepted", recordTime: txn.effectiveAt, updateId: txn.updateId };
      }
      return { kind: "expired", recordTime: txn.effectiveAt, updateId: txn.updateId };
    }
    return { kind: "unknown" };
  }
}

// --- types + helpers (mirrors lib/transfer.ts) ---

export interface HoldingLite {
  contractId: string;
  amount: string; // BTC string
  createdEventBlob: string;
  /**
   * True if this holding is currently locked by an ACTIVE (non-expired) lock —
   * e.g. allocated to a settlement. Locked holdings are NOT spendable and MUST be
   * excluded from float / transfer / allocate inputs. A holding with an EXPIRED
   * lock is spendable again (the registry allows it as an input), so it is NOT
   * marked locked. Verified against the live cBTC registry: lock = {holders,
   * expiresAt, expiresAfter, context}; null when free.
   */
  locked: boolean;
}

/** The HoldingView.lock shape from the live cBTC registry. */
interface HoldingLock {
  expiresAt?: string | null;
  expiresAfter?: string | null;
}

/**
 * A lock makes a holding unspendable UNLESS it has expired. Per the token
 * standard: "Registries SHOULD allow holdings with expired locks as inputs."
 * So: no lock → spendable; lock with a past `expiresAt` → spendable; otherwise
 * (indefinite lock, or future expiry) → locked. We treat `expiresAfter`
 * (relative) conservatively as "still locked" since we can't resolve it to an
 * absolute time without the lock's creation time.
 */
export function isActivelyLocked(lock: HoldingLock | null | undefined, nowIso: string): boolean {
  if (lock == null) return false;
  if (lock.expiresAt) return lock.expiresAt > nowIso; // future expiry → locked
  if (lock.expiresAfter) return true; // relative expiry we can't resolve → treat as locked
  return true; // indefinite lock (expiresAt & expiresAfter both null) → locked
}

/** Outcome of an offer once it leaves the receiver's active set. */
export type OfferResolution =
  | { kind: "accepted"; recordTime: string; updateId: string }
  | { kind: "expired"; recordTime: string; updateId: string }
  | { kind: "unknown" }; // not yet archived / not found in the scanned range

interface RawTransaction {
  updateId: string;
  offset: number;
  effectiveAt: string; // ISO record-time
  events: Array<{
    CreatedEvent?: { contractId: string; templateId?: string; createArgument?: unknown };
    ArchivedEvent?: { contractId: string; templateId?: string };
  }>;
}

interface DisclosedContract {
  templateId: string;
  contractId: string;
  createdEventBlob: string;
  synchronizerId: string;
}
interface TransferFactoryResponse {
  factoryId: string;
  choiceContext: {
    choiceContextData: { values: Record<string, unknown> };
    disclosedContracts: DisclosedContract[];
  };
}
interface ActiveContractEntry {
  contractEntry?: {
    JsActiveContract?: {
      createdEvent?: {
        contractId: string;
        templateId?: string;
        createdEventBlob?: string;
        createArgument?: unknown;
        interfaceViews?: { viewValue?: unknown; viewStatus?: { code?: number; message?: string } }[];
      };
    };
  };
}

const HOLDING_TEMPLATE_FQN =
  "8107899ac4723ce986bf7d27416534e576e54b92161e46150a595fb78ff3d3a1:Utility.Registry.Holding.V0.Holding:Holding";
const TRANSFER_FACTORY_INTERFACE =
  "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory";
const TRANSFER_TTL_MS = 24 * 60 * 60 * 1000;

// --- Allocation (cBTC escrow) interfaces — siblings of the transfer ones. ---
const ALLOCATION_FACTORY_INTERFACE =
  "#splice-api-token-allocation-instruction-v1:Splice.Api.Token.AllocationInstructionV1:AllocationFactory";
const ALLOCATION_INTERFACE =
  "#splice-api-token-allocation-v1:Splice.Api.Token.AllocationV1:Allocation";

/** Largest-first holding selection to cover an amount; throws if insufficient. */
export function selectHoldings(holdings: HoldingLite[], amountBtc: string): HoldingLite[] {
  const target = btcStringToSats(amountBtc);
  const sorted = [...holdings].sort((a, b) => {
    const d = btcStringToSats(b.amount) - btcStringToSats(a.amount);
    return d > 0n ? 1 : d < 0n ? -1 : 0;
  });
  const picked: HoldingLite[] = [];
  let acc = 0n;
  for (const h of sorted) {
    if (acc >= target) break;
    picked.push(h);
    acc += btcStringToSats(h.amount);
  }
  if (acc < target) {
    throw new InsufficientFloatError(acc, target);
  }
  return picked;
}

/** Thrown when the solver float can't cover a delivery. */
export class InsufficientFloatError extends Error {
  constructor(public haveSats: bigint, public needSats: bigint) {
    super(`insufficient cBTC float: have ${haveSats} sats, need ${needSats} sats`);
    this.name = "InsufficientFloatError";
  }
}

/** "0.001" BTC → 100000n sats. Exact via string parsing (no float drift). */
export function btcStringToSats(btc: string): bigint {
  const [whole, frac = ""] = btc.split(".");
  const fracPadded = (frac + "00000000").slice(0, 8);
  return BigInt(whole || "0") * 100_000_000n + BigInt(fracPadded || "0");
}

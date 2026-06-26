/**
 * Vault CBTC holdings cache — settlement vault ACS is polluted (>200 stakeholder
 * contracts) so limit=150 queries often miss owned UTXOs. Track spendable holdings
 * (contractId + createdEventBlob) from swap fill trees only.
 */
import { extractEventsByIdFromSubmitResult } from "../../../lib/mint-processor-logic";
import { NETWORK } from "../../../lib/constants";
import type { Holding } from "../../../lib/types";
import {
  CBTC_HOLDING_TEMPLATE_BY_NAME,
  CBTC_HOLDING_TEMPLATE_FQN
} from "./ledger-constants";
import { fetchTransactionTreeByUpdateId } from "./transaction-tree";

let vaultPartyId: string | null = null;
let hydratedFromUpdates = false;

const byCid = new Map<string, Holding>();

export function configureVaultCbtcCache(vaultParty: string): void {
  vaultPartyId = vaultParty;
  byCid.clear();
  hydratedFromUpdates = false;
}

export function isVaultCbtcCacheParty(party: string): boolean {
  return vaultPartyId != null && party === vaultPartyId;
}

export function hasDisclosureBlob(h: Holding): boolean {
  return Boolean(h.createdEventBlob?.trim());
}

function isActivelyLocked(
  lock: { expiresAt?: string | null; expiresAfter?: string | null } | null | undefined,
  nowIso: string
): boolean {
  if (lock == null) return false;
  return lock.expiresAt ? lock.expiresAt > nowIso : true;
}

function isCbtcHoldingTemplate(templateId: string | undefined): boolean {
  return !!templateId?.includes("Utility.Registry.Holding");
}

function blobFromCreated(created: Record<string, unknown>): string | undefined {
  const direct = created.createdEventBlob;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  return undefined;
}

function holdingFromCreated(
  vaultParty: string,
  created: Record<string, unknown>
): Holding | null {
  const contractId = created.contractId;
  if (typeof contractId !== "string" || !contractId) return null;
  const templateId =
    typeof created.templateId === "string" ? created.templateId : undefined;
  if (!isCbtcHoldingTemplate(templateId)) return null;

  const arg = created.createArgument as
    | {
        owner?: string;
        amount?: string;
        lock?: { expiresAt?: string | null; expiresAfter?: string | null } | null;
      }
    | undefined;
  if (arg?.owner !== vaultParty) return null;

  const blob = blobFromCreated(created);
  if (!blob) return null;

  const nowIso = new Date().toISOString();
  if (isActivelyLocked(arg.lock, nowIso)) return null;

  return {
    contractId,
    createdEventBlob: blob,
    templateId: templateId ?? CBTC_HOLDING_TEMPLATE_FQN,
    payload: {
      owner: vaultParty,
      amount: typeof arg.amount === "string" ? arg.amount : "0",
      instrumentId: NETWORK.instrumentId
    }
  };
}

function createdEventFromTreeNode(ev: unknown): Record<string, unknown> | null {
  const e = ev as {
    CreatedTreeEvent?: { value?: unknown };
    CreatedEvent?: unknown;
  };
  const raw = e.CreatedTreeEvent?.value ?? e.CreatedEvent;
  if (!raw || typeof raw !== "object") return null;
  return raw as Record<string, unknown>;
}

function archivedCidFromTreeNode(ev: unknown): string | null {
  const e = ev as {
    ArchivedTreeEvent?: { value?: { contractId?: string } };
    ArchivedEvent?: { contractId?: string };
  };
  return e.ArchivedTreeEvent?.value?.contractId ?? e.ArchivedEvent?.contractId ?? null;
}

/** Merge created/archived holding events from a submit or update tree. */
export function applyTreeToVaultCbtcCache(
  vaultParty: string,
  eventsById: Record<string, unknown>
): void {
  if (!isVaultCbtcCacheParty(vaultParty)) return;
  for (const ev of Object.values(eventsById)) {
    const archived = archivedCidFromTreeNode(ev);
    if (archived) byCid.delete(archived);

    const created = createdEventFromTreeNode(ev);
    if (!created) continue;
    const h = holdingFromCreated(vaultParty, created);
    if (h) byCid.set(h.contractId, h);
  }
}

/** When ACS can see owned holdings with blobs, refresh cache. */
export function syncVaultCbtcCacheFromAcs(holdings: Holding[]): void {
  for (const h of holdings) {
    if (hasDisclosureBlob(h)) byCid.set(h.contractId, h);
  }
}

export function getVaultCbtcCachedHoldings(): Holding[] {
  return [...byCid.values()].filter(hasDisclosureBlob);
}

async function fetchUpdateEventsDirect(
  jwt: string,
  updateId: string
): Promise<Record<string, unknown> | null> {
  const res = await fetch(
    `${NETWORK.ledgerHost}/v2/updates/update/${encodeURIComponent(updateId)}`,
    {
      headers: { Authorization: `Bearer ${jwt}` },
      cache: "no-store"
    }
  );
  if (!res.ok) return null;
  const data = (await res.json()) as unknown;
  return extractEventsByIdFromSubmitResult(data);
}

/** Ingest vault CBTC holdings from fill/submit update trees (with blob). */
export async function ingestVaultCbtcFromFill(params: {
  jwt: string;
  vaultParty: string;
  traderParty: string;
  updateId: string;
  submitEventsById: Record<string, unknown>;
}): Promise<void> {
  applyTreeToVaultCbtcCache(params.vaultParty, params.submitEventsById);

  const direct = await fetchUpdateEventsDirect(params.jwt, params.updateId);
  if (direct) applyTreeToVaultCbtcCache(params.vaultParty, direct);

  const scanned = await fetchTransactionTreeByUpdateId(
    params.jwt,
    params.updateId,
    [params.vaultParty, params.traderParty],
    120_000
  );
  if (scanned?.eventsById) {
    applyTreeToVaultCbtcCache(params.vaultParty, scanned.eventsById);
  }
}

/** One-time scan of recent vault updates for owned CBTC holdings with blobs. */
export async function bootstrapVaultCbtcCache(
  jwt: string,
  vaultParty: string
): Promise<number> {
  if (!isVaultCbtcCacheParty(vaultParty) || hydratedFromUpdates) {
    return getVaultCbtcCachedHoldings().length;
  }
  hydratedFromUpdates = true;

  const endRes = await fetch(`${NETWORK.ledgerHost}/v2/state/ledger-end`, {
    headers: { Authorization: `Bearer ${jwt}` },
    cache: "no-store"
  });
  if (!endRes.ok) return getVaultCbtcCachedHoldings().length;
  const { offset } = (await endRes.json()) as { offset: number };
  const beginExclusive = Math.max(0, offset - 120_000);

  const res = await fetch(`${NETWORK.ledgerHost}/v2/updates/trees`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`
    },
    body: JSON.stringify({
      beginExclusive,
      endInclusive: offset,
      filter: {
        filtersByParty: {
          [vaultParty]: {
            cumulative: [
              {
                identifierFilter: {
                  TemplateFilter: {
                    value: {
                      templateId: CBTC_HOLDING_TEMPLATE_BY_NAME,
                      includeCreatedEventBlob: true
                    }
                  }
                }
              }
            ]
          }
        }
      },
      verbose: true
    }),
    cache: "no-store"
  });
  if (!res.ok) return getVaultCbtcCachedHoldings().length;

  const raw = (await res.json()) as unknown;
  const items = Array.isArray(raw)
    ? raw
    : ((raw as { updates?: unknown[] }).updates ?? []);

  for (const item of items) {
    const u = item as {
      update?: { TransactionTree?: { value?: { eventsById?: Record<string, unknown> } } };
      transactionTree?: { eventsById?: Record<string, unknown> };
    };
    const tree =
      u.update?.TransactionTree?.value ?? u.transactionTree ?? null;
    const events = (tree as { eventsById?: Record<string, unknown> } | null)
      ?.eventsById;
    if (events) applyTreeToVaultCbtcCache(vaultParty, events);
  }

  return getVaultCbtcCachedHoldings().length;
}

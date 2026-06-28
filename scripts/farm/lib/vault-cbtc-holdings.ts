/**
 * Vault CBTC holdings cache — settlement vault ACS is polluted (>200 stakeholder
 * contracts) so limit=150 queries often miss owned UTXOs. Track spendable holdings
 * (contractId + createdEventBlob) from ledger update trees.
 */
import { fromBaseUnits, toBaseUnitsFloor } from "../../../lib/amount-units";
import { CBTC_ASSET } from "../../../lib/canton-assets";
import { extractEventsByIdFromSubmitResult } from "../../../lib/mint-processor-logic";
import { NETWORK } from "../../../lib/constants";
import type { Holding } from "../../../lib/types";
import {
  CBTC_HOLDING_TEMPLATE_BY_NAME,
  CBTC_HOLDING_TEMPLATE_FQN
} from "./ledger-constants";
import { fetchTransactionTreeByUpdateId } from "./transaction-tree";

let vaultPartyId: string | null = null;
/** True only after a full paginated bootstrap completed (may still be 0 holdings). */
let bootstrapCompleted = false;

const byCid = new Map<string, Holding>();

/** Max offset span per /v2/updates/trees page (avoid truncated responses). */
const UPDATE_TREE_PAGE_OFFSET = 5_000;
const BOOTSTRAP_LOOKBACK = 120_000;

export function configureVaultCbtcCache(vaultParty: string): void {
  if (vaultPartyId === vaultParty) return;
  vaultPartyId = vaultParty;
  byCid.clear();
  bootstrapCompleted = false;
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

function offsetFromTreeItem(item: unknown): number | undefined {
  const u = item as {
    update?: { offset?: number; TransactionTree?: { value?: { offset?: number } } };
    offset?: number;
    transactionTree?: { offset?: number };
  };
  const tree = u.update?.TransactionTree?.value ?? u.transactionTree;
  const o =
    u.update?.offset ??
    u.offset ??
    (tree as { offset?: number } | null | undefined)?.offset;
  return typeof o === "number" && Number.isFinite(o) ? o : undefined;
}

function eventsFromTreeItem(item: unknown): Record<string, unknown> | null {
  const u = item as {
    update?: { TransactionTree?: { value?: { eventsById?: Record<string, unknown> } } };
    transactionTree?: { eventsById?: Record<string, unknown> };
  };
  const tree = u.update?.TransactionTree?.value ?? u.transactionTree ?? null;
  return (tree as { eventsById?: Record<string, unknown> } | null)?.eventsById ?? null;
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

export function removeVaultCbtcFromCache(contractIds: string[]): void {
  for (const cid of contractIds) byCid.delete(cid);
}

/** Sum of spendable cached vault CBTC (the only balance that can be delivered on CC→CBTC). */
export function vaultCbtcCachedBalance(): string {
  let total = 0n;
  for (const h of getVaultCbtcCachedHoldings()) {
    total += toBaseUnitsFloor(h.payload?.amount ?? "0", CBTC_ASSET.decimals);
  }
  return fromBaseUnits(total, CBTC_ASSET.decimals);
}

export function vaultCbtcCacheSpendable(): boolean {
  return getVaultCbtcCachedHoldings().length > 0;
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

async function fetchVaultCbtcTreePage(
  jwt: string,
  vaultParty: string,
  beginExclusive: number,
  endInclusive: number
): Promise<{ items: unknown[]; ok: boolean }> {
  const res = await fetch(`${NETWORK.ledgerHost}/v2/updates/trees`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`
    },
    body: JSON.stringify({
      beginExclusive,
      endInclusive,
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
  if (!res.ok) return { items: [], ok: false };
  const raw = (await res.json()) as unknown;
  const items = Array.isArray(raw)
    ? raw
    : ((raw as { updates?: unknown[] }).updates ?? []);
  return { items, ok: true };
}

async function fetchVaultWildcardTreePage(
  jwt: string,
  vaultParty: string,
  beginExclusive: number,
  endInclusive: number
): Promise<{ items: unknown[]; ok: boolean }> {
  const res = await fetch(`${NETWORK.ledgerHost}/v2/updates/trees`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`
    },
    body: JSON.stringify({
      beginExclusive,
      endInclusive,
      filter: {
        filtersByParty: {
          [vaultParty]: {
            cumulative: [
              {
                identifierFilter: {
                  WildcardFilter: { value: { includeCreatedEventBlob: true } }
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
  if (!res.ok) return { items: [], ok: false };
  const raw = (await res.json()) as unknown;
  const items = Array.isArray(raw)
    ? raw
    : ((raw as { updates?: unknown[] }).updates ?? []);
  return { items, ok: true };
}

function applyItemsToVaultCache(vaultParty: string, items: unknown[]): void {
  for (const item of items) {
    const events = eventsFromTreeItem(item);
    if (events) applyTreeToVaultCbtcCache(vaultParty, events);
  }
}

async function scanVaultCbtcUpdatesPaginated(
  jwt: string,
  vaultParty: string,
  beginExclusive: number,
  endInclusive: number
): Promise<void> {
  let cursor = beginExclusive;
  while (cursor < endInclusive) {
    const pageEnd = Math.min(cursor + UPDATE_TREE_PAGE_OFFSET, endInclusive);
    const { items, ok } = await fetchVaultCbtcTreePage(
      jwt,
      vaultParty,
      cursor,
      pageEnd
    );
    if (!ok) break;

    let maxOffset = cursor;
    for (const item of items) {
      const events = eventsFromTreeItem(item);
      if (events) applyTreeToVaultCbtcCache(vaultParty, events);
      const off = offsetFromTreeItem(item);
      if (off != null && off > maxOffset) maxOffset = off;
    }

    if (items.length === 0 || maxOffset <= cursor) {
      cursor = pageEnd;
    } else {
      cursor = maxOffset;
    }
  }
}

/** Ingest vault CBTC from any submit/update tree (fund, swap fill, consolidate). */
export async function ingestVaultCbtcFromSubmit(params: {
  jwt: string;
  vaultParty: string;
  updateId: string;
  submitEventsById: Record<string, unknown>;
  counterpartyParty?: string;
}): Promise<number> {
  applyTreeToVaultCbtcCache(params.vaultParty, params.submitEventsById);

  const direct = await fetchUpdateEventsDirect(params.jwt, params.updateId);
  if (direct) applyTreeToVaultCbtcCache(params.vaultParty, direct);

  if (params.counterpartyParty) {
    const scanned = await fetchTransactionTreeByUpdateId(
      params.jwt,
      params.updateId,
      [params.vaultParty, params.counterpartyParty],
      120_000
    );
    if (scanned?.eventsById) {
      applyTreeToVaultCbtcCache(params.vaultParty, scanned.eventsById);
    }
  }

  return getVaultCbtcCachedHoldings().length;
}

/** Ingest vault CBTC holdings from swap fill trees (with blob). */
export async function ingestVaultCbtcFromFill(params: {
  jwt: string;
  vaultParty: string;
  traderParty: string;
  updateId: string;
  submitEventsById: Record<string, unknown>;
}): Promise<void> {
  await ingestVaultCbtcFromSubmit({
    jwt: params.jwt,
    vaultParty: params.vaultParty,
    updateId: params.updateId,
    submitEventsById: params.submitEventsById,
    counterpartyParty: params.traderParty
  });
}

async function scanVaultWildcardUpdatesPaginated(
  jwt: string,
  vaultParty: string,
  beginExclusive: number,
  endInclusive: number
): Promise<void> {
  let cursor = beginExclusive;
  while (cursor < endInclusive) {
    const pageEnd = Math.min(cursor + UPDATE_TREE_PAGE_OFFSET, endInclusive);
    const { items, ok } = await fetchVaultWildcardTreePage(
      jwt,
      vaultParty,
      cursor,
      pageEnd
    );
    if (!ok) break;
    applyItemsToVaultCache(vaultParty, items);

    let maxOffset = cursor;
    for (const item of items) {
      const off = offsetFromTreeItem(item);
      if (off != null && off > maxOffset) maxOffset = off;
    }

    if (items.length === 0 || maxOffset <= cursor) cursor = pageEnd;
    else cursor = maxOffset;
  }
}

/**
 * Wildcard scan of recent vault updates only — for one-off funding scripts.
 * Avoids the 120k template bootstrap that re-includes already-spent UTXOs.
 */
export async function bootstrapVaultCbtcCacheRecent(
  jwt: string,
  vaultParty: string,
  lookback = 8_000
): Promise<number> {
  configureVaultCbtcCache(vaultParty);

  const endRes = await fetch(`${NETWORK.ledgerHost}/v2/state/ledger-end`, {
    headers: { Authorization: `Bearer ${jwt}` },
    cache: "no-store"
  });
  if (!endRes.ok) return 0;
  const { offset } = (await endRes.json()) as { offset: number };

  await scanVaultWildcardUpdatesPaginated(
    jwt,
    vaultParty,
    Math.max(0, offset - lookback),
    offset
  );

  const count = getVaultCbtcCachedHoldings().length;
  if (count > 0) bootstrapCompleted = true;
  return count;
}

/** Paginated scan of recent vault updates for owned CBTC holdings with blobs. */
export async function bootstrapVaultCbtcCache(
  jwt: string,
  vaultParty: string
): Promise<number> {
  if (!isVaultCbtcCacheParty(vaultParty)) {
    return getVaultCbtcCachedHoldings().length;
  }
  if (bootstrapCompleted && getVaultCbtcCachedHoldings().length > 0) {
    return getVaultCbtcCachedHoldings().length;
  }

  const endRes = await fetch(`${NETWORK.ledgerHost}/v2/state/ledger-end`, {
    headers: { Authorization: `Bearer ${jwt}` },
    cache: "no-store"
  });
  if (!endRes.ok) return getVaultCbtcCachedHoldings().length;
  const { offset } = (await endRes.json()) as { offset: number };
  const beginExclusive = Math.max(0, offset - BOOTSTRAP_LOOKBACK);

  await scanVaultCbtcUpdatesPaginated(jwt, vaultParty, beginExclusive, offset);

  let count = getVaultCbtcCachedHoldings().length;
  if (count === 0) {
    const { items, ok } = await fetchVaultWildcardTreePage(
      jwt,
      vaultParty,
      Math.max(0, offset - 8_000),
      offset
    );
    if (ok) applyItemsToVaultCache(vaultParty, items);
    count = getVaultCbtcCachedHoldings().length;
  }

  // Only mark complete when we found holdings, or cache was already populated.
  // If still empty, allow refreshVaultCbtcCacheIfEmpty to retry on next plan tick.
  if (count > 0) bootstrapCompleted = true;

  return count;
}

/**
 * Re-run bootstrap when cache is empty (vault ACS blind but CBTC may exist on-ledger).
 * Called before planning CC→CBTC.
 */
export async function refreshVaultCbtcCacheIfEmpty(
  jwt: string,
  vaultParty: string
): Promise<number> {
  if (!isVaultCbtcCacheParty(vaultParty)) return 0;
  if (getVaultCbtcCachedHoldings().length > 0) {
    return getVaultCbtcCachedHoldings().length;
  }
  bootstrapCompleted = false;
  return bootstrapVaultCbtcCache(jwt, vaultParty);
}

/** Sync in-memory float vault CBTC to cached spendable balance. */
export function reconcileVaultCbtcInFloat<T extends { vault: { cbtc: string; cc: string } }>(
  float: T
): T {
  if (!vaultPartyId) return float;
  return {
    ...float,
    vault: {
      ...float.vault,
      cbtc: vaultCbtcCachedBalance()
    }
  };
}

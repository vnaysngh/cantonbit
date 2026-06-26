/**
 * Vault CBTC holdings cache — settlement vault ACS is polluted (>200 stakeholder
 * contracts) so limit=150 queries return zero *owned* UTXOs. Track holdings from
 * swap fill trees + a one-time updates bootstrap (Canton updates-over-ACS pattern).
 */
import { NETWORK } from "../../../lib/constants";
import type { Holding } from "../../../lib/types";
import { CBTC_HOLDING_TEMPLATE_FQN } from "./ledger-constants";

let vaultPartyId: string | null = null;
let bootstrapped = false;

const byCid = new Map<string, Holding>();

export function configureVaultCbtcCache(vaultParty: string): void {
  vaultPartyId = vaultParty;
  byCid.clear();
  bootstrapped = false;
}

export function isVaultCbtcCacheParty(party: string): boolean {
  return vaultPartyId != null && party === vaultPartyId;
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

function holdingFromCreated(
  vaultParty: string,
  created: {
    contractId?: string;
    templateId?: string;
    createArgument?: {
      owner?: string;
      amount?: string;
      lock?: { expiresAt?: string | null; expiresAfter?: string | null } | null;
    };
    createdEventBlob?: string;
  }
): Holding | null {
  if (!created.contractId || !isCbtcHoldingTemplate(created.templateId)) return null;
  const arg = created.createArgument;
  if (arg?.owner !== vaultParty) return null;
  const nowIso = new Date().toISOString();
  if (isActivelyLocked(arg.lock, nowIso)) return null;
  return {
    contractId: created.contractId,
    createdEventBlob: created.createdEventBlob ?? "",
    templateId: created.templateId ?? CBTC_HOLDING_TEMPLATE_FQN,
    payload: {
      owner: vaultParty,
      amount: typeof arg.amount === "string" ? arg.amount : "0",
      instrumentId: NETWORK.instrumentId
    }
  };
}

function createdEventFromTreeNode(ev: unknown): {
  contractId?: string;
  templateId?: string;
  createArgument?: {
    owner?: string;
    amount?: string;
    lock?: { expiresAt?: string | null; expiresAfter?: string | null } | null;
  };
  createdEventBlob?: string;
} | null {
  const e = ev as {
    CreatedTreeEvent?: { value?: unknown };
    CreatedEvent?: unknown;
  };
  const raw = e.CreatedTreeEvent?.value ?? e.CreatedEvent;
  if (!raw || typeof raw !== "object") return null;
  return raw as {
    contractId?: string;
    templateId?: string;
    createArgument?: {
      owner?: string;
      amount?: string;
      lock?: { expiresAt?: string | null; expiresAfter?: string | null } | null;
    };
    createdEventBlob?: string;
  };
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

/** When ACS can see owned holdings, prefer that view and refresh cache. */
export function syncVaultCbtcCacheFromAcs(holdings: Holding[]): void {
  if (holdings.length === 0) return;
  for (const h of holdings) byCid.set(h.contractId, h);
}

export function getVaultCbtcCachedHoldings(): Holding[] {
  return [...byCid.values()];
}

/** Scan recent vault updates for owned CBTC Holding creates (once per run). */
export async function bootstrapVaultCbtcCache(
  jwt: string,
  vaultParty: string
): Promise<number> {
  if (!isVaultCbtcCacheParty(vaultParty) || bootstrapped) {
    return byCid.size;
  }
  bootstrapped = true;

  const endRes = await fetch(`${NETWORK.ledgerHost}/v2/state/ledger-end`, {
    headers: { Authorization: `Bearer ${jwt}` },
    cache: "no-store"
  });
  if (!endRes.ok) return byCid.size;
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
                      templateId: CBTC_HOLDING_TEMPLATE_FQN,
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
  if (!res.ok) return byCid.size;

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

  return byCid.size;
}

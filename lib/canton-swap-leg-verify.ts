import "server-only";

import { fetchTransactionTreeByUpdateId } from "./canton-command-recovery";
import { getLedgerJwt } from "./auth";
import {
  parseUserLegEvidenceFromEvents,
  type UserLegEvidence
} from "./canton-swap-leg-verify-logic";
import type { InstrumentId } from "./constants";
import { NETWORK } from "./constants";
import type { CantonSwapMvpAssetId } from "./canton-swap-types";
import {
  extractEventsByIdFromSubmitResult,
  extractSubmitUpdateId
} from "./mint-processor-logic";

export { extractSubmitUpdateId };
export type { UserLegEvidence };

/** Fetch a ledger update tree by update id (Loop submit or solver fill). */
export async function fetchUpdateEventsById(
  updateId: string,
  partyIds: string[] = []
): Promise<Record<string, unknown> | null> {
  const uniqueParties = [...new Set(partyIds.filter(Boolean))];
  if (uniqueParties.length > 0) {
    const scanned = await fetchTransactionTreeByUpdateId(updateId, uniqueParties);
    if (scanned?.eventsById && Object.keys(scanned.eventsById).length > 0) {
      return scanned.eventsById;
    }
  }

  // Fallback for ledgers that support direct update lookup.
  const jwt = await getLedgerJwt();
  const url = `${NETWORK.ledgerHost}/v2/updates/update/${encodeURIComponent(updateId)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${jwt}` },
    cache: "no-store"
  });
  if (!res.ok) return null;
  const data = (await res.json()) as unknown;
  return extractEventsByIdFromSubmitResult(data);
}

export async function verifyUserLegFromSubmitUpdate(
  updateId: string,
  params: {
    userParty: string;
    solverParty: string;
    inAmount: string;
    fromAsset: CantonSwapMvpAssetId;
    expectedInstrument: InstrumentId;
    expectedMemo?: string;
    strictOrderBoundMemo?: boolean;
  }
): Promise<UserLegEvidence> {
  const events = await fetchUpdateEventsById(updateId, [
    params.userParty,
    params.solverParty
  ]);
  const evidence = parseUserLegEvidenceFromEvents(events, params);
  if (!evidence) {
    throw new Error("user leg submit update does not prove inbound transfer");
  }
  return evidence;
}

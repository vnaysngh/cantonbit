import { fetchTransactionTreeByUpdateId } from "./transaction-tree";

const CC_BURN_CHOICE =
  /AmuletRules.*Burn|Amulet_Expire|TransferPreapproval.*Create|ExternalPartySetupProposal/i;

export interface CcBurnAuditResult {
  ccBurnSuspected: boolean;
  flaggedChoices: string[];
  updatesScanned: number;
}

function choiceFromEvent(ev: unknown): string | null {
  const e = ev as {
    ExercisedEvent?: { choice?: string };
    exercised?: { choice?: string };
  };
  return e?.ExercisedEvent?.choice ?? e?.exercised?.choice ?? null;
}

export function scanEventsForCcBurn(eventsById: Record<string, unknown>): string[] {
  const flagged: string[] = [];
  for (const ev of Object.values(eventsById)) {
    const choice = choiceFromEvent(ev);
    if (choice && CC_BURN_CHOICE.test(choice)) {
      flagged.push(choice);
    }
  }
  return flagged;
}

/** Scan farm swap update trees for CC fee/burn choices (preapproval, traffic, etc.). */
export async function auditSwapUpdatesForCcBurn(params: {
  jwt: string;
  updateIds: string[];
  partyIds: string[];
}): Promise<CcBurnAuditResult> {
  const flaggedChoices: string[] = [];
  let updatesScanned = 0;

  for (const updateId of params.updateIds) {
    const tree = await fetchTransactionTreeByUpdateId(
      params.jwt,
      updateId,
      params.partyIds
    );
    if (!tree) continue;
    updatesScanned++;
    flaggedChoices.push(...scanEventsForCcBurn(tree.eventsById));
  }

  return {
    ccBurnSuspected: flaggedChoices.length > 0,
    flaggedChoices: [...new Set(flaggedChoices)],
    updatesScanned
  };
}

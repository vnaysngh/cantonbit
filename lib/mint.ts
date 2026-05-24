/**
 * Mint flow — bridging native BTC into cBTC on Canton.
 *
 * Official reference: https://docs.bitsafe.finance/developers/cbtc-minting-and-burning
 *
 * Steps (per BitSafe docs diagram):
 *   1. GET /app/get-account-contract-rules  → da_rules contract
 *   2. POST /v2/commands/submit-and-wait    → create CBTCDepositAccount (Loop popup)
 *      - actAs: [USER_PARTY_ID]
 *      - templateId: "#cbtc:CBTC.DepositAccount:CBTCDepositAccountRules"
 *      - choice: "CBTCDepositAccountRules_CreateDepositAccount"
 *      - choiceArgument: { owner: USER_PARTY_ID }
 *      - disclosedContracts: [da_rules]
 *   3. GET /app/get-bitcoin-address (id: depositAccountCid) → taproot P2TR address
 *   4. User sends BTC to that address
 *   5. Attestors monitor Bitcoin for 6 confirmations (~60 min)
 *   6. Attestors submit ConfirmDepositAction on Canton
 *   7. cBTC minted to user's party (additional 60–120s after confirmation 6)
 *
 * Minimum mint amount: 0.001 BTC
 * UTXO limit: 10 per party — warn at 8, hard-block at 10
 */

import { getAccountContractRules, getBitcoinAddress } from "./bitsafe";
import type { CoordinatorContract } from "./bitsafe";
import type { LoopProvider } from "@/hooks/useWallet";

/** Minimum mint amount in satoshis (0.001 BTC). */
export const MIN_MINT_SATS = 100_000n;

/** Warn user when UTXO count reaches this threshold. */
export const UTXO_WARN_THRESHOLD = 8;

/** Hard limit on UTXOs per party. */
export const UTXO_HARD_LIMIT = 10;

const DEPOSIT_ACCOUNT_TEMPLATE_ID =
  "#cbtc:CBTC.DepositAccount:CBTCDepositAccount";

const DEPOSIT_ACCOUNT_RULES_TEMPLATE_ID =
  "#cbtc:CBTC.DepositAccount:CBTCDepositAccountRules";

const CREATE_DEPOSIT_ACCOUNT_CHOICE =
  "CBTCDepositAccountRules_CreateDepositAccount";

export interface DepositAccountSummary {
  /** The on-ledger contract id of the user's CBTCDepositAccount. */
  contractId: string;
  payload: Record<string, unknown>;
}

/**
 * Step 1 (read-only): Check if the user already has a CBTCDepositAccount.
 * The deposit account can be reused across sessions — we only create one if
 * none exists. Returns empty array if this is the user's first mint.
 *
 * Filters by userParty (owner field in the contract payload) so that even
 * if Loop returns contracts for multiple parties, we only get this user's own.
 */
export async function listDepositAccounts(
  provider: LoopProvider,
  userParty: string,
): Promise<DepositAccountSummary[]> {
  const contracts = await provider.getActiveContracts({
    templateId: DEPOSIT_ACCOUNT_TEMPLATE_ID,
  });
  return contracts
    .map((c) => ({
      contractId: c.contract_id,
      payload: c as unknown as Record<string, unknown>,
    }))
    .filter((c) => {
      // Keep only contracts explicitly owned by this party.
      // Checks both camelCase and snake_case payload shapes.
      const p = c.payload as Record<string, unknown>;
      const arg =
        (p.create_argument as Record<string, unknown> | undefined) ??
        (p.createArgument as Record<string, unknown> | undefined) ??
        (p.payload as Record<string, unknown> | undefined) ??
        p;
      const owner = arg.owner;
      return !owner || owner === userParty;
    });
}

/**
 * Step 2: Create a CBTCDepositAccount for the user on Canton.
 *
 * Triggers a Loop wallet popup asking the user to approve the transaction.
 * The transaction exercises CBTCDepositAccountRules_CreateDepositAccount with
 * actAs: [userParty] and the da_rules contract re-disclosed.
 *
 * Confirmed shape from BitSafe docs:
 *   POST /v2/commands/submit-and-wait-for-transaction-tree (via Loop)
 *   actAs: [USER_PARTY_ID]
 *   choice: CBTCDepositAccountRules_CreateDepositAccount
 *   choiceArgument: { owner: USER_PARTY_ID }
 *   disclosedContracts: [da_rules from get-account-contract-rules]
 *
 * Returns the new deposit account's contract_id.
 */
export async function createDepositAccount(
  provider: LoopProvider,
  userParty: string,
): Promise<string> {
  const rules = await getAccountContractRules();

  const txResponse = await provider.submitTransaction(
    {
      actAs: [userParty],
      disclosedContracts: [toDisclosed(rules.da_rules)],
      commands: [
        {
          ExerciseCommand: {
            templateId: DEPOSIT_ACCOUNT_RULES_TEMPLATE_ID,
            contractId: rules.da_rules.contract_id,
            choice: CREATE_DEPOSIT_ACCOUNT_CHOICE,
            choiceArgument: { owner: userParty },
          },
        },
      ],
    },
    {
      message: "Create cBTC deposit account",
      executionMode: "wait",
    },
  );

  const newContractId = extractCreatedContractId(
    txResponse,
    DEPOSIT_ACCOUNT_TEMPLATE_ID,
  );
  if (!newContractId) {
    throw new Error(
      "Deposit account created but contract id not found in transaction response.",
    );
  }
  return newContractId;
}

/**
 * Step 3: Fetch the Bitcoin deposit address from the coordinator.
 * Returns a taproot P2TR address (bcrt1p / tb1p / bc1p depending on network).
 */
export async function getDepositAddress(
  depositAccountContractId: string,
): Promise<string> {
  return getBitcoinAddress(depositAccountContractId);
}

/* -------------------------- internal helpers -------------------------- */

function toDisclosed(c: CoordinatorContract) {
  return {
    templateId: c.template_id,
    contractId: c.contract_id,
    createdEventBlob: c.created_event_blob,
    synchronizerId: "",
  };
}

/**
 * Walk a Loop transaction response looking for a CreatedEvent whose templateId
 * contains the given suffix. Handles the three response shapes Loop may return:
 *
 *   Shape A: { transactionTree: { eventsById: { "0": { CreatedEvent: {...} } } } }
 *   Shape B: { transaction: { events: [ { CreatedEvent: {...} } ] } }
 *   Shape C: { events: [ { templateId, contractId } ] }  (flattened)
 */
function extractCreatedContractId(
  txResponse: unknown,
  templateSuffix: string,
): string | null {
  if (!txResponse || typeof txResponse !== "object") return null;

  const tree = (txResponse as { transactionTree?: { eventsById?: Record<string, unknown> } })
    .transactionTree;
  if (tree?.eventsById) {
    for (const ev of Object.values(tree.eventsById)) {
      const cid = matchCreatedEvent(ev, templateSuffix);
      if (cid) return cid;
    }
  }

  const events = (txResponse as { transaction?: { events?: unknown[] } })
    .transaction?.events;
  if (Array.isArray(events)) {
    for (const ev of events) {
      const cid = matchCreatedEvent(ev, templateSuffix);
      if (cid) return cid;
    }
  }

  const flatEvents = (txResponse as { events?: unknown[] }).events;
  if (Array.isArray(flatEvents)) {
    for (const ev of flatEvents) {
      const cid = matchCreatedEvent(ev, templateSuffix);
      if (cid) return cid;
    }
  }

  return null;
}

function matchCreatedEvent(ev: unknown, templateSuffix: string): string | null {
  if (!ev || typeof ev !== "object") return null;

  const tagged = (ev as { CreatedEvent?: { templateId?: string; contractId?: string } })
    .CreatedEvent;
  if (tagged?.templateId?.includes(templateSuffix) && tagged.contractId) {
    return tagged.contractId;
  }

  const flat = ev as { templateId?: string; contractId?: string };
  if (flat.templateId?.includes(templateSuffix) && flat.contractId) {
    return flat.contractId;
  }

  return null;
}

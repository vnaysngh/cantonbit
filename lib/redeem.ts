/**
 * Redeem (burn) flow — bridging cBTC back to native BTC.
 *
 * Official reference: https://docs.bitsafe.finance/developers/cbtc-minting-and-burning
 *
 * Steps (per BitSafe docs "How to Burn CBTC" section):
 *   1. GET /app/get-account-contract-rules       → wa_rules contract
 *   2. POST /v2/commands (via Loop)              → create CBTCWithdrawAccount
 *      - choice: CBTCWithdrawAccountRules_CreateWithdrawAccount
 *      - choiceArgument: { owner: USER_PARTY_ID, destinationBtcAddress }
 *      - disclosedContracts: [wa_rules]
 *   3. GET /app/get-token-standard-contracts     → 5 context contracts
 *   4. Pick holdings (greedy, largest first) that cover requested amount
 *   5. POST /v2/commands (via Loop)              → exercise CBTCWithdrawAccount_Withdraw
 *      - actAs: [USER_PARTY_ID]
 *      - disclosedContracts: all 5 token-standard contracts
 *      - choiceArgument: { amount, tokens: holdingCids, burnMintFactoryCid, extraArgs }
 *   6. Attestors see the burn, send BTC to destinationBtcAddress
 *
 * UTXO limits: warn at 8, hard-block at 10 (per BitSafe docs)
 */

import {
  getAccountContractRules,
  getTokenStandardContracts,
} from "./bitsafe";
import type { CoordinatorContract, TokenStandardContracts } from "./bitsafe";
import type { LoopProvider } from "@/hooks/useWallet";

export { UTXO_WARN_THRESHOLD, UTXO_HARD_LIMIT } from "./mint";

const WITHDRAW_ACCOUNT_TEMPLATE_ID =
  "#cbtc:CBTC.WithdrawAccount:CBTCWithdrawAccount";

const WITHDRAW_ACCOUNT_RULES_TEMPLATE_ID =
  "#cbtc:CBTC.WithdrawAccount:CBTCWithdrawAccountRules";

const WITHDRAW_REQUEST_TEMPLATE_ID =
  "#cbtc:CBTC.WithdrawRequest:CBTCWithdrawRequest";

const HOLDING_INTERFACE_ID =
  "#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding";

const CREATE_WITHDRAW_ACCOUNT_CHOICE =
  "CBTCWithdrawAccountRules_CreateWithdrawAccount";
const WITHDRAW_CHOICE = "CBTCWithdrawAccount_Withdraw";

export interface WithdrawAccountSummary {
  contractId: string;
  /**
   * The BTC destination address this WithdrawAccount is parameterised with.
   * Null if not parseable from the active-contracts response.
   */
  destinationBtcAddress: string | null;
  payload: Record<string, unknown>;
}

export interface HoldingSummary {
  contractId: string;
  /** Decimal-string cBTC amount from the Holding interface view. */
  amount: string | null;
  payload: Record<string, unknown>;
}

export interface WithdrawRequestSummary {
  contractId: string;
  payload: Record<string, unknown>;
}

/**
 * Step 1 (read-only): Check if the user already has a CBTCWithdrawAccount
 * for this destination address. Reuses it if found — no need to create another.
 */
export async function listWithdrawAccounts(
  provider: LoopProvider,
): Promise<WithdrawAccountSummary[]> {
  const contracts = await provider.getActiveContracts({
    templateId: WITHDRAW_ACCOUNT_TEMPLATE_ID,
  });
  return contracts.map((c) => {
    const cAny = c as unknown as Record<string, unknown>;
    return {
      contractId: c.contract_id,
      destinationBtcAddress: extractBtcAddress(cAny),
      payload: cAny,
    };
  });
}

/**
 * Step 2: Create a new CBTCWithdrawAccount. Triggers a Loop popup.
 *
 * Confirmed shape from BitSafe docs:
 *   actAs: [USER_PARTY_ID]
 *   choice: CBTCWithdrawAccountRules_CreateWithdrawAccount
 *   choiceArgument: { owner: USER_PARTY_ID, destinationBtcAddress }
 *   disclosedContracts: [wa_rules]
 */
export async function createWithdrawAccount(
  provider: LoopProvider,
  userParty: string,
  destinationBtcAddress: string,
): Promise<string> {
  const rules = await getAccountContractRules();

  const txResponse = await provider.submitTransaction(
    {
      actAs: [userParty],
      disclosedContracts: [toDisclosed(rules.wa_rules)],
      commands: [
        {
          ExerciseCommand: {
            templateId: WITHDRAW_ACCOUNT_RULES_TEMPLATE_ID,
            contractId: rules.wa_rules.contract_id,
            choice: CREATE_WITHDRAW_ACCOUNT_CHOICE,
            choiceArgument: {
              owner: userParty,
              destinationBtcAddress,
            },
          },
        },
      ],
    },
    {
      message: `Create withdraw account → ${destinationBtcAddress}`,
      executionMode: "wait",
    },
  );

  const newCid = extractCreatedContractId(
    txResponse,
    WITHDRAW_ACCOUNT_TEMPLATE_ID,
  );
  if (!newCid) {
    throw new Error(
      "Withdraw account created but contract id not found in transaction response.",
    );
  }
  return newCid;
}

/**
 * Step 3 (read-only): List the user's spendable cBTC Holding contracts.
 *
 * Locked holdings (in an active transfer) are filtered out. The contract ids
 * of the selected holdings are passed as the `tokens` argument to the burn.
 */
export async function listSpendableHoldings(
  provider: LoopProvider,
): Promise<HoldingSummary[]> {
  const contracts = await provider.getActiveContracts({
    interfaceId: HOLDING_INTERFACE_ID,
  });
  return contracts
    .map((c) => {
      const cAny = c as unknown as Record<string, unknown>;
      return {
        contractId: c.contract_id,
        amount: extractAmount(cAny),
        payload: cAny,
      };
    })
    .filter((h) => !isLocked(h.payload));
}

/**
 * Step 4: Exercise the burn choice. Triggers a Loop popup.
 *
 * Confirmed shape from BitSafe docs:
 *   actAs: [USER_PARTY_ID]
 *   choice: CBTCWithdrawAccount_Withdraw
 *   choiceArgument: { amount, tokens: holdingCids, burnMintFactoryCid, extraArgs }
 *   disclosedContracts: all 5 token-standard contracts
 *
 * After this succeeds, the attestors detect the burn on Canton and send
 * BTC to destinationBtcAddress (out-of-band, no further app action needed).
 */
export async function submitWithdraw(
  provider: LoopProvider,
  userParty: string,
  withdrawAccountContractId: string,
  amount: string,
  holdingContractIds: string[],
): Promise<unknown> {
  const ts = await getTokenStandardContracts();

  const choiceArgument = {
    amount,
    tokens: holdingContractIds,
    burnMintFactoryCid: ts.burn_mint_factory.contract_id,
    extraArgs: {
      context: {
        values: {
          "utility.digitalasset.com/instrument-configuration": {
            tag: "AV_ContractId",
            value: ts.instrument_configuration.contract_id,
          },
          "utility.digitalasset.com/app-reward-configuration": {
            tag: "AV_ContractId",
            value: ts.app_reward_configuration.contract_id,
          },
          "utility.digitalasset.com/featured-app-right": {
            tag: "AV_ContractId",
            value: ts.featured_app_right.contract_id,
          },
          "utility.digitalasset.com/issuer-credentials": {
            tag: "AV_List",
            value: [
              {
                tag: "AV_ContractId",
                value: ts.issuer_credential.contract_id,
              },
            ],
          },
        },
      },
      meta: {
        values: {
          "splice.lfdecentralizedtrust.org/reason": "CBTC Burn",
        },
      },
    },
  };

  return provider.submitTransaction(
    {
      actAs: [userParty],
      disclosedContracts: [
        toDisclosed(ts.burn_mint_factory),
        toDisclosed(ts.featured_app_right),
        toDisclosed(ts.instrument_configuration),
        toDisclosed(ts.issuer_credential),
        toDisclosed(ts.app_reward_configuration),
      ],
      commands: [
        {
          ExerciseCommand: {
            templateId: WITHDRAW_ACCOUNT_TEMPLATE_ID,
            contractId: withdrawAccountContractId,
            choice: WITHDRAW_CHOICE,
            choiceArgument,
          },
        },
      ],
    },
    {
      message: `Burn ${amount} cBTC`,
      executionMode: "wait",
    },
  );
}

/**
 * Optional read: list outstanding CBTCWithdrawRequest contracts.
 * Created by the coordinator after the burn; can be used to show
 * bridging-in-progress state to the user.
 */
export async function listWithdrawRequests(
  provider: LoopProvider,
): Promise<WithdrawRequestSummary[]> {
  const contracts = await provider.getActiveContracts({
    templateId: WITHDRAW_REQUEST_TEMPLATE_ID,
  });
  return contracts.map((c) => ({
    contractId: c.contract_id,
    payload: c as unknown as Record<string, unknown>,
  }));
}

/* -------------------------- helpers -------------------------- */

function toDisclosed(c: CoordinatorContract) {
  return {
    templateId: c.template_id,
    contractId: c.contract_id,
    createdEventBlob: c.created_event_blob,
    synchronizerId: "",
  };
}

function extractBtcAddress(c: Record<string, unknown>): string | null {
  const candidates = [
    (c.create_argument as Record<string, unknown> | undefined)?.destinationBtcAddress,
    (c.payload as Record<string, unknown> | undefined)?.destinationBtcAddress,
    (c.createArgument as Record<string, unknown> | undefined)?.destinationBtcAddress,
    c.destinationBtcAddress,
  ];
  for (const v of candidates) {
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

function extractAmount(c: Record<string, unknown>): string | null {
  const candidates = [
    (c.interface_views as Array<{ view_value?: { amount?: string } }> | undefined)?.[0]
      ?.view_value?.amount,
    (c.interfaceViews as Array<{ viewValue?: { amount?: string } }> | undefined)?.[0]
      ?.viewValue?.amount,
    (c.payload as Record<string, unknown> | undefined)?.amount,
    c.amount,
  ];
  for (const v of candidates) {
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

function isLocked(c: Record<string, unknown>): boolean {
  const view =
    (c.interface_views as Array<{ view_value?: { lock?: unknown } }> | undefined)?.[0]
      ?.view_value ??
    (c.interfaceViews as Array<{ viewValue?: { lock?: unknown } }> | undefined)?.[0]
      ?.viewValue;
  if (!view) return false;
  const lock = (view as { lock?: unknown }).lock;
  return lock !== null && lock !== undefined;
}

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

export type { TokenStandardContracts };

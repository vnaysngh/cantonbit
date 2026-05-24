/**
 * Coordinator (DLC.link / BitSafe attestor network) HTTP client.
 *
 * These three endpoints are the only coordinator calls in the mint/burn flow.
 * Official reference: https://docs.bitsafe.finance/developers/cbtc-minting-and-burning
 *
 * Coordinator hosts (no auth required — public endpoints):
 *   devnet:  https://devnet.dlc.link/attestor-2
 *   testnet: https://testnet.dlc.link/attestor-1
 *   mainnet: https://mainnet.dlc.link/attestor-1
 *
 * All POSTs use Content-Type: application/json and include the `chain` field.
 * Chain values: "canton-devnet" | "canton-testnet" | "canton-mainnet"
 */

import { NETWORK } from "./constants";

/** Raw shape of a Canton contract reference returned by coordinator endpoints. */
export interface CoordinatorContract {
  contract_id: string;
  template_id: string;
  created_event_blob: string;
}

/**
 * Response from /app/get-account-contract-rules.
 *
 * Both factory contracts must be disclosed when exercising their choices:
 *  - da_rules → CreateDepositAccount (mint)
 *  - wa_rules → CreateWithdrawAccount (burn)
 */
export interface AccountContractRules {
  da_rules: CoordinatorContract;
  wa_rules: CoordinatorContract;
}

/**
 * Response from /app/get-token-standard-contracts.
 *
 * All five contracts must be disclosed AND referenced in choiceArgument.extraArgs
 * when exercising CBTCWithdrawAccount_Withdraw.
 */
export interface TokenStandardContracts {
  burn_mint_factory: CoordinatorContract;
  instrument_configuration: CoordinatorContract;
  app_reward_configuration: CoordinatorContract;
  featured_app_right: CoordinatorContract;
  issuer_credential: CoordinatorContract;
}

async function coordinatorPost<T>(path: string, body: unknown): Promise<T> {
  const url = `${NETWORK.coordinatorUrl}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "<no body>");
    throw new Error(
      `Coordinator POST ${path} failed (${res.status} ${res.statusText}): ${text}`,
    );
  }
  return (await res.json()) as T;
}

/**
 * Step 1 of both mint and burn flows.
 *
 * Fetches the two shared factory contracts. These are disclosed in the
 * transaction that creates a DepositAccount (mint) or WithdrawAccount (burn).
 *
 * Mint flow ref: https://docs.bitsafe.finance/developers/cbtc-minting-and-burning
 * Step: "1. Authenticate (get JWT)" → "2. Create Deposit Account"
 * The da_rules contract_id is the contractId in the ExerciseCommand.
 */
export async function getAccountContractRules(): Promise<AccountContractRules> {
  return coordinatorPost<AccountContractRules>(
    "/app/get-account-contract-rules",
    { chain: NETWORK.chain },
  );
}

/**
 * Step 3 of the mint flow (after DepositAccount is created on-ledger).
 *
 * Returns the taproot P2TR BTC deposit address for the user's DepositAccount.
 * Address format depends on network:
 *   devnet  → bcrt1p... (regtest)
 *   testnet → tb1p...  (testnet3)
 *   mainnet → bc1p...  (mainnet bech32m)
 *
 * @param depositAccountContractId The contract_id of the user's CBTCDepositAccount.
 */
export async function getBitcoinAddress(
  depositAccountContractId: string,
): Promise<string> {
  const resp = await coordinatorPost<{ address: string }>(
    "/app/get-bitcoin-address",
    { id: depositAccountContractId, chain: NETWORK.chain },
  );
  return resp.address;
}

/**
 * Burn flow: fetch the token-standard context contracts required by
 * CBTCWithdrawAccount_Withdraw. Must be called before the withdraw submit.
 *
 * All five are disclosed in the transaction AND referenced by contract_id
 * in choiceArgument.extraArgs.context.values.
 */
export async function getTokenStandardContracts(): Promise<TokenStandardContracts> {
  return coordinatorPost<TokenStandardContracts>(
    "/app/get-token-standard-contracts",
    { chain: NETWORK.chain },
  );
}

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

const TAG = "[bitsafe]";

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
  /** Optional — not returned by all coordinator deployments (absent on mainnet as of 2026-05). Always check before use. */
  featured_app_right?: CoordinatorContract;
  issuer_credential: CoordinatorContract;
}

async function coordinatorGet<T>(path: string): Promise<T> {
  const url = `${NETWORK.coordinatorUrl}${path}`;
  console.log(`${TAG} GET ${url}`);

  const res = await fetch(url, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
  });

  console.log(`${TAG} response status=${res.status} url=${url}`);

  if (!res.ok) {
    const text = await res.text().catch(() => "<no body>");
    console.error(`${TAG} coordinator error path=${path} status=${res.status} body=${text}`);
    throw new Error(
      `Coordinator GET ${path} failed (${res.status} ${res.statusText}): ${text}`,
    );
  }

  const data = await res.json() as T;
  console.log(`${TAG} response keys=${Object.keys(data as object).join(",")}`);
  return data;
}

/**
 * Step 1 of both mint and burn flows.
 * Fetches da_rules (mint) and wa_rules (burn) factory contracts.
 */
export async function getAccountContractRules(): Promise<AccountContractRules> {
  console.log(`${TAG} getAccountContractRules network=${NETWORK.name}`);
  return coordinatorGet<AccountContractRules>("/cbtc/v1/account-contract-rules");
}

/**
 * Step 3 of the mint flow (after DepositAccount is created on-ledger).
 * Returns the taproot P2TR BTC deposit address.
 *   devnet  → bcrt1p...
 *   testnet → tb1p...
 *   mainnet → bc1p...
 */
export async function getBitcoinAddress(
  depositAccountContractId: string,
): Promise<string> {
  console.log(`${TAG} getBitcoinAddress depositAccountContractId=${depositAccountContractId} chain=${NETWORK.chain}`);

  // New API: GET /cbtc/v1/bitcoin-address/<contractId> — returns JSON { bitcoin_address: string }
  const url = `${NETWORK.coordinatorUrl}/cbtc/v1/bitcoin-address/${depositAccountContractId}`;
  console.log(`${TAG} GET ${url}`);

  const res = await fetch(url, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
  });

  console.log(`${TAG} response status=${res.status}`);

  if (!res.ok) {
    const text = await res.text().catch(() => "<no body>");
    console.error(`${TAG} coordinator error status=${res.status} body=${text}`);
    throw new Error(`Coordinator get-bitcoin-address failed (${res.status}): ${text}`);
  }

  const data = await res.json() as { bitcoin_address?: string };
  const address = data.bitcoin_address?.trim() ?? "";
  if (!address) throw new Error("Coordinator returned empty bitcoin address");
  console.log(`${TAG} bitcoin address=${address}`);
  return address;
}

/**
 * Burn flow: fetch the 5 token-standard context contracts.
 * Must be called before the withdraw submit.
 * All five are disclosed in the transaction AND referenced in choiceArgument.extraArgs.
 */
export async function getTokenStandardContracts(): Promise<TokenStandardContracts> {
  console.log(`${TAG} getTokenStandardContracts network=${NETWORK.name}`);
  return coordinatorGet<TokenStandardContracts>("/cbtc/v1/token-standard-contracts");
}

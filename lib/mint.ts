/**
 * Mint flow — bridging native BTC into CBTC on Canton.
 *
 * Steps (per BitSafe docs):
 *   1. POST /api/mint/account-contract-rules  → da_rules contract (server proxies coordinator)
 *   2. POST /api/mint/create-deposit-account  → CBTCDepositAccount contract ID
 *      (m2m JWT + WarpX party as actAs, user partyId as owner)
 *   3. POST /api/mint/bitcoin-address         → bc1p… taproot address
 *   4. User sends BTC to that address
 *   5. Attestors monitor Bitcoin for 6 confirmations (~60 min)
 *   6. Attestors submit ConfirmDepositAction on Canton
 *   7. CBTC minted to user's party (~60–120s after confirmation 6)
 *
 * Minimum mint amount: 0.001 BTC
 */

const TAG = "[mint]";

/** Minimum mint amount in satoshis (0.001 BTC). */
export const MIN_MINT_SATS = 100_000n;

// UTXO_WARN_THRESHOLD lives in lib/constants.ts — single source of truth.
export { UTXO_WARN_THRESHOLD } from "./constants";

/**
 * Step 1+2: Create a CBTCDepositAccount via server route.
 *
 * Server route uses m2m JWT + WarpX party (actAs) with the user's partyId as owner.
 * This bypasses the cantonloop.com DAR vetting issue — the WarpX node has CBTC vetted.
 */
export async function createDepositAccount(partyId: string): Promise<string> {
  console.log(`${TAG} createDepositAccount partyId=${partyId.slice(0, 30)}...`);

  const res = await fetch("/api/mint/create-deposit-account", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ partyId })
  });

  const data = (await res.json()) as { contractId?: string; error?: string };
  console.log(
    `${TAG} create-deposit-account response status=${res.status} contractId=${data.contractId ?? "none"} error=${data.error ?? "none"}`
  );

  if (!res.ok || !data.contractId) {
    throw new Error(
      data.error ?? `Create deposit account failed (${res.status})`
    );
  }

  return data.contractId;
}

/**
 * Step 3: Fetch the Bitcoin deposit address via server route.
 * Coordinator blocks CORS from browser — must proxy through Next.js server.
 * Returns a taproot P2TR address (bcrt1p / tb1p / bc1p depending on network).
 */
export async function getDepositAddress(
  depositAccountContractId: string
): Promise<string> {
  console.log(
    `${TAG} getDepositAddress for contractId=${depositAccountContractId}`
  );

  const res = await fetch("/api/mint/bitcoin-address", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ depositAccountContractId })
  });

  const data = (await res.json()) as { address?: string; error?: string };
  if (!res.ok || !data.address) {
    throw new Error(
      data.error ?? `Failed to get bitcoin address (${res.status})`
    );
  }

  console.log(`${TAG} bitcoin deposit address=${data.address}`);
  return data.address;
}

/** A reader for the user's current unlocked CBTC balance (BTC string). The mint
 *  page supplies one backed by the Loop wallet (provider.getHolding). */
export type BalanceReader = () => Promise<string>;

/**
 * Snapshot the user's current unlocked CBTC balance, for mint polling. The
 * balance now comes from the user's CONNECTED LOOP WALLET (the app's m2m JWT
 * cannot read a Loop party on another participant). The caller passes a
 * `read` function — typically backed by the Loop provider — so this stays a
 * pure helper.
 *
 * Poll every 30s — mint complete when balance > snapshot.
 */
export async function snapshotHoldingBalance(
  read: BalanceReader
): Promise<string> {
  const total = await read();
  console.log(`${TAG} snapshotHoldingBalance total=${total} BTC`);
  return total;
}

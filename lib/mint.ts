/**
 * Mint flow — bridging native BTC into cBTC on Canton.
 *
 * Steps (per BitSafe docs):
 *   1. POST /api/mint/account-contract-rules  → da_rules contract (server proxies coordinator)
 *   2. POST /api/mint/create-deposit-account  → CBTCDepositAccount contract ID
 *      (m2m JWT + WarpX party as actAs, user partyId as owner)
 *   3. POST /api/mint/bitcoin-address         → bc1p… taproot address
 *   4. User sends BTC to that address
 *   5. Attestors monitor Bitcoin for 6 confirmations (~60 min)
 *   6. Attestors submit ConfirmDepositAction on Canton
 *   7. cBTC minted to user's party (~60–120s after confirmation 6)
 *
 * Minimum mint amount: 0.001 BTC
 */

import { NETWORK } from "./constants";
import { formatSatoshis } from "./format";
import type { Holding } from "@/lib/types";

const TAG = "[mint]";

/** Minimum mint amount in satoshis (0.001 BTC). */
export const MIN_MINT_SATS = 100_000n;

// UTXO_WARN_THRESHOLD lives in lib/constants.ts — single source of truth.
export { UTXO_WARN_THRESHOLD } from "./constants";

/**
 * Step 1+2: Create a CBTCDepositAccount via server route.
 *
 * Server route uses m2m JWT + WarpX party (actAs) with the user's partyId as owner.
 * This bypasses the cantonloop.com DAR vetting issue — the WarpX node has cBTC vetted.
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

/**
 * Snapshot a party's current unlocked cBTC holding balance, for mint polling.
 * Fetches from the server route GET /api/canton/holdings (m2m JWT — no Loop SDK).
 *
 * @param partyId  Which party's balance to read. The mint page passes the
 *   USER's party so it observes cBTC actually LANDING in the user wallet
 *   (delivered by the server-side cron processor). Defaults to the warpx
 *   holding party for backward compatibility.
 *
 * Poll every 30s — mint complete for this party when balance > snapshot.
 */
export async function snapshotHoldingBalance(
  partyId: string = NETWORK.warpxPartyId,
): Promise<string> {
  const res = await fetch(
    `/api/canton/holdings?partyId=${encodeURIComponent(partyId)}`
  );

  const data = (await res.json()) as {
    holdings?: Holding[];
    error?: string;
  };

  if (!res.ok) {
    throw new Error(data.error ?? `Holdings fetch failed (${res.status})`);
  }

  const holdings = data.holdings ?? [];

  // Filter to unlocked cBTC only (same logic as useBalance).
  const cbtcUnlocked = holdings.filter(
    (h) =>
      h.payload.instrumentId.id === NETWORK.instrumentId.id &&
      h.payload.instrumentId.admin === NETWORK.instrumentId.admin &&
      (h.payload.lock === null || h.payload.lock === undefined)
  );

  let totalSats = 0;
  for (const h of cbtcUnlocked) {
    const n = parseFloat(h.payload.amount ?? "0");
    if (!isNaN(n)) totalSats += Math.round(n * 1e8);
  }

  const total = formatSatoshis(BigInt(totalSats));
  console.log(
    `${TAG} snapshotHoldingBalance holdings=${cbtcUnlocked.length} total=${total} BTC`
  );
  return total;
}

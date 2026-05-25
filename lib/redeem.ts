/**
 * Redeem (burn) flow — bridging cBTC back to native BTC.
 *
 * Official reference: https://docs.bitsafe.finance/developers/cbtc-minting-and-burning
 *
 * Steps (per BitSafe docs):
 *   1. POST /api/redeem/find-withdraw-account    → existing account for this btc address (or null)
 *   2. POST /api/redeem/create-withdraw-account  → create CBTCWithdrawAccount if none exists
 *      (server route — uses m2m JWT)
 *   3. GET  /api/canton/holdings                 → user's spendable holdings (server-side m2m JWT)
 *   4. POST /api/redeem/submit-withdraw          → exercise CBTCWithdrawAccount_Withdraw
 *      (server route — uses m2m JWT)
 *
 * After step 4, attestors detect the burn on Canton and send BTC automatically.
 * No polling needed — show "Bitcoin will arrive within 30-60 minutes."
 */

import { NETWORK } from "./constants";
import type { Holding } from "@/lib/types";

export { UTXO_WARN_THRESHOLD } from "./constants";

export interface WithdrawAccountSummary {
  contractId: string;
  destinationBtcAddress: string | null;
  createdEventBlob: string | null;
  payload: Record<string, unknown>;
}

export interface HoldingSummary {
  contractId: string;
  /** Decimal-string cBTC amount. */
  amount: string | null;
  payload: Record<string, unknown>;
}

/**
 * Check if the user already has a CBTCWithdrawAccount for this destination address.
 * Calls server route which queries LEDGER_HOST with m2m JWT.
 *
 * Returns the account if found, null if none exists.
 */
export async function findExistingWithdrawAccount(
  partyId: string,
  destinationBtcAddress: string,
): Promise<{ contractId: string; createdEventBlob: string } | null> {
  const res = await fetch("/api/redeem/find-withdraw-account", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ partyId, destinationBtcAddress }),
  });

  const data = await res.json() as {
    contractId?: string | null;
    createdEventBlob?: string;
    error?: string;
  };

  if (!res.ok) {
    throw new Error(data.error ?? `find-withdraw-account failed (${res.status})`);
  }

  if (!data.contractId) return null;
  return { contractId: data.contractId, createdEventBlob: data.createdEventBlob ?? "" };
}

/**
 * Create a CBTCWithdrawAccount for the user on Canton.
 * Calls server route which uses m2m JWT to submit to LEDGER_HOST.
 *
 * Returns { contractId, createdEventBlob } — both needed for the withdraw step.
 */
export async function createWithdrawAccount(
  partyId: string,
  destinationBtcAddress: string,
): Promise<{ contractId: string; createdEventBlob: string }> {
  const res = await fetch("/api/redeem/create-withdraw-account", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ partyId, destinationBtcAddress }),
  });

  const data = await res.json() as {
    contractId?: string;
    createdEventBlob?: string;
    error?: string;
  };

  if (!res.ok || !data.contractId) {
    throw new Error(data.error ?? `Create withdraw account failed (${res.status})`);
  }

  return { contractId: data.contractId, createdEventBlob: data.createdEventBlob ?? "" };
}

/**
 * List the user's spendable cBTC holdings via the server route GET /api/canton/holdings.
 * Uses m2m JWT on the WarpX party — no Loop SDK needed.
 * Filters out locked holdings (in-flight transfers).
 */
export async function listSpendableHoldings(
  partyId: string,
): Promise<HoldingSummary[]> {
  const res = await fetch(
    `/api/canton/holdings?partyId=${encodeURIComponent(partyId)}`,
  );

  const data = (await res.json()) as {
    holdings?: Holding[];
    error?: string;
  };

  if (!res.ok) {
    throw new Error(data.error ?? `Holdings fetch failed (${res.status})`);
  }

  const holdings = data.holdings ?? [];

  return holdings
    .filter((h) => {
      // Keep only unlocked cBTC holdings.
      const isCbtc =
        h.payload.instrumentId.id === NETWORK.instrumentId.id &&
        h.payload.instrumentId.admin === NETWORK.instrumentId.admin;
      const isUnlocked = h.payload.lock === null || h.payload.lock === undefined;
      return isCbtc && isUnlocked;
    })
    .map((h) => ({
      contractId: h.contractId,
      amount: h.payload.amount ?? null,
      payload: h.payload as unknown as Record<string, unknown>,
    }));
}

/**
 * Select the minimum set of holdings (greedy, largest first) that cover the amount.
 * Validates client-side before submitting — throws if holdings are insufficient.
 */
export function selectHoldings(
  holdings: HoldingSummary[],
  amountBtc: string,
): string[] {
  const target = parseFloat(amountBtc);
  if (isNaN(target) || target <= 0) throw new Error("Invalid amount");

  const sorted = [...holdings]
    .filter((h) => h.amount !== null && parseFloat(h.amount!) > 0)
    .sort((a, b) => parseFloat(b.amount!) - parseFloat(a.amount!));

  let accumulated = 0;
  const selected: string[] = [];

  for (const h of sorted) {
    selected.push(h.contractId);
    accumulated += parseFloat(h.amount!);
    if (accumulated >= target) break;
  }

  if (accumulated < target) {
    throw new Error(
      `Insufficient balance: have ${accumulated.toFixed(8)} BTC, need ${amountBtc} BTC. Some holdings may be locked in an in-flight transaction.`,
    );
  }

  return selected;
}

/**
 * Exercise the burn choice on the user's WithdrawAccount.
 * Calls server route which uses m2m JWT to submit to LEDGER_HOST.
 *
 * After success, attestors detect the burn on Canton and send BTC automatically.
 */
export async function submitWithdraw(
  partyId: string,
  withdrawAccountContractId: string,
  withdrawAccountCreatedEventBlob: string,
  holdingCids: string[],
  amount: string,
): Promise<void> {
  const res = await fetch("/api/redeem/submit-withdraw", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      partyId,
      withdrawAccountContractId,
      withdrawAccountCreatedEventBlob,
      holdingCids,
      amount,
    }),
  });

  const data = await res.json() as { ok?: boolean; error?: string };

  if (!res.ok || !data.ok) {
    throw new Error(data.error ?? `Submit withdraw failed (${res.status})`);
  }
}

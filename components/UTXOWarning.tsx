"use client";

import { UTXO_HARD_LIMIT, UTXO_WARN_THRESHOLD } from "@/lib/constants";

interface Props {
  count: number;
}

export function UTXOWarning({ count }: Props) {
  // count === -1 means "unknown / not loaded yet". Bail out silently.
  if (count < 0) return null;
  if (count < UTXO_WARN_THRESHOLD) return null;
  const atLimit = count >= UTXO_HARD_LIMIT;

  return (
    <div
      role="alert"
      className={
        atLimit
          ? "rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive-foreground"
          : "rounded-md border border-amber-400/40 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"
      }
    >
      {atLimit ? (
        <>
          You have reached the UTXO limit ({count}/{UTXO_HARD_LIMIT}). Receive
          a consolidation transfer or wait for outgoing sends to clear before
          accepting more inbound transfers.
        </>
      ) : (
        <>
          You currently hold {count} UTXOs. Canton limits parties to{" "}
          {UTXO_HARD_LIMIT}; consider consolidating before you hit the cap.
        </>
      )}
    </div>
  );
}

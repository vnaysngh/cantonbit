"use client";

import { UTXO_WARN_THRESHOLD } from "@/lib/constants";

interface Props {
  count: number;
}

export function UTXOWarning({ count }: Props) {
  if (count <= 0 || count < UTXO_WARN_THRESHOLD) return null;

  return (
    <div
      role="alert"
      className="rounded-md border border-amber-400/40 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"
    >
      You currently hold {count} CBTC UTXOs. Consider redeeming some to
      consolidate your holdings.
    </div>
  );
}

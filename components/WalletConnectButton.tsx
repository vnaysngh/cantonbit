"use client";

import { NETWORK } from "@/lib/constants";
import { truncatePartyId } from "@/lib/format";

/**
 * WalletConnectButton — previously showed Loop wallet connect/disconnect UI.
 * The Loop wallet has been removed; the WarpX party identity is now fixed
 * server-side. This component now simply displays the truncated WarpX party ID.
 *
 * It is no longer rendered in TopNav (TopNav inlines the party badge directly),
 * but is kept here in case other consumers reference it.
 */
export function WalletConnectButton() {
  return (
    <span
      className="rounded-md bg-muted px-2 py-1 font-mono text-xs"
      title={NETWORK.warpxPartyId}
    >
      {truncatePartyId(NETWORK.warpxPartyId)}
    </span>
  );
}

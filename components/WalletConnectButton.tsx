"use client";

import { Button } from "@/components/ui/button";
import { useWallet } from "@/hooks/useWallet";
import { truncatePartyId } from "@/lib/format";

export function WalletConnectButton() {
  const { isConnected, partyId, isConnecting, connect, disconnect } = useWallet();

  if (isConnected && partyId) {
    return (
      <div className="flex items-center gap-2">
        <span
          className="rounded-md bg-muted px-2 py-1 font-mono text-xs"
          title={partyId}
        >
          {truncatePartyId(partyId)}
        </span>
        <Button variant="outline" size="sm" onClick={disconnect}>
          Disconnect
        </Button>
      </div>
    );
  }

  return (
    <Button
      onClick={() => {
        connect().catch((err) => {
          console.error("Wallet connect failed:", err);
        });
      }}
      disabled={isConnecting}
    >
      {isConnecting ? "Connecting…" : "Connect Loop wallet"}
    </Button>
  );
}

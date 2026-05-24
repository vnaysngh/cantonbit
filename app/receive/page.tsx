"use client";

import { AddressQR } from "@/components/AddressQR";
import { Button } from "@/components/ui/button";
import { useWallet } from "@/hooks/useWallet";

export default function ReceivePage() {
  const { isConnected, partyId, connect } = useWallet();

  if (!isConnected || !partyId) {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <p className="mb-4 text-sm text-muted-foreground">
          Connect your wallet to view your receive address.
        </p>
        <Button onClick={() => connect().catch(console.error)}>
          Connect Loop wallet
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Receive cBTC</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Share this Canton party ID with anyone sending you cBTC.
        </p>
      </div>

      <AddressQR
        value={partyId}
        label="Scan with the sender's Loop wallet or copy below."
        size={224}
      />
    </div>
  );
}

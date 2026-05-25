"use client";

import { AddressQR } from "@/components/AddressQR";
import { useWallet } from "@/hooks/useWallet";

export default function ReceivePage() {
  const { partyId } = useWallet();

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
        label="Scan or copy the WarpX party ID below to receive cBTC."
        size={224}
      />
    </div>
  );
}

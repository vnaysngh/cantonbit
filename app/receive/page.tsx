"use client";

import { useCallback, useEffect, useState } from "react";

import { AddressQR } from "@/components/AddressQR";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useBalance } from "@/hooks/useBalance";
import { useWallet } from "@/hooks/useWallet";

interface PendingOffer {
  contractId: string;
  sender: string;
  receiver: string;
  amountBtc: string;
  requestedAt: string;
  executeBefore: string;
  inputHoldingCids: string[];
}

/** Background poll interval for pending offers (ms). */
const POLL_INTERVAL_MS = 30_000;

function truncateParty(party: string): string {
  if (!party) return "";
  const [name, hash] = party.split("::");
  if (!hash) return party;
  return `${name}…${hash.slice(-8)}`;
}

export default function ReceivePage() {
  const { partyId } = useWallet();
  const { refetch: refetchBalance } = useBalance();

  const [offers, setOffers] = useState<PendingOffer[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Track per-offer accept state so multiple accepts can be in flight at once
  // (and we can disable just the one that's pending without freezing the list).
  const [accepting, setAccepting] = useState<Record<string, boolean>>({});

  const loadOffers = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/transfers/pending", { cache: "no-store" });
      const data = (await res.json()) as { offers?: PendingOffer[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? `Failed (${res.status})`);
      setOffers(data.offers ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Initial load + background polling (pause when tab is hidden).
  useEffect(() => {
    if (!partyId) return;
    setLoading(true);
    loadOffers().finally(() => setLoading(false));

    let intervalId: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (intervalId) return;
      intervalId = setInterval(() => void loadOffers(), POLL_INTERVAL_MS);
    };
    const stop = () => {
      if (!intervalId) return;
      clearInterval(intervalId);
      intervalId = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void loadOffers();
        start();
      } else {
        stop();
      }
    };
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [partyId, loadOffers]);

  const accept = async (offerContractId: string) => {
    setAccepting((s) => ({ ...s, [offerContractId]: true }));
    try {
      const res = await fetch("/api/transfers/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offerContractId }),
      });
      const data = (await res.json()) as { updateId?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? `Accept failed (${res.status})`);
      // Drop the accepted offer from the list immediately; the next poll will
      // confirm it's gone. Also refresh the balance card.
      setOffers((current) => current.filter((o) => o.contractId !== offerContractId));
      refetchBalance();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAccepting((s) => {
        const next = { ...s };
        delete next[offerContractId];
        return next;
      });
    }
  };

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Receive CBTC</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Share this Canton party ID with anyone sending you CBTC.
        </p>
      </div>

      <AddressQR
        value={partyId}
        label="Scan or copy the Canton party ID below to receive CBTC."
        size={224}
      />

      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-base font-medium">Incoming offers</h2>
          {loading && offers.length === 0 && (
            <span className="text-xs text-muted-foreground">Loading…</span>
          )}
        </div>

        {error && (
          <p className="text-xs text-destructive">{error}</p>
        )}

        {offers.length === 0 && !loading && !error && (
          <Card>
            <CardContent className="py-6 text-center text-sm text-muted-foreground">
              No pending offers.
            </CardContent>
          </Card>
        )}

        {offers.map((o) => (
          <Card key={o.contractId}>
            <CardHeader className="pb-2">
              <CardTitle className="text-base font-medium">
                {o.amountBtc} CBTC
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="text-xs text-muted-foreground space-y-1">
                <div>
                  <span className="text-foreground">From:</span>{" "}
                  <span className="font-mono">{truncateParty(o.sender)}</span>
                </div>
                {o.executeBefore && (
                  <div>
                    <span className="text-foreground">Expires:</span>{" "}
                    {new Date(o.executeBefore).toLocaleString()}
                  </div>
                )}
              </div>
              <Button
                onClick={() => void accept(o.contractId)}
                disabled={!!accepting[o.contractId]}
                className="w-full"
              >
                {accepting[o.contractId] ? "Accepting…" : "Accept"}
              </Button>
            </CardContent>
          </Card>
        ))}
      </section>
    </div>
  );
}

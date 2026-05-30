"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { AddressQR } from "@/components/AddressQR";
import { BalanceBadge } from "@/components/BalanceBadge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useBalance } from "@/hooks/useBalance";
import { useWallet } from "@/hooks/useWallet";
import { formatSatoshis } from "@/lib/format";
import {
  createDepositAccount,
  getDepositAddress,
  snapshotHoldingBalance,
} from "@/lib/mint";

type Stage =
  | { kind: "idle" }
  | { kind: "recovering" }
  | { kind: "creating-account" }
  | { kind: "fetching-address"; depositAccountCid: string }
  | { kind: "ready"; depositAccountCid: string; address: string }
  | { kind: "minted"; amount: string }
  | { kind: "error"; message: string };

export default function MintPage() {
  const { partyId } = useWallet();
  const { total, refetch: refetchBalance } = useBalance();

  const [stage, setStage] = useState<Stage>({ kind: "recovering" });
  const baselineRef = useRef<string | null>(null);
  // The most recently recovered/created deposit account — reused across "Mint more" cycles
  // so we never create a new Canton contract unless there are literally zero existing ones.
  const existingAccountRef = useRef<{ depositAccountCid: string; address: string } | null>(null);

  // On mount: find the most recent CBTCDepositAccount for this party and recover its
  // bitcoin address. Prevents creating a new contract on every page refresh.
  useEffect(() => {
    if (!partyId) return; // wait until wallet is connected and partyId is available
    (async () => {
      try {
        const res = await fetch("/api/mint/list-deposit-accounts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ partyId }),
        });
        const data = await res.json() as { accounts?: Array<{ contractId: string; bitcoinAddress?: string }> };
        const accounts = data.accounts ?? [];

        // Use the most recent account (last in array — Canton returns in creation order)
        const existing = accounts[accounts.length - 1];
        if (!existing) {
          setStage({ kind: "idle" });
          return;
        }

        // Use cached bitcoin address if available, otherwise fetch from coordinator
        let address = existing.bitcoinAddress ?? "";
        if (!address) {
          const addrRes = await fetch("/api/mint/bitcoin-address", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ depositAccountContractId: existing.contractId }),
          });
          const addrData = await addrRes.json() as { address?: string };
          address = addrData.address ?? "";
        }

        if (!address) {
          setStage({ kind: "idle" });
          return;
        }

        existingAccountRef.current = { depositAccountCid: existing.contractId, address };
        // Baseline = the USER's current balance. We poll the user party and flip
        // to "minted" when CBTC lands there (delivered by the server-side cron).
        const baseline = await snapshotHoldingBalance(partyId);
        baselineRef.current = baseline;
        setStage({ kind: "ready", depositAccountCid: existing.contractId, address });
      } catch {
        // Recovery is best-effort — fall back to idle so user can start fresh
        setStage({ kind: "idle" });
      }
    })();
  }, [partyId]);

  const start = useCallback(async () => {
    if (!partyId) return;

    // If we already have a deposit account, reuse it — don't create another Canton contract.
    if (existingAccountRef.current) {
      const { depositAccountCid, address } = existingAccountRef.current;
      const baseline = await snapshotHoldingBalance(partyId);
      baselineRef.current = baseline;
      setStage({ kind: "ready", depositAccountCid, address });
      return;
    }

    setStage({ kind: "creating-account" });

    try {
      const depositAccountCid = await createDepositAccount(partyId);

      setStage({ kind: "fetching-address", depositAccountCid });
      const address = await getDepositAddress(depositAccountCid);

      existingAccountRef.current = { depositAccountCid, address };
      const baseline = await snapshotHoldingBalance(partyId);
      baselineRef.current = baseline;

      setStage({ kind: "ready", depositAccountCid, address });
    } catch (err) {
      setStage({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [partyId]);

  // Poll every 30s once the deposit address is shown. READ-ONLY.
  //
  // The frontend does NOT trigger the warpx→user transfer. That is the server's
  // job: the platform-agnostic cron (scripts/process-mints.sh) calls
  // /api/mint/process-transfers on a schedule, and it is the SOLE writer that
  // moves CBTC. Having the frontend also trigger it would create two writers
  // racing for the same work — so the frontend only OBSERVES.
  //
  // Flow:
  //   1. User sends BTC → BitSafe mints CBTC into warpx (~60 min, 6 confirms)
  //   2. The server cron detects it and delivers warpx → user party
  //   3. Here we poll the USER party balance; when it rises above the baseline,
  //      the CBTC has landed in the user's wallet → show "minted".
  useEffect(() => {
    if (stage.kind !== "ready") return;
    if (!partyId) return;

    const poll = setInterval(async () => {
      try {
        // Observe the USER's own balance (not warpx). It rises only once the
        // cron has delivered the mint into the user's party.
        const currentBalance = await snapshotHoldingBalance(partyId);
        const baseline = baselineRef.current ?? "0";

        const currentSats = Math.round(parseFloat(currentBalance) * 1e8);
        const baselineSats = Math.round(parseFloat(baseline) * 1e8);

        if (currentSats > baselineSats) {
          clearInterval(poll);
          // Trimmed display (no trailing zeros) — consistent with formatBtc.
          const minted = formatSatoshis(BigInt(currentSats - baselineSats));
          refetchBalance();
          setStage({ kind: "minted", amount: minted });
        }
      } catch {
        // polling errors are non-fatal — just wait for the next tick
      }
    }, 30_000);

    return () => clearInterval(poll);
  }, [stage.kind, partyId, refetchBalance]);

  // "Mint more" / "Try again": reuse existing account if we have one,
  // otherwise go to idle so user can generate a new address.
  const reset = () => {
    baselineRef.current = null;
    if (existingAccountRef.current) {
      start().catch(console.error);
    } else {
      setStage({ kind: "idle" });
    }
  };

  return (
    <div className="mx-auto max-w-lg space-y-8 py-4">
      <h1 className="text-2xl font-semibold">Mint CBTC</h1>

      {stage.kind === "recovering" && (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Checking for existing deposit account…
          </CardContent>
        </Card>
      )}

      {stage.kind === "idle" && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Generate a Bitcoin deposit address. Send at least{" "}
            <span className="font-medium text-foreground">0.001 BTC</span>{" "}
            (minimum). After 6 Bitcoin confirmations (~60 min) and attestor
            verification (~60–120 sec), CBTC will appear in your balance.
          </p>
          <Button
            onClick={() => start().catch(console.error)}
            className="w-full"
          >
            Generate deposit address
          </Button>
        </div>
      )}

      {(stage.kind === "creating-account" ||
        stage.kind === "fetching-address") && (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            {stage.kind === "creating-account" &&
              "Creating your deposit account on Canton…"}
            {stage.kind === "fetching-address" &&
              "Fetching your Bitcoin deposit address…"}
          </CardContent>
        </Card>
      )}

      {stage.kind === "ready" && (
        <div className="space-y-8">
          <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-800 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-300">
            <span aria-hidden className="mt-px shrink-0">⚠️</span>
            <span>
              Send at least <span className="font-semibold">0.001 BTC</span> to
              this address. Amounts below the minimum will not be processed and
              cannot be recovered.
            </span>
          </div>
          <AddressQR
            value={stage.address}
            label="CBTC appears after 6 Bitcoin confirmations (~60 min) plus attestor processing (~60–120 sec)."
          />
        </div>
      )}

      {stage.kind === "minted" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-green-600">CBTC received!</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">
                {stage.amount} CBTC
              </span>{" "}
              has been minted to your party.
            </p>
            <BalanceBadge amount={total} size="lg" />
            <Button onClick={reset} className="w-full">
              Mint more CBTC
            </Button>
          </CardContent>
        </Card>
      )}

      {stage.kind === "error" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-destructive">Mint failed</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <pre className="overflow-x-auto rounded bg-muted p-2 text-xs">
              {stage.message}
            </pre>
            <Button onClick={reset} className="w-full">
              Try again
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

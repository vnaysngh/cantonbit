"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { AddressQR } from "@/components/AddressQR";
import { BalanceBadge } from "@/components/BalanceBadge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useBalance } from "@/hooks/useBalance";
import { useWallet } from "@/hooks/useWallet";
import { UTXO_WARN_THRESHOLD } from "@/lib/constants";
import {
  MIN_MINT_SATS,
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
  const { total, utxoCount, refetch: refetchBalance } = useBalance();

  const [stage, setStage] = useState<Stage>({ kind: "recovering" });
  const baselineRef = useRef<string | null>(null);
  // The most recently recovered/created deposit account — reused across "Mint more" cycles
  // so we never create a new Canton contract unless there are literally zero existing ones.
  const existingAccountRef = useRef<{ depositAccountCid: string; address: string } | null>(null);

  const utxoHigh = utxoCount >= UTXO_WARN_THRESHOLD;

  // On mount: find the most recent CBTCDepositAccount for this party and recover its
  // bitcoin address. Prevents creating a new contract on every page refresh.
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/mint/list-deposit-accounts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ partyId }),
        });
        const data = await res.json() as { accounts?: Array<{ contractId: string }> };
        const accounts = data.accounts ?? [];

        // Use the most recent account (last in array — Canton returns in creation order)
        const existing = accounts[accounts.length - 1];
        if (!existing) {
          setStage({ kind: "idle" });
          return;
        }

        // Recover the bitcoin address for the most recent deposit account
        const addrRes = await fetch("/api/mint/bitcoin-address", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ depositAccountContractId: existing.contractId }),
        });
        const addrData = await addrRes.json() as { address?: string };
        if (!addrData.address) {
          setStage({ kind: "idle" });
          return;
        }

        existingAccountRef.current = { depositAccountCid: existing.contractId, address: addrData.address };
        const baseline = await snapshotHoldingBalance();
        baselineRef.current = baseline;
        setStage({ kind: "ready", depositAccountCid: existing.contractId, address: addrData.address });
      } catch {
        // Recovery is best-effort — fall back to idle so user can start fresh
        setStage({ kind: "idle" });
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = useCallback(async () => {
    if (!partyId) return;

    // If we already have a deposit account, reuse it — don't create another Canton contract.
    if (existingAccountRef.current) {
      const { depositAccountCid, address } = existingAccountRef.current;
      const baseline = await snapshotHoldingBalance();
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
      const baseline = await snapshotHoldingBalance();
      baselineRef.current = baseline;

      setStage({ kind: "ready", depositAccountCid, address });
    } catch (err) {
      setStage({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [partyId]);

  // Poll every 30s once address is shown.
  // Mint is complete when currentBalance > baseline.
  // cBTC arrives ~60-120s after Bitcoin's 6th confirmation (~60 min total).
  useEffect(() => {
    if (stage.kind !== "ready") return;

    const poll = setInterval(async () => {
      try {
        const currentBalance = await snapshotHoldingBalance();
        const baseline = baselineRef.current ?? "0";

        const currentSats = Math.round(parseFloat(currentBalance) * 1e8);
        const baselineSats = Math.round(parseFloat(baseline) * 1e8);

        if (currentSats > baselineSats) {
          clearInterval(poll);
          const minted = ((currentSats - baselineSats) / 1e8).toFixed(8);
          refetchBalance();
          setStage({ kind: "minted", amount: minted });
        }
      } catch {
        // polling errors are non-fatal — just wait for the next tick
      }
    }, 30_000);

    return () => clearInterval(poll);
  }, [stage.kind, refetchBalance]);

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
    <div className="mx-auto max-w-lg space-y-6">
      <h1 className="text-2xl font-semibold">Mint cBTC</h1>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Current balance
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          <BalanceBadge amount={total} size="lg" />
          {utxoCount > 0 && (
            <p className={utxoHigh ? "text-xs text-amber-600" : "text-xs text-muted-foreground"}>
              {utxoCount} holding{utxoCount === 1 ? "" : "s"}
              {utxoHigh && " — consider redeeming some to consolidate"}
            </p>
          )}
        </CardContent>
      </Card>

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
            verification (~60–120 sec), cBTC will appear in your balance.
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
        <div className="space-y-4">
          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300">
            ⚠️ Send at least <span className="font-semibold">0.001 BTC</span> to this address. Amounts below the minimum will not be processed and cannot be recovered.
          </div>
          <AddressQR
            value={stage.address}
            label="cBTC appears after 6 Bitcoin confirmations (~60 min) plus attestor processing (~60–120 sec)."
          />
          <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            <div>Deposit account:</div>
            <div className="mt-1 break-all font-mono">
              {stage.depositAccountCid}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Polling for new cBTC every 30 seconds. Keep this page open after
            sending Bitcoin.
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => refetchBalance()}
              className="flex-1"
            >
              Check balance
            </Button>
          </div>
        </div>
      )}

      {stage.kind === "minted" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-green-600">cBTC received!</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">
                {stage.amount} cBTC
              </span>{" "}
              has been minted to your party.
            </p>
            <BalanceBadge amount={total} size="lg" />
            <Button onClick={reset} className="w-full">
              Mint more cBTC
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

"use client";

import { useCallback, useEffect, useState } from "react";

import { AddressQR } from "@/components/AddressQR";
import { BalanceBadge } from "@/components/BalanceBadge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useBalance } from "@/hooks/useBalance";
import { useWallet } from "@/hooks/useWallet";
import {
  MIN_MINT_SATS,
  UTXO_HARD_LIMIT,
  UTXO_WARN_THRESHOLD,
  createDepositAccount,
  getDepositAddress,
  listDepositAccounts,
} from "@/lib/mint";

type Stage =
  | { kind: "idle" }
  | { kind: "checking-account" }
  | { kind: "creating-account" }
  | { kind: "fetching-address"; depositAccountCid: string }
  | { kind: "ready"; depositAccountCid: string; address: string }
  | { kind: "error"; message: string };

export default function MintPage() {
  const { isConnected, partyId, provider, connect } = useWallet();
  const { total, utxoCount, refetch: refetchBalance } = useBalance();

  const [stage, setStage] = useState<Stage>({ kind: "idle" });

  const utxoAtLimit = utxoCount >= UTXO_HARD_LIMIT;
  const utxoNearLimit = utxoCount >= UTXO_WARN_THRESHOLD && !utxoAtLimit;

  const start = useCallback(async () => {
    if (!provider || !partyId) return;
    setStage({ kind: "checking-account" });

    try {
      // Reuse an existing deposit account if the user already has one
      const existing = await listDepositAccounts(provider);
      let depositAccountCid: string;

      if (existing.length > 0) {
        depositAccountCid = existing[0].contractId;
      } else {
        // Create one — triggers Loop popup
        setStage({ kind: "creating-account" });
        depositAccountCid = await createDepositAccount(provider, partyId);
      }

      // Fetch the BTC deposit address from the coordinator
      setStage({ kind: "fetching-address", depositAccountCid });
      const address = await getDepositAddress(depositAccountCid);

      setStage({ kind: "ready", depositAccountCid, address });
    } catch (err) {
      setStage({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [provider, partyId]);

  // Once ready, poll balance every 30s. cBTC arrives ~60-120s after Bitcoin's
  // 6th confirmation (attestors need time to process after the final block).
  useEffect(() => {
    if (stage.kind !== "ready") return;
    const t = setInterval(refetchBalance, 30_000);
    return () => clearInterval(t);
  }, [stage.kind, refetchBalance]);

  const reset = () => setStage({ kind: "idle" });

  if (!isConnected) {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <p className="mb-4 text-sm text-muted-foreground">
          Connect your wallet to mint cBTC.
        </p>
        <Button onClick={() => connect().catch(console.error)}>
          Connect Loop wallet
        </Button>
      </div>
    );
  }

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
            <p
              className={
                utxoAtLimit
                  ? "text-xs text-destructive"
                  : utxoNearLimit
                    ? "text-xs text-amber-600"
                    : "text-xs text-muted-foreground"
              }
            >
              {utxoCount} / {UTXO_HARD_LIMIT} holding slots used
              {utxoAtLimit && " — at limit, cannot receive more cBTC"}
              {utxoNearLimit && " — approaching limit"}
            </p>
          )}
        </CardContent>
      </Card>

      {stage.kind === "idle" && (
        <div className="space-y-3">
          {utxoAtLimit ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
              Your wallet is at the maximum of {UTXO_HARD_LIMIT} cBTC holdings.
              Redeem some cBTC first before minting more.
            </div>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                Generate a Bitcoin deposit address. Send at least{" "}
                <span className="font-medium text-foreground">0.001 BTC</span>{" "}
                (minimum). After 6 Bitcoin confirmations (~60 min) and attestor
                verification (another 60–120 sec), cBTC will appear in your
                balance.
              </p>
              {utxoNearLimit && (
                <div className="rounded-md border border-amber-300/50 bg-amber-50/50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-900/20 dark:text-amber-400">
                  You are near the {UTXO_HARD_LIMIT}-holding limit. Consider
                  consolidating holdings before minting more.
                </div>
              )}
              <Button
                onClick={() => start().catch(console.error)}
                className="w-full"
              >
                Generate deposit address
              </Button>
            </>
          )}
        </div>
      )}

      {(stage.kind === "checking-account" ||
        stage.kind === "creating-account" ||
        stage.kind === "fetching-address") && (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            {stage.kind === "checking-account" &&
              "Checking for existing deposit account…"}
            {stage.kind === "creating-account" &&
              "Open Loop to approve creating your deposit account…"}
            {stage.kind === "fetching-address" &&
              "Fetching your Bitcoin deposit address…"}
          </CardContent>
        </Card>
      )}

      {stage.kind === "ready" && (
        <div className="space-y-4">
          <AddressQR
            value={stage.address}
            label={`Send BTC to this address. Minimum: 0.001 BTC. cBTC appears after 6 Bitcoin confirmations (~60 min) plus attestor processing (~60–120 sec).`}
          />
          <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            <div>Deposit account:</div>
            <div className="mt-1 break-all font-mono">
              {stage.depositAccountCid}
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => refetchBalance()}
              className="flex-1"
            >
              Check balance
            </Button>
            <Button variant="outline" onClick={reset} className="flex-1">
              Start over
            </Button>
          </div>
        </div>
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

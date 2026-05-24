"use client";

import { useCallback, useMemo, useState } from "react";

import { BalanceBadge } from "@/components/BalanceBadge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useBalance } from "@/hooks/useBalance";
import { useWallet } from "@/hooks/useWallet";
import { formatBtc, parseBtc } from "@/lib/format";
import { MIN_MINT_SATS } from "@/lib/mint";
import {
  createWithdrawAccount,
  listSpendableHoldings,
  listWithdrawAccounts,
  submitWithdraw,
  type HoldingSummary,
} from "@/lib/redeem";

type Stage =
  | { kind: "form" }
  | { kind: "preparing" }
  | { kind: "creating-account" }
  | { kind: "burning"; holdingsUsed: HoldingSummary[] }
  | { kind: "success"; updateId: string | null }
  | { kind: "error"; message: string };

export default function RedeemPage() {
  const { isConnected, partyId, provider, connect } = useWallet();
  const { total, refetch: refetchBalance } = useBalance();

  const [amount, setAmount] = useState("");
  const [btcAddress, setBtcAddress] = useState("");
  const [stage, setStage] = useState<Stage>({ kind: "form" });

  const balanceSats = parseBtc(total);
  const amountSats = parseBtc(amount || "0");
  const overdraft = amountSats > balanceSats;
  // Minimum redeem is the same 0.001 BTC minimum as mint (BitSafe requirement)
  const belowMin = amountSats > 0n && amountSats < MIN_MINT_SATS;
  const amountValid = amount !== "" && amountSats > 0n && !overdraft && !belowMin;
  const addressValid = btcAddress.trim().length >= 14;
  const canSubmit =
    isConnected && amountValid && addressValid && stage.kind === "form";

  const remainingDisplay = useMemo(() => {
    if (amount === "") return total;
    if (overdraft) return "0";
    return formatBtc(balanceSats - amountSats);
  }, [amount, amountSats, balanceSats, overdraft, total]);

  const submit = useCallback(async () => {
    if (!provider || !partyId) return;

    try {
      setStage({ kind: "preparing" });

      // Step 1: find or create a WithdrawAccount for this BTC destination.
      // Pass partyId so results are filtered to this user's own accounts.
      const existing = await listWithdrawAccounts(provider, partyId);
      const reusable = existing.find(
        (a) => a.destinationBtcAddress === btcAddress.trim(),
      );

      let withdrawAccountCid: string;
      if (reusable) {
        withdrawAccountCid = reusable.contractId;
      } else {
        setStage({ kind: "creating-account" });
        withdrawAccountCid = await createWithdrawAccount(
          provider,
          partyId,
          btcAddress.trim(),
        );
      }

      // Step 2: pick holdings that cover the amount (greedy, largest first).
      // Pass partyId so only this user's own holdings are considered.
      const holdings = await listSpendableHoldings(provider, partyId);
      const picked = pickHoldingsForAmount(holdings, amountSats);
      if (!picked) {
        throw new Error(
          "Not enough spendable holdings to cover the requested amount. Some holdings may be locked in an in-flight transaction.",
        );
      }

      // Step 3: burn — triggers Loop popup.
      setStage({ kind: "burning", holdingsUsed: picked });
      const txResponse = await submitWithdraw(
        provider,
        partyId,
        withdrawAccountCid,
        amount,
        picked.map((h) => h.contractId),
      );

      refetchBalance();
      setStage({
        kind: "success",
        updateId: extractUpdateId(txResponse),
      });
    } catch (err) {
      setStage({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [provider, partyId, btcAddress, amount, amountSats, refetchBalance]);

  const reset = () => {
    setAmount("");
    setBtcAddress("");
    setStage({ kind: "form" });
  };

  if (!isConnected) {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <p className="mb-4 text-sm text-muted-foreground">
          Connect your wallet to redeem cBTC.
        </p>
        <Button onClick={() => connect().catch(console.error)}>
          Connect Loop wallet
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <h1 className="text-2xl font-semibold">Redeem cBTC</h1>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Available balance
          </CardTitle>
        </CardHeader>
        <CardContent>
          <BalanceBadge amount={total} size="lg" />
        </CardContent>
      </Card>

      {stage.kind === "form" && (
        <>
          <div className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-baseline justify-between">
                <Label htmlFor="amount">Amount to burn (BTC)</Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={() => setAmount(total)}
                >
                  Max
                </Button>
              </div>
              <Input
                id="amount"
                inputMode="decimal"
                placeholder="0.00100000"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="font-mono"
              />
              {belowMin && (
                <p className="text-xs text-destructive">
                  Minimum redeem amount is 0.001 BTC.
                </p>
              )}
              {overdraft && (
                <p className="text-xs text-destructive">
                  Amount exceeds your balance.
                </p>
              )}
              {!belowMin && !overdraft && amount !== "" && (
                <p className="text-xs text-muted-foreground">
                  Remaining after burn: {remainingDisplay} cBTC
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="btc-address">Bitcoin destination address</Label>
              <Input
                id="btc-address"
                placeholder="bcrt1… (devnet) · tb1… (testnet) · bc1… (mainnet)"
                value={btcAddress}
                onChange={(e) => setBtcAddress(e.target.value)}
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Address format must match the network. A wrong-network address
                will be rejected by the bridge.
              </p>
            </div>
          </div>

          <Button
            onClick={() => submit().catch(console.error)}
            disabled={!canSubmit}
            className="w-full"
          >
            Confirm and burn
          </Button>
        </>
      )}

      {(stage.kind === "preparing" ||
        stage.kind === "creating-account" ||
        stage.kind === "burning") && (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            {stage.kind === "preparing" &&
              "Looking up your withdraw account and holdings…"}
            {stage.kind === "creating-account" &&
              "Open Loop to approve creating your withdraw account…"}
            {stage.kind === "burning" && (
              <>
                Open Loop to approve burning {amount} cBTC.
                <div className="mt-2 text-xs">
                  Using {stage.holdingsUsed.length} holding
                  {stage.holdingsUsed.length === 1 ? "" : "s"}.
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {stage.kind === "success" && (
        <Card>
          <CardHeader>
            <CardTitle>Burn submitted</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              cBTC burned. The BitSafe bridge will send BTC to{" "}
              <span className="break-all font-mono text-xs">{btcAddress}</span>{" "}
              after processing. Check the destination address on a Bitcoin block
              explorer to confirm arrival.
            </p>
            {stage.updateId && (
              <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs">
                <div className="text-muted-foreground">Canton update id:</div>
                <div className="mt-1 break-all font-mono">{stage.updateId}</div>
              </div>
            )}
            <Button onClick={reset} className="w-full">
              Redeem more
            </Button>
          </CardContent>
        </Card>
      )}

      {stage.kind === "error" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-destructive">Redeem failed</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <pre className="overflow-x-auto rounded bg-muted p-2 text-xs">
              {stage.message}
            </pre>
            <Button onClick={() => setStage({ kind: "form" })} className="w-full">
              Try again
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/**
 * Greedy holding selection: sorts by descending amount, picks until
 * the running total covers the target. Returns null if impossible.
 */
function pickHoldingsForAmount(
  holdings: HoldingSummary[],
  targetSats: bigint,
): HoldingSummary[] | null {
  const sorted = [...holdings].sort((a, b) => {
    const aSats = a.amount ? parseBtc(a.amount) : 0n;
    const bSats = b.amount ? parseBtc(b.amount) : 0n;
    return bSats > aSats ? 1 : bSats < aSats ? -1 : 0;
  });
  const picked: HoldingSummary[] = [];
  let runningTotal = 0n;
  for (const h of sorted) {
    if (runningTotal >= targetSats) break;
    picked.push(h);
    runningTotal += h.amount ? parseBtc(h.amount) : 0n;
  }
  if (runningTotal < targetSats) return null;
  return picked;
}

function extractUpdateId(txResponse: unknown): string | null {
  if (!txResponse || typeof txResponse !== "object") return null;
  const r = txResponse as {
    transactionTree?: { updateId?: string };
    transaction?: { updateId?: string };
    updateId?: string;
    update_id?: string;
  };
  return (
    r.transactionTree?.updateId ??
    r.transaction?.updateId ??
    r.updateId ??
    r.update_id ??
    null
  );
}

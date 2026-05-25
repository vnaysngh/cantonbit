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
  findExistingWithdrawAccount,
  listSpendableHoldings,
  selectHoldings,
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
  const { partyId } = useWallet();
  const { total, refetch: refetchBalance } = useBalance();

  const [amount, setAmount] = useState("");
  const [btcAddress, setBtcAddress] = useState("");
  const [stage, setStage] = useState<Stage>({ kind: "form" });

  const balanceSats = parseBtc(total);
  const amountSats = parseBtc(amount || "0");
  const overdraft = amountSats > balanceSats;
  // Minimum redeem is the same 0.001 BTC as mint (BitSafe requirement)
  const belowMin = amountSats > 0n && amountSats < MIN_MINT_SATS;
  const amountValid = amount !== "" && amountSats > 0n && !overdraft && !belowMin;
  const addressValid = btcAddress.trim().length >= 14;
  const canSubmit = amountValid && addressValid && stage.kind === "form";

  const remainingDisplay = useMemo(() => {
    if (amount === "") return total;
    if (overdraft) return "0";
    return formatBtc(balanceSats - amountSats);
  }, [amount, amountSats, balanceSats, overdraft, total]);

  const submit = useCallback(async () => {
    if (!partyId) return;

    try {
      setStage({ kind: "preparing" });

      // Step 1: find or create a WithdrawAccount for this BTC destination.
      // Queries LEDGER_HOST directly (m2m JWT) — no Loop SDK needed.
      // Reuse existing account if one already exists for this destination address.
      const existing = await findExistingWithdrawAccount(partyId, btcAddress.trim());

      let withdrawAccountCid: string;
      let withdrawAccountBlob: string;

      if (existing) {
        withdrawAccountCid = existing.contractId;
        withdrawAccountBlob = existing.createdEventBlob ?? "";
      } else {
        setStage({ kind: "creating-account" });
        const created = await createWithdrawAccount(partyId, btcAddress.trim());
        withdrawAccountCid = created.contractId;
        withdrawAccountBlob = created.createdEventBlob;
      }

      // Step 2: pick holdings that cover the amount (greedy, largest first).
      // Fetched from server route (m2m JWT) — no Loop SDK needed.
      const holdings = await listSpendableHoldings(partyId);
      let holdingCids: string[];
      try {
        holdingCids = selectHoldings(holdings, amount);
      } catch (err) {
        throw new Error(
          err instanceof Error
            ? err.message
            : "Not enough spendable holdings to cover this amount.",
        );
      }

      // Step 3: burn — submits to LEDGER_HOST directly (m2m JWT).
      setStage({ kind: "burning", holdingsUsed: holdings.filter((h) => holdingCids.includes(h.contractId)) });
      await submitWithdraw(
        partyId,
        withdrawAccountCid,
        withdrawAccountBlob,
        holdingCids,
        amount,
      );

      refetchBalance();
      setStage({ kind: "success", updateId: null });
    } catch (err) {
      setStage({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [partyId, btcAddress, amount, refetchBalance]);

  const reset = () => {
    setAmount("");
    setBtcAddress("");
    setStage({ kind: "form" });
  };

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
                Taproot (P2TR) address required. Address format must match the
                network. A wrong-network address will be rejected by the bridge.
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
              "Creating your withdraw account on Canton…"}
            {stage.kind === "burning" && (
              <>
                Burning {amount} cBTC…
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
            <CardTitle>Redemption submitted</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              cBTC burned. Bitcoin will arrive at{" "}
              <span className="break-all font-mono text-xs">{btcAddress}</span>{" "}
              within 30–60 minutes. Track it on a Bitcoin block explorer.
            </p>
            <p className="text-xs text-muted-foreground">
              If no Bitcoin arrives after 2 hours, contact{" "}
              <a
                href="mailto:support@bitsafe.finance"
                className="underline"
              >
                support@bitsafe.finance
              </a>
              .
            </p>
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

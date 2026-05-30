"use client";

import { useMemo, useState } from "react";

import { BalanceBadge } from "@/components/BalanceBadge";
import { TransactionStatus, type TxStatus } from "@/components/TransactionStatus";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useBalance } from "@/hooks/useBalance";
import { formatBtc, parseBtc } from "@/lib/format";

export default function SendPage() {
  const { total, refetch: refetchBalance } = useBalance();

  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [status, setStatus] = useState<TxStatus>("idle");
  const [statusMessage, setStatusMessage] = useState("");

  const balanceSats = parseBtc(total);
  const amountSats = parseBtc(amount || "0");
  const remainingSats = balanceSats - amountSats;
  const overdraft = amountSats > balanceSats;
  const amountValid = amount !== "" && amountSats > 0n && !overdraft;
  const recipientValid =
    recipient.trim().length > 0 && recipient.includes("::");
  const canSubmit = amountValid && recipientValid && status !== "submitting";

  const remainingDisplay = useMemo(() => {
    if (amount === "") return total;
    if (overdraft) return "0";
    return formatBtc(remainingSats);
  }, [amount, overdraft, remainingSats, total]);

  const submit = async () => {
    setStatus("submitting");
    setStatusMessage("Creating transfer offer…");
    try {
      const res = await fetch("/api/transfers/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient: recipient.trim(),
          amountBtc: amount.trim(),
        }),
      });
      const data = (await res.json()) as {
        updateId?: string;
        offerContractId?: string;
        error?: string;
      };

      if (!res.ok) {
        throw new Error(data.error ?? `Transfer failed (${res.status})`);
      }

      setStatus("success");
      setStatusMessage(
        `Offer sent — recipient must accept. Update id: ${data.updateId?.slice(0, 24)}…`,
      );
      // Source holdings are locked until accept/expire — reflect that in the UI.
      refetchBalance();
    } catch (err) {
      setStatus("error");
      setStatusMessage(err instanceof Error ? err.message : String(err));
    }
  };

  const reset = () => {
    setRecipient("");
    setAmount("");
    setStatus("idle");
    setStatusMessage("");
  };

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <h1 className="text-2xl font-semibold">Send CBTC</h1>

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

      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="recipient">Recipient party ID</Label>
          <Input
            id="recipient"
            placeholder="alice::1220…"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            className="font-mono text-sm"
            disabled={status === "submitting"}
          />
          {recipient.length > 0 && !recipientValid && (
            <p className="text-xs text-destructive">
              Party IDs include a `::` separator.
            </p>
          )}
        </div>

        <div className="space-y-2">
          <div className="flex items-baseline justify-between">
            <Label htmlFor="amount">Amount (BTC)</Label>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => setAmount(total)}
              disabled={status === "submitting"}
            >
              Max
            </Button>
          </div>
          <Input
            id="amount"
            inputMode="decimal"
            placeholder="0.00000000"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="font-mono"
            disabled={status === "submitting"}
          />
          <div
            className={
              overdraft
                ? "text-xs text-destructive"
                : "text-xs text-muted-foreground"
            }
          >
            Remaining after send: {remainingDisplay} CBTC
          </div>
        </div>
      </div>

      <TransactionStatus status={status} message={statusMessage} />

      <div className="flex items-center gap-2">
        {status === "success" || status === "error" ? (
          <Button onClick={reset} className="w-full">
            Send another
          </Button>
        ) : (
          <Button
            onClick={() => submit().catch(console.error)}
            disabled={!canSubmit}
            className="w-full"
          >
            {status === "submitting" ? "Submitting…" : "Confirm and send"}
          </Button>
        )}
      </div>
    </div>
  );
}

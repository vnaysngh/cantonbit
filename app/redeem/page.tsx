"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BalanceBadge } from "@/components/BalanceBadge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useBalance } from "@/hooks/useBalance";
import { useWallet } from "@/hooks/useWallet";
import { NETWORK } from "@/lib/constants";
import { formatBtc, parseBtc, toCanonicalAmount } from "@/lib/format";
import { MIN_MINT_SATS } from "@/lib/mint";
import {
  checkBitcoinTx,
  createWithdrawAccount,
  findExistingWithdrawAccount,
  getRedeemStatus,
  listSpendableHoldings,
  selectHoldings,
  submitWithdraw,
  type HoldingSummary,
} from "@/lib/redeem";

/**
 * Block-explorer URL for a Bitcoin address, matching the current network.
 * Returns null for devnet (regtest has no public explorer).
 */
function btcExplorerAddressUrl(address: string): string | null {
  const addr = encodeURIComponent(address.trim());
  switch (NETWORK.name) {
    case "mainnet":
      return `https://mempool.space/address/${addr}`;
    case "testnet":
      return `https://mempool.space/testnet/address/${addr}`;
    default:
      return null; // devnet / regtest — no public explorer
  }
}

/**
 * Block-explorer URL for a specific Bitcoin transaction, matching the network.
 * Returns null for devnet (regtest has no public explorer).
 */
function btcExplorerTxUrl(txId: string): string | null {
  const id = encodeURIComponent(txId.trim());
  switch (NETWORK.name) {
    case "mainnet":
      return `https://mempool.space/tx/${id}`;
    case "testnet":
      return `https://mempool.space/testnet/tx/${id}`;
    default:
      return null; // devnet / regtest — no public explorer
  }
}

/**
 * Live progress of a submitted redeem, tracked on the success screen.
 *   burned        — cBTC destroyed on Canton; attestor hasn't acted yet.
 *   broadcasting  — attestor created the withdraw request + assigned a btcTxId.
 *   sent          — that btcTxId is now visible on the Bitcoin chain.
 *   stalled       — a btcTxId was assigned but never appeared on-chain (attestor
 *                   issue) — surfaced so the user isn't left guessing.
 */
type RedeemProgress = "burned" | "broadcasting" | "sent" | "stalled";

/** How long a btcTxId can be assigned-but-not-on-chain before we flag it stalled. */
const STALL_AFTER_MS = 20 * 60 * 1000; // 20 minutes

type Stage =
  | { kind: "form" }
  | { kind: "preparing" }
  | { kind: "creating-account" }
  | { kind: "burning"; holdingsUsed: HoldingSummary[] }
  | {
      kind: "success";
      progress: RedeemProgress;
      btcTxId: string | null;
      burnedAmount: string;
    }
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
  // TODO(redeem-min): minimum redeem is temporarily DISABLED for testing small
  // burns. To re-enable the 0.001 BTC BitSafe minimum, set REDEEM_MIN_SATS back
  // to MIN_MINT_SATS.
  const REDEEM_MIN_SATS = 0n; // was: MIN_MINT_SATS
  void MIN_MINT_SATS; // keep import live for easy re-enable
  const belowMin = amountSats > 0n && amountSats < REDEEM_MIN_SATS;
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
      let withdrawAccountTemplateId: string;
      let withdrawAccountBlob: string;

      if (existing) {
        withdrawAccountCid = existing.contractId;
        withdrawAccountTemplateId = existing.templateId ?? "";
        withdrawAccountBlob = existing.createdEventBlob ?? "";
      } else {
        setStage({ kind: "creating-account" });
        const created = await createWithdrawAccount(partyId, btcAddress.trim());
        withdrawAccountCid = created.contractId;
        withdrawAccountTemplateId = created.templateId;
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
      // Normalize the amount to the canonical 10-dp form the ledger expects
      // (e.g. "0.000001" → "0.0000010000"), matching the reference burn script
      // exactly. Exact BigInt math, no float.
      const canonicalAmount = toCanonicalAmount(amount);
      setStage({ kind: "burning", holdingsUsed: holdings.filter((h) => holdingCids.includes(h.contractId)) });
      await submitWithdraw(
        partyId,
        btcAddress.trim(),
        withdrawAccountCid,
        withdrawAccountTemplateId,
        withdrawAccountBlob,
        holdingCids,
        canonicalAmount,
      );

      refetchBalance();
      setStage({
        kind: "success",
        progress: "burned",
        btcTxId: null,
        burnedAmount: canonicalAmount,
      });
    } catch (err) {
      setStage({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [partyId, btcAddress, amount, refetchBalance]);

  // Live redeem tracking. Once the burn succeeds, poll the on-ledger
  // CBTCWithdrawRequest (attestor-created) and, once a btcTxId is assigned,
  // poll the Bitcoin chain — so the user sees real progress instead of a
  // vague "pending", and a stall is surfaced rather than hidden.
  const sawRequestAt = useRef<number | null>(null);
  useEffect(() => {
    if (stage.kind !== "success") return;
    if (stage.progress === "sent") return; // terminal — stop polling
    if (!partyId) return;

    let cancelled = false;

    const tick = async () => {
      try {
        const dest = btcAddress.trim();
        const status = await getRedeemStatus(partyId, dest);

        // Attestor has assigned a btcTxId → check whether it's on-chain yet.
        if (status.btcTxId) {
          if (sawRequestAt.current === null) sawRequestAt.current = Date.now();
          const chain = await checkBitcoinTx(status.btcTxId);
          if (cancelled) return;

          if (chain.found) {
            setStage({
              kind: "success",
              progress: "sent",
              btcTxId: status.btcTxId,
              burnedAmount: status.amount ?? stage.burnedAmount,
            });
            return;
          }

          // txid assigned but not on-chain — broadcasting, or stalled if it's
          // been too long without appearing anywhere (not even the mempool).
          const elapsed = Date.now() - (sawRequestAt.current ?? Date.now());
          setStage({
            kind: "success",
            progress: elapsed > STALL_AFTER_MS ? "stalled" : "broadcasting",
            btcTxId: status.btcTxId,
            burnedAmount: status.amount ?? stage.burnedAmount,
          });
          return;
        }

        // No request yet — still in the attestor's queue right after the burn.
        if (cancelled) return;
        setStage((prev) =>
          prev.kind === "success" && prev.progress === "burned"
            ? prev
            : prev.kind === "success"
              ? { ...prev, progress: "burned", btcTxId: null }
              : prev,
        );
      } catch {
        // transient — wait for the next tick
      }
    };

    void tick();
    const id = setInterval(tick, 20_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [stage, partyId, btcAddress]);

  const reset = () => {
    setAmount("");
    setBtcAddress("");
    sawRequestAt.current = null;
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
            <CardTitle
              className={stage.progress === "sent" ? "text-green-600" : ""}
            >
              {stage.progress === "sent"
                ? "Bitcoin sent"
                : stage.progress === "stalled"
                  ? "Taking longer than expected"
                  : "Redemption in progress"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Live step tracker. Reflects the real on-ledger + on-chain state,
                polled every 20s — no more guessing whether BTC is on its way. */}
            <ol className="space-y-3">
              <RedeemStep
                done
                title={`Burned ${formatBtc(stage.burnedAmount)} cBTC`}
                detail="Your cBTC was destroyed on Canton."
              />
              <RedeemStep
                done={
                  stage.progress === "broadcasting" ||
                  stage.progress === "sent" ||
                  stage.progress === "stalled"
                }
                active={stage.progress === "burned"}
                title="Attestor preparing transaction"
                detail={
                  stage.progress === "burned"
                    ? "Waiting for the bridge to pick up your redemption…"
                    : "The bridge assigned a Bitcoin transaction."
                }
              />
              <RedeemStep
                done={stage.progress === "sent"}
                active={stage.progress === "broadcasting"}
                error={stage.progress === "stalled"}
                title="Bitcoin broadcast"
                detail={
                  stage.progress === "sent"
                    ? "Confirmed on the Bitcoin network."
                    : stage.progress === "stalled"
                      ? "The transaction hasn't appeared on-chain yet."
                      : "Broadcasting to the Bitcoin network…"
                }
              />
            </ol>

            {/* The Bitcoin txid, once the attestor has assigned one. */}
            {stage.btcTxId && (
              <div className="space-y-1 rounded-lg border bg-muted/40 px-3 py-2">
                <p className="text-xs font-medium text-muted-foreground">
                  Bitcoin transaction
                </p>
                <p className="break-all font-mono text-xs">{stage.btcTxId}</p>
                {(() => {
                  const txUrl = btcExplorerTxUrl(stage.btcTxId);
                  return txUrl ? (
                    <a
                      href={txUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-block text-sm underline"
                    >
                      View transaction on mempool.space ↗
                    </a>
                  ) : null;
                })()}
              </div>
            )}

            {/* Destination address — always useful to watch. */}
            {(() => {
              const url = btcExplorerAddressUrl(btcAddress);
              return url ? (
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-block text-sm underline"
                >
                  Track the destination address on a block explorer ↗
                </a>
              ) : null;
            })()}

            {/* Stalled: be honest and point to support. */}
            {stage.progress === "stalled" && (
              <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-300">
                The bridge assigned a Bitcoin transaction but it hasn&apos;t been
                broadcast yet. Your cBTC is burned and the redemption is recorded
                on Canton — this is a delay on the bridge&apos;s side. If it
                doesn&apos;t clear soon, contact{" "}
                <a href="mailto:support@bitsafe.finance" className="underline">
                  support@bitsafe.finance
                </a>{" "}
                with the transaction ID above.
              </p>
            )}

            {stage.progress !== "sent" && stage.progress !== "stalled" && (
              <p className="text-xs text-muted-foreground">
                This page updates automatically. You can safely leave — the
                redemption continues on its own.
              </p>
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

/** One row in the redeem progress tracker. */
function RedeemStep({
  done = false,
  active = false,
  error = false,
  title,
  detail,
}: {
  done?: boolean;
  active?: boolean;
  error?: boolean;
  title: string;
  detail: string;
}) {
  const mark = error ? "!" : done ? "✓" : active ? "…" : "";
  const markClass = error
    ? "border-amber-400 bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
    : done
      ? "border-green-500 bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400"
      : active
        ? "border-foreground/40 bg-muted text-foreground"
        : "border-muted-foreground/30 text-muted-foreground/50";

  return (
    <li className="flex items-start gap-3">
      <span
        aria-hidden
        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-xs font-semibold ${markClass}`}
      >
        {mark}
      </span>
      <span className="space-y-0.5">
        <span
          className={`block text-sm font-medium ${
            done || active || error ? "" : "text-muted-foreground/60"
          }`}
        >
          {title}
        </span>
        <span className="block text-xs text-muted-foreground">{detail}</span>
      </span>
    </li>
  );
}

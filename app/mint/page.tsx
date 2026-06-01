"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";

import { BalanceBadge } from "@/components/BalanceBadge";
import { Button } from "@/components/ui/button";
import { useBalance } from "@/hooks/useBalance";
import { useWallet } from "@/hooks/useWallet";
import { formatSatoshis } from "@/lib/format";
import {
  createDepositAccount,
  getDepositAddress,
  snapshotHoldingBalance
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
  // Presentational only — copy-to-clipboard feedback for the deposit address.
  const [copied, setCopied] = useState(false);
  const copyAddress = useCallback(() => {
    if (stage.kind !== "ready") return;
    void navigator.clipboard.writeText(stage.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [stage]);
  const baselineRef = useRef<string | null>(null);
  // The most recently recovered/created deposit account — reused across "Mint more" cycles
  // so we never create a new Canton contract unless there are literally zero existing ones.
  const existingAccountRef = useRef<{
    depositAccountCid: string;
    address: string;
  } | null>(null);

  // On mount: find the most recent CBTCDepositAccount for this party and recover its
  // bitcoin address. Prevents creating a new contract on every page refresh.
  useEffect(() => {
    if (!partyId) return; // wait until wallet is connected and partyId is available
    (async () => {
      try {
        const res = await fetch("/api/mint/list-deposit-accounts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ partyId })
        });
        const data = (await res.json()) as {
          accounts?: Array<{ contractId: string; bitcoinAddress?: string }>;
        };
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
            body: JSON.stringify({
              depositAccountContractId: existing.contractId
            })
          });
          const addrData = (await addrRes.json()) as { address?: string };
          address = addrData.address ?? "";
        }

        if (!address) {
          setStage({ kind: "idle" });
          return;
        }

        existingAccountRef.current = {
          depositAccountCid: existing.contractId,
          address
        };
        // Baseline = the USER's current balance. We poll the user party and flip
        // to "minted" when CBTC lands there (delivered by the server-side cron).
        const baseline = await snapshotHoldingBalance(partyId);
        baselineRef.current = baseline;
        setStage({
          kind: "ready",
          depositAccountCid: existing.contractId,
          address
        });
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
        message: err instanceof Error ? err.message : String(err)
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
    <div className="flex flex-col items-center py-lg">
      {/* Minting widget — fixed 480px central column per the design system. */}
      <div className="w-full max-w-bridge-widget-width space-y-md">
        {/* Page header */}
        <div className="mb-lg space-y-2 text-center">
          <h1 className="text-display-lg text-on-background">Mint CBTC</h1>
          {/*   <p className="mx-auto max-w-[400px] text-body-lg text-on-surface-variant">
            Send Bitcoin to the address below to mint cross-chain CBTC on the
            network.
          </p> */}
        </div>

        {stage.kind === "recovering" && (
          <div className="rounded-2xl border border-outline/10 bg-surface-container-lowest p-8 text-center text-body-md text-on-surface-variant shadow-sm">
            Checking for existing deposit account…
          </div>
        )}

        {stage.kind === "idle" && (
          <div className="space-y-md rounded-2xl border border-outline/10 bg-surface-container-lowest p-8 shadow-sm">
            <p className="text-body-md text-on-surface-variant">
              Generate a Bitcoin deposit address. Send at least{" "}
              <span className="font-semibold text-on-surface">0.001 BTC</span>{" "}
              (minimum). After 6 Bitcoin confirmations (~60 min) and attestor
              verification (~60–120 sec), CBTC will appear in your balance.
            </p>
            <Button
              onClick={() => start().catch(console.error)}
              className="flex h-auto w-full items-center justify-center gap-2 rounded-lg bg-primary-container py-3.5 text-body-lg font-bold text-on-primary shadow-sm transition-all hover:brightness-105 active:scale-[0.98]"
            >
              Generate deposit address
              <span className="material-symbols-outlined text-[20px]">
                arrow_forward
              </span>
            </Button>
          </div>
        )}

        {(stage.kind === "creating-account" ||
          stage.kind === "fetching-address") && (
          <div className="rounded-2xl border border-outline/10 bg-surface-container-lowest p-8 text-center text-body-md text-on-surface-variant shadow-sm">
            {stage.kind === "creating-account" &&
              "Creating your deposit account on Canton…"}
            {stage.kind === "fetching-address" &&
              "Fetching your Bitcoin deposit address…"}
          </div>
        )}

        {stage.kind === "ready" && (
          <>
            {/* Bridge card: QR + deposit address + live monitoring status. */}
            <div className="space-y-md rounded-2xl border border-outline/10 bg-surface-container-lowest p-8 shadow-sm">
              {/* QR */}
              <div className="flex flex-col items-center justify-center py-4">
                <div className="rounded-xl bg-white p-4 shadow-sm">
                  <QRCodeSVG value={stage.address} size={192} level="M" />
                </div>
              </div>

              {/* Deposit address + copy */}
              <div className="space-y-sm">
                <label className="block px-1 text-center text-label-sm uppercase tracking-widest text-on-surface-variant">
                  Bitcoin Deposit Address
                </label>
                <div className="flex items-center gap-3 rounded-xl border border-outline/5 bg-surface-container p-4 transition-all focus-within:border-primary">
                  <span className="flex-1 overflow-hidden text-ellipsis break-all font-mono text-label-sm text-on-surface">
                    {stage.address}
                  </span>
                  <button
                    onClick={copyAddress}
                    title="Copy to clipboard"
                    className="flex items-center justify-center rounded-lg p-2 text-primary transition-all hover:bg-primary-container/20 active:scale-90"
                  >
                    <span className="material-symbols-outlined text-[20px]">
                      {copied ? "check" : "content_copy"}
                    </span>
                  </button>
                </div>
              </div>

              {/* Est. time — folded into the card as a footer row instead of a
                  separate floating box. Label left, value right. */}
              <div className="flex items-center justify-between border-t border-outline/10 pt-4">
                <span className="flex items-center gap-1.5 text-label-sm uppercase tracking-wide text-on-surface-variant">
                  <span className="material-symbols-outlined text-[18px]">
                    schedule
                  </span>
                  Est. Time
                </span>
                <span className="text-body-md font-bold text-on-surface">
                  ~60 min
                </span>
              </div>
            </div>

            {/* Important Information */}
            <div className="flex items-start gap-4 rounded-xl border border-primary-container/20 bg-primary-container/10 p-5">
              <span className="material-symbols-outlined mt-1 text-primary">
                info
              </span>
              <div className="space-y-1">
                <h4 className="font-mono text-label-sm font-bold text-on-primary-container">
                  Important Information
                </h4>
                <p className="text-[13px] leading-relaxed text-on-primary-container/80">
                  Minimum deposit is{" "}
                  <span className="font-bold">0.001 BTC</span>. Deposits below
                  this amount will not be processed and cannot be recovered.
                  Requires 6 network confirmations to begin minting.
                </p>
              </div>
            </div>
          </>
        )}

        {stage.kind === "minted" && (
          <div className="space-y-md rounded-2xl border border-outline/10 bg-surface-container-lowest p-8 text-center shadow-sm">
            <div className="flex flex-col items-center gap-2">
              <span className="material-symbols-outlined text-[40px] text-tertiary">
                check_circle
              </span>
              <h2 className="text-headline-lg text-on-background">
                CBTC received
              </h2>
            </div>
            <p className="text-body-md text-on-surface-variant">
              <span className="font-semibold text-on-surface">
                {stage.amount} CBTC
              </span>{" "}
              has been minted to your party.
            </p>
            <div className="flex justify-center">
              <BalanceBadge amount={total} size="lg" />
            </div>
            <Button
              onClick={reset}
              className="w-full rounded-lg bg-primary text-on-primary hover:opacity-90"
            >
              Mint more CBTC
            </Button>
          </div>
        )}

        {stage.kind === "error" && (
          <div className="space-y-md rounded-2xl border border-error/20 bg-surface-container-lowest p-8 shadow-sm">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-error">
                error
              </span>
              <h2 className="text-headline-md text-error">Mint failed</h2>
            </div>
            <pre className="overflow-x-auto rounded-lg bg-surface-container p-3 font-mono text-label-sm text-on-surface-variant">
              {stage.message}
            </pre>
            <Button
              onClick={reset}
              className="w-full rounded-lg bg-primary text-on-primary hover:opacity-90"
            >
              Try again
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

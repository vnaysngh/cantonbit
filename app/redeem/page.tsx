"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { useBalance } from "@/hooks/useBalance";
import { useWallet } from "@/hooks/useWallet";
import { btcAddressKindLabel, validateBtcAddress } from "@/lib/btc-address";
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
  type HoldingSummary
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
 *   burned        — CBTC destroyed on Canton; attestor hasn't acted yet.
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
      // Canton updateId of the burn — stable id for this redeem, available
      // synchronously from the burn response. Lets us link to /activity/<id>.
      burnUpdateId: string | null;
    }
  | { kind: "error"; message: string };

export default function RedeemPage() {
  const { partyId } = useWallet();
  const { total, refetch: refetchBalance } = useBalance();

  const [amount, setAmount] = useState("");
  const [btcAddress, setBtcAddress] = useState("");
  const [stage, setStage] = useState<Stage>({ kind: "form" });
  // Set true when the user clicks "Review redemption" — gates the final,
  // irreversible burn behind an explicit confirmation screen.
  const [confirming, setConfirming] = useState(false);

  // The burn is in flight across these stages. While processing, the confirm
  // modal stays open and shows an in-place "Processing…" state (no page swap).
  const isProcessing =
    stage.kind === "preparing" ||
    stage.kind === "creating-account" ||
    stage.kind === "burning";
  // A human label for the current processing step, shown in the modal button.
  const processingLabel =
    stage.kind === "preparing"
      ? "Preparing…"
      : stage.kind === "creating-account"
        ? "Creating account…"
        : stage.kind === "burning"
          ? "Burning…"
          : "Processing…";

  // ── Amount validation (exact satoshi math, no float) ──
  const balanceSats = parseBtc(total);
  const amountSats = parseBtc(amount || "0");
  const overdraft = amountSats > balanceSats;
  // TODO(redeem-min): minimum redeem is temporarily DISABLED for testing small
  // burns. To re-enable the 0.001 BTC BitSafe minimum, set REDEEM_MIN_SATS back
  // to MIN_MINT_SATS.
  const REDEEM_MIN_SATS = 0n; // was: MIN_MINT_SATS
  void MIN_MINT_SATS; // keep import live for easy re-enable
  const belowMin = amountSats > 0n && amountSats < REDEEM_MIN_SATS;
  // Reject malformed numeric input: anything that isn't a plain positive decimal
  // with at most 8 fractional digits (BTC's smallest unit is 1 satoshi = 1e-8).
  const amountWellFormed = /^\d*\.?\d{0,8}$/.test(amount) && amount !== ".";
  const amountValid =
    amount !== "" &&
    amountWellFormed &&
    amountSats > 0n &&
    !overdraft &&
    !belowMin;

  // ── Address validation (network-aware, checksum-verified) ──
  const addressValidation = useMemo(
    () => validateBtcAddress(btcAddress),
    [btcAddress]
  );
  const addressValid = addressValidation.valid;

  const canReview =
    amountValid && addressValid && stage.kind === "form" && !confirming;

  const remainingDisplay = useMemo(() => {
    if (amount === "") return total;
    if (overdraft) return "0";
    return formatBtc(balanceSats - amountSats);
  }, [amount, amountSats, balanceSats, overdraft, total]);

  const submit = useCallback(async () => {
    if (!partyId) return;

    // Defense-in-depth: re-validate at the moment of burn. The button is already
    // gated, but this guards against any state slipping through (e.g. a stale
    // render) before we destroy the user's CBTC irreversibly.
    const finalCheck = validateBtcAddress(btcAddress);
    if (!finalCheck.valid) {
      setStage({
        kind: "error",
        message:
          finalCheck.reason ??
          "The destination Bitcoin address is invalid. Burn aborted."
      });
      return;
    }
    if (amountSats <= 0n || amountSats > balanceSats || !amountWellFormed) {
      setStage({
        kind: "error",
        message: "The amount is invalid. Burn aborted."
      });
      return;
    }

    try {
      // Keep the modal OPEN through preparing/creating-account/burning so the
      // user gets in-place "Processing…" feedback instead of a jarring full-page
      // swap. The modal is dismissed only once we reach the success tracker
      // (handled in the success branch below).
      setStage({ kind: "preparing" });

      // Step 1: find or create a WithdrawAccount for this BTC destination.
      // Queries LEDGER_HOST directly (m2m JWT) — no Loop SDK needed.
      // Reuse existing account if one already exists for this destination address.
      const existing = await findExistingWithdrawAccount(
        partyId,
        btcAddress.trim()
      );

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
            : "Not enough spendable holdings to cover this amount."
        );
      }

      // Step 3: burn — submits to LEDGER_HOST directly (m2m JWT).
      // Normalize the amount to the canonical 10-dp form the ledger expects
      // (e.g. "0.000001" → "0.0000010000"), matching the reference burn script
      // exactly. Exact BigInt math, no float.
      const canonicalAmount = toCanonicalAmount(amount);
      setStage({
        kind: "burning",
        holdingsUsed: holdings.filter((h) => holdingCids.includes(h.contractId))
      });
      const { burnUpdateId } = await submitWithdraw(
        partyId,
        btcAddress.trim(),
        withdrawAccountCid,
        withdrawAccountTemplateId,
        withdrawAccountBlob,
        holdingCids,
        canonicalAmount
      );

      refetchBalance();
      // Burn done — dismiss the modal and hand off to the progress tracker.
      setConfirming(false);
      setStage({
        kind: "success",
        progress: "burned",
        btcTxId: null,
        burnedAmount: canonicalAmount,
        burnUpdateId
      });
    } catch (err) {
      // Surface the error in the progress column (modal closes) so the user
      // sees the full message + a "Try again" path rather than a stuck modal.
      setConfirming(false);
      setStage({
        kind: "error",
        message: err instanceof Error ? err.message : String(err)
      });
    }
  }, [
    partyId,
    btcAddress,
    amount,
    amountSats,
    amountWellFormed,
    balanceSats,
    refetchBalance
  ]);

  // Live redeem tracking — two separate polling loops with different cadences:
  //
  //   Loop 1 (Canton, every 20s): poll CBTCWithdrawRequest until the attestor
  //   assigns a btcTxId. Once assigned we stop this loop.
  //
  //   Loop 2 (Bitcoin, every 90s): only starts AFTER a btcTxId is known and
  //   only on networks with a public explorer (mainnet/testnet). Polls mempool
  //   until the tx appears on-chain. Polling mempool before the txid exists
  //   would always 404, so we gate it strictly.
  //
  // This prevents the previous behaviour of hitting mempool every 20s with
  // guaranteed 404s while the attestor hasn't even broadcast yet.
  const sawRequestAt = useRef<number | null>(null);
  const lastCheckedTxId = useRef<string | null>(null);

  // Loop 1: Canton poll — wait for attestor to create the WithdrawRequest.
  useEffect(() => {
    if (stage.kind !== "success") return;
    // Stop once we have a txid (Loop 2 takes over) or terminal state.
    if (stage.progress === "sent" || stage.progress === "stalled") return;
    if (stage.btcTxId) return; // txid known — Loop 2 handles it
    if (!partyId) return;

    let cancelled = false;

    const tick = async () => {
      try {
        const status = await getRedeemStatus(partyId, btcAddress.trim());
        if (cancelled) return;

        // Confirmed on Bitcoin — mempool found an incoming tx to the address.
        if (status.state === "completed") {
          setStage((prev) =>
            prev.kind === "success"
              ? {
                  ...prev,
                  progress: "sent",
                  btcTxId: status.btcTxId ?? prev.btcTxId
                }
              : prev
          );
          return;
        }

        if (status.btcTxId) {
          // Attestor just assigned a txid — update state; Loop 2 will pick up.
          if (sawRequestAt.current === null) sawRequestAt.current = Date.now();
          setStage((prev) =>
            prev.kind === "success"
              ? {
                  ...prev,
                  progress: "broadcasting",
                  btcTxId: status.btcTxId
                  // NOTE: do NOT overwrite burnedAmount from the poll.
                  // burnedAmount is the exact amount THIS burn destroyed, known
                  // at burn time. findWithdrawRequest() matches by party+address,
                  // so with repeat redeems to the same address it can return a
                  // DIFFERENT/stale request's amount — which previously clobbered
                  // the correct value (e.g. showing 0.000021 for a 0.000001 burn).
                }
              : prev
          );
        }
        // No txid yet — stay in "burned" state, nothing to update.
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
  }, [
    stage.kind,
    stage.kind === "success" ? stage.progress : null,
    stage.kind === "success" ? stage.btcTxId : null,
    partyId,
    btcAddress
  ]);

  // Loop 2: Bitcoin poll — only runs once we have a btcTxId, checks every 90s.
  // 90s because Bitcoin blocks are ~10 min; checking faster just burns requests.
  useEffect(() => {
    if (stage.kind !== "success") return;
    if (!stage.btcTxId) return; // no txid yet — Loop 1 is still waiting
    if (stage.progress === "sent") return; // terminal
    if (!partyId) return;

    const txId = stage.btcTxId;

    // Skip if we already checked this exact txid on this render cycle.
    // (Avoids a double-hit when Loop 1 sets the txid and Loop 2 mounts.)
    let cancelled = false;

    const tick = async () => {
      // Don't re-check the same txid more than once per interval.
      if (lastCheckedTxId.current === txId && cancelled) return;
      lastCheckedTxId.current = txId;

      try {
        const chain = await checkBitcoinTx(txId);
        if (cancelled) return;

        if (chain.found) {
          setStage((prev) =>
            prev.kind === "success" ? { ...prev, progress: "sent" } : prev
          );
          return;
        }

        // Still not on-chain — check stall threshold.
        const elapsed = Date.now() - (sawRequestAt.current ?? Date.now());
        if (elapsed > STALL_AFTER_MS) {
          setStage((prev) =>
            prev.kind === "success" && prev.progress !== "sent"
              ? { ...prev, progress: "stalled" }
              : prev
          );
        }
      } catch {
        // transient — wait for the next tick
      }
    };

    void tick();
    const id = setInterval(tick, 90_000); // 90s — no point hitting mempool faster
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [
    stage.kind,
    stage.kind === "success" ? stage.btcTxId : null,
    stage.kind === "success" ? stage.progress : null,
    partyId
  ]);

  const reset = () => {
    setAmount("");
    setBtcAddress("");
    setConfirming(false);
    sawRequestAt.current = null;
    setStage({ kind: "form" });
  };

  return (
    <div className="py-12">
      {/* Keep the form rendered while the confirm modal is processing, so the
          burn shows as an overlay on the form rather than a blank backdrop. */}
      {(stage.kind === "form" || isProcessing) && (
        <div className="mx-auto grid w-full max-w-[1100px] grid-cols-1 items-start gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          {/* ── Left: How it works ──
              min-w-0 MUST live on the grid child itself, otherwise the column
              defaults to min-width:auto and collapses to min-content, forcing
              the intro paragraph to wrap one word per line. */}
          <div className="min-w-0">
            <HowRedeemWorks />
          </div>

          {/* ── Right: Redemption Details ── */}
          <div className="flex flex-col gap-8 rounded-2xl border border-outline-variant bg-surface-container-lowest p-8 shadow-sm">
            <div className="flex items-start justify-between">
              <div className="space-y-1">
                <h2 className="text-headline-lg font-bold text-on-background">
                  Redemption Details
                </h2>
                <p className="text-body-md text-on-surface-variant">
                  Configure your withdrawal
                </p>
              </div>
            </div>

            {/* Available balance + MAX */}
            <div className="flex items-center justify-between rounded-xl border border-outline-variant bg-surface-container-low p-4">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-primary-fixed text-primary-container">
                  <span
                    className="material-symbols-outlined text-[20px]"
                    style={{ fontVariationSettings: "'FILL' 1" }}
                  >
                    currency_bitcoin
                  </span>
                </span>
                <div className="flex flex-col">
                  <span className="text-label-sm font-bold uppercase tracking-wider text-on-surface-variant">
                    Available Balance
                  </span>
                  <span className="font-mono text-body-lg font-bold text-on-surface">
                    {formatBtc(total)} CBTC
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setAmount(total)}
                className="rounded-lg px-3 py-1 text-label-sm font-bold text-primary-container transition-colors hover:bg-primary-fixed"
              >
                MAX
              </button>
            </div>

            {/* Form fields — Amount then Address. Desktop v5: compact inputs,
                white fill, rounded-lg, equal height; small labels; gap-5. */}
            <div className="flex flex-col gap-5">
              {/* Amount to burn */}
              <div className="flex flex-col gap-2">
                <label
                  htmlFor="amount"
                  className="px-1 text-label-sm font-medium text-on-surface"
                >
                  Amount to burn
                </label>
                <div className="relative">
                  <input
                    id="amount"
                    type="text"
                    inputMode="decimal"
                    placeholder="0.00"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    aria-invalid={amount !== "" && !amountValid}
                    className="w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-4 py-3 pr-16 font-mono text-body-md text-on-surface outline-none transition-all placeholder:text-on-surface-variant/60 focus:border-primary-container"
                  />
                  <span className="absolute right-4 top-1/2 -translate-y-1/2 font-mono text-label-sm font-medium text-on-surface-variant">
                    CBTC
                  </span>
                </div>
                {amount !== "" && !amountWellFormed && (
                  <p className="px-1 text-label-sm text-error">
                    Enter a valid amount (up to 8 decimal places).
                  </p>
                )}
                {amountWellFormed && belowMin && (
                  <p className="px-1 text-label-sm text-error">
                    Minimum redeem amount is 0.001 BTC.
                  </p>
                )}
                {amountWellFormed && overdraft && (
                  <p className="px-1 text-label-sm text-error">
                    Amount exceeds your balance.
                  </p>
                )}
                {amountValid && (
                  <p className="px-1 text-label-sm text-on-surface-variant">
                    Remaining after burn: {remainingDisplay} CBTC
                  </p>
                )}
              </div>

              {/* Bitcoin destination address */}
              <div className="flex flex-col gap-2">
                <label
                  htmlFor="btc-address"
                  className="px-1 text-label-sm font-medium text-on-surface"
                >
                  Bitcoin destination address
                </label>
                <div className="relative">
                  <input
                    id="btc-address"
                    type="text"
                    placeholder="Enter BTC Address (bc1...)"
                    value={btcAddress}
                    onChange={(e) => setBtcAddress(e.target.value)}
                    spellCheck={false}
                    autoCapitalize="none"
                    autoCorrect="off"
                    aria-invalid={btcAddress !== "" && !addressValid}
                    className="w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-4 py-3 font-mono text-body-md text-on-surface outline-none transition-all placeholder:text-on-surface-variant/60 focus:border-primary-container"
                  />
                </div>
                {btcAddress.trim() !== "" &&
                  !addressValid &&
                  addressValidation.reason && (
                    <p className="px-1 text-label-sm text-error">
                      {addressValidation.reason}
                    </p>
                  )}
                {addressValid && addressValidation.kind && (
                  <p className="px-1 text-label-sm text-tertiary">
                    ✓ Valid {NETWORK.name} address ·{" "}
                    {btcAddressKindLabel(addressValidation.kind)}
                  </p>
                )}
                {btcAddress.trim() === "" && (
                  <p className="px-1 text-label-sm text-on-surface-variant">
                    Must be a {NETWORK.name} Bitcoin address. The checksum is
                    verified here — a wrong-network or mistyped address is
                    rejected before any CBTC is burned.
                  </p>
                )}
              </div>
            </div>

            {/* Summary breakdown */}
            <div className="space-y-4 pt-4">
              <div className="flex items-center justify-between text-body-md">
                <span className="text-on-surface-variant">Protocol Fee</span>
                <span className="font-mono font-bold text-on-surface">
                  0.0000 BTC
                </span>
              </div>
              <div className="flex items-center justify-between text-body-md">
                <span className="text-on-surface-variant">
                  Estimated Arrival
                </span>
                <span className="font-mono font-bold text-on-surface">
                  ~30–60 Minutes
                </span>
              </div>
              <div className="my-2 h-px w-full bg-outline-variant" />
              <div className="flex items-center justify-between">
                <span className="text-body-md font-bold text-on-background">
                  Net Receive
                </span>
                <span className="font-mono text-headline-lg font-bold text-primary-container">
                  {amountValid ? formatBtc(amount) : "0.00"} BTC
                </span>
              </div>
            </div>

            {/* CTA */}
            {/* Wireframe CTA: w-full bg-primary text-on-primary py-md rounded-xl,
                solid orange at all times (never greys out). Our `primary` token
                is dark rust, so primary-container reproduces the wireframe's
                light-orange `primary`. Disabled only dims + blocks the click. */}
            <Button
              onClick={() => setConfirming(true)}
              disabled={!canReview}
              className="flex h-auto w-full items-center justify-center gap-2 rounded-lg bg-primary-container py-3.5 text-body-lg font-bold text-on-primary shadow-sm transition-all hover:brightness-105 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
            >
              Review Redemption
              <span className="material-symbols-outlined text-[20px]">
                arrow_forward
              </span>
            </Button>
          </div>
        </div>
      )}

      {/* Confirm dialog — modal overlay on top of the still-visible form.
          Stays open while the burn processes (isProcessing) so the user gets
          in-place feedback instead of a full-page swap. */}
      {((stage.kind === "form" && confirming) || isProcessing) && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-redeem-title"
        >
          {/* Backdrop — click to dismiss (disabled while processing). */}
          <div
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={() => {
              if (!isProcessing) setConfirming(false);
            }}
          />
          {/* Dialog panel */}
          <div className="relative z-10 w-full max-w-[26rem] overflow-hidden rounded-2xl border border-outline-variant bg-surface-container-lowest shadow-2xl">
            {/* Header */}
            <div className="flex items-start justify-between gap-4 px-7 pt-6 pb-5">
              <div className="space-y-1">
                <h2
                  id="confirm-redeem-title"
                  className="text-headline-md font-bold leading-tight text-on-background"
                >
                  Confirm redemption
                </h2>
                <p className="text-label-sm text-on-surface-variant">
                  Review the details before burning.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={isProcessing}
                aria-label="Close"
                className="-mr-2 -mt-1 rounded-full p-2 text-on-surface-variant transition-colors hover:bg-surface-container hover:text-on-surface disabled:cursor-not-allowed disabled:opacity-40"
              >
                <span className="material-symbols-outlined text-[20px]">
                  close
                </span>
              </button>
            </div>

            {/* Body */}
            <div className="space-y-5 px-7 pb-6">
              {/* Irreversible warning */}
              <div className="flex items-start gap-2.5 rounded-xl border border-error/20 bg-error-container/40 px-3.5 py-3 text-on-error-container">
                <span className="material-symbols-outlined mt-px shrink-0 text-[18px] text-error">
                  warning
                </span>
                <p className="text-label-sm leading-relaxed">
                  Burning is <span className="font-bold">irreversible</span>.
                  Your CBTC is destroyed immediately and BTC is sent to the
                  address below — funds sent to a wrong address can&apos;t be
                  recovered.
                </p>
              </div>

              {/* Detail rows */}
              <dl className="overflow-hidden rounded-xl border border-outline-variant bg-surface-container-low">
                <div className="flex items-baseline justify-between gap-4 px-4 py-3.5">
                  <dt className="text-label-sm font-medium uppercase tracking-wide text-on-surface-variant">
                    Amount to burn
                  </dt>
                  <dd className="font-mono text-body-lg font-bold text-on-surface">
                    {formatBtc(amount)} CBTC
                  </dd>
                </div>
                <div className="h-px bg-outline-variant" />
                <div className="space-y-1.5 px-4 py-3.5">
                  <dt className="text-label-sm font-medium uppercase tracking-wide text-on-surface-variant">
                    Destination address
                  </dt>
                  <dd className="break-all font-mono text-label-sm leading-relaxed text-on-surface">
                    {btcAddress.trim()}
                  </dd>
                  {addressValidation.kind && (
                    <dd className="text-label-sm text-tertiary">
                      {NETWORK.name} ·{" "}
                      {btcAddressKindLabel(addressValidation.kind)}
                    </dd>
                  )}
                </div>
                <div className="h-px bg-outline-variant" />
                <div className="flex items-baseline justify-between gap-4 px-4 py-3.5">
                  <dt className="text-label-sm font-medium uppercase tracking-wide text-on-surface-variant">
                    Balance after burn
                  </dt>
                  <dd className="font-mono text-body-md text-on-surface">
                    {remainingDisplay} CBTC
                  </dd>
                </div>
              </dl>

              {/* Actions */}
              <div className="flex gap-3 pt-1">
                <Button
                  variant="outline"
                  disabled={isProcessing}
                  className="h-11 flex-1 rounded-lg border-outline-variant text-body-md font-medium text-on-surface hover:bg-surface-container disabled:opacity-50"
                  onClick={() => setConfirming(false)}
                >
                  Back
                </Button>
                <Button
                  disabled={isProcessing}
                  className="h-11 flex-[1.4] gap-2 rounded-lg bg-primary-container text-body-md font-bold text-on-primary shadow-sm transition-all hover:brightness-105 active:scale-[0.98] disabled:cursor-not-allowed disabled:active:scale-100"
                  onClick={() => submit().catch(console.error)}
                >
                  {isProcessing ? (
                    <>
                      <span className="material-symbols-outlined animate-spin text-[18px]">
                        progress_activity
                      </span>
                      {processingLabel}
                    </>
                  ) : (
                    "Confirm & Burn"
                  )}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Success / error states swap the centered widget column. The
          preparing/creating-account/burning steps are NO LONGER shown here —
          they render in-place inside the confirm modal (see isProcessing). */}
      {stage.kind === "success" || stage.kind === "error" ? (
        <div className="mx-auto max-w-bridge-widget-width space-y-md">
          {stage.kind === "success" && (
            <div className="space-y-4 rounded-2xl border border-outline/10 bg-surface-container-lowest p-8 shadow-sm">
              <h2
                className={`text-headline-md ${
                  stage.progress === "sent"
                    ? "text-tertiary"
                    : "text-on-background"
                }`}
              >
                {stage.progress === "sent"
                  ? "Bitcoin sent"
                  : stage.progress === "stalled"
                    ? "Taking longer than expected"
                    : "Redemption in progress"}
              </h2>
              {/* Live step tracker. Reflects the real on-ledger + on-chain state,
                polled every 20s — no more guessing whether BTC is on its way. */}
              <ol className="space-y-3">
                <RedeemStep
                  done
                  title={`Burned ${formatBtc(stage.burnedAmount)} CBTC`}
                  detail="Your CBTC was destroyed on Canton."
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
                <div className="space-y-1 rounded-xl border border-outline/10 bg-surface-container px-4 py-3">
                  <p className="font-mono text-label-sm text-on-surface-variant">
                    Bitcoin transaction
                  </p>
                  <p className="break-all font-mono text-label-sm text-on-surface">
                    {stage.btcTxId}
                  </p>
                  {(() => {
                    const txUrl = btcExplorerTxUrl(stage.btcTxId);
                    return txUrl ? (
                      <a
                        href={txUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-block text-body-md text-primary-container underline"
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
                    className="inline-block text-body-md text-primary-container underline"
                  >
                    Track the destination address on a block explorer ↗
                  </a>
                ) : null;
              })()}

              {/* Stalled: be honest and point to support. */}
              {stage.progress === "stalled" && (
                <p className="rounded-xl border border-error/20 bg-error-container/40 px-4 py-3 text-label-sm leading-relaxed text-on-error-container">
                  The bridge assigned a Bitcoin transaction but it hasn&apos;t
                  been broadcast yet. Your CBTC is burned and the redemption is
                  recorded on Canton — this is a delay on the bridge&apos;s
                  side. If it doesn&apos;t clear soon, contact{" "}
                  <a
                    href="mailto:support@bitsafe.finance"
                    className="underline"
                  >
                    support@bitsafe.finance
                  </a>{" "}
                  with the transaction ID above.
                </p>
              )}

              {stage.progress !== "sent" && stage.progress !== "stalled" && (
                <p className="text-label-sm text-on-surface-variant">
                  This page updates automatically. You can safely leave — the
                  redemption continues on its own.
                </p>
              )}

              <Button
                onClick={reset}
                className="w-full rounded-lg bg-primary-container text-on-primary hover:opacity-90"
              >
                Redeem more
              </Button>
            </div>
          )}

          {stage.kind === "error" && (
            <div className="space-y-md rounded-2xl border border-error/20 bg-surface-container-lowest p-8 shadow-sm">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-error">
                  error
                </span>
                <h2 className="text-headline-md text-error">Redeem failed</h2>
              </div>
              <pre className="overflow-x-auto rounded-lg bg-surface-container p-3 font-mono text-label-sm text-on-surface-variant">
                {stage.message}
              </pre>
              <Button
                onClick={() => setStage({ kind: "form" })}
                className="w-full rounded-lg bg-primary-container text-on-primary hover:opacity-90"
              >
                Try again
              </Button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

const REDEEM_STEPS = [
  {
    n: "01",
    title: "Request Redemption",
    body: "Initiate the process by burning your CBTC. This action is recorded on-chain to trigger the bridge settlement. It is irreversible — once burned, CBTC cannot be restored."
  },
  {
    n: "02",
    title: "Protocol Verification",
    body: "Wait for network confirmations. BitSafe's decentralized attestors verify the burn event across both chains and prepare a Bitcoin transaction."
  },
  {
    n: "03",
    title: "Receive Native BTC",
    body: "Funds are automatically sent to your provided Bitcoin destination address once verification is complete — typically within 30–60 minutes."
  }
] as const;

/** Left-column "How it Works" explainer (matches the redeem wireframe). */
function HowRedeemWorks() {
  return (
    <div className="flex min-w-0 flex-col gap-8 py-4">
      <div>
        <h1 className="mb-4 text-display-lg font-bold text-on-background">
          Redeem CBTC
        </h1>
        <p className="text-body-lg text-on-surface-variant">
          Bridge your assets back to the Bitcoin network securely with
          Oranj&apos;s decentralized protocol.
        </p>
      </div>

      <ol className="flex flex-col gap-8">
        {REDEEM_STEPS.map((step) => (
          <li key={step.n} className="group flex gap-6">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-surface-container-high font-bold text-primary-container transition-colors group-hover:bg-primary-fixed">
              <span className="text-headline-md">{step.n}</span>
            </div>
            <div className="flex min-w-0 flex-col gap-2">
              <h3 className="pt-1 text-headline-md font-bold leading-none text-on-background">
                {step.title}
              </h3>
              <p className="text-body-md leading-relaxed text-on-surface-variant">
                {step.body}
              </p>
            </div>
          </li>
        ))}
      </ol>

      <div className="flex items-start gap-3 rounded-xl border border-error/20 bg-error-container/40 px-4 py-3 text-label-sm leading-relaxed text-on-error-container">
        <span className="material-symbols-outlined text-[18px] text-error">
          warning
        </span>
        <span>
          BTC is sent to exactly the address you enter. Funds sent to a wrong
          address are lost permanently.
        </span>
      </div>
    </div>
  );
}

/** One row in the redeem progress tracker. */
function RedeemStep({
  done = false,
  active = false,
  error = false,
  title,
  detail
}: {
  done?: boolean;
  active?: boolean;
  error?: boolean;
  title: string;
  detail: string;
}) {
  const mark = error ? "!" : done ? "✓" : active ? "…" : "";
  const markClass = error
    ? "border-error/40 bg-error-container text-on-error-container"
    : done
      ? "border-tertiary bg-tertiary-container/40 text-tertiary"
      : active
        ? "border-outline/40 bg-surface-container text-on-surface"
        : "border-outline/20 text-on-surface-variant/50";

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
          className={`block text-body-md font-medium ${
            done || active || error
              ? "text-on-surface"
              : "text-on-surface-variant/60"
          }`}
        >
          {title}
        </span>
        <span className="block text-label-sm text-on-surface-variant">
          {detail}
        </span>
      </span>
    </li>
  );
}

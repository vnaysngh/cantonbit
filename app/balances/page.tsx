"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import { createPortal } from "react-dom";
import { QRCodeSVG } from "qrcode.react";

import { UTXOWarning } from "@/components/UTXOWarning";
import { useBalance } from "@/hooks/useBalance";
import { useCantonIdentity } from "@/hooks/useCantonIdentity";
import { useInvalidateBalances } from "@/hooks/useInvalidateBalances";
import { useTransfers } from "@/hooks/useTransfers";
import {
  CANTON_TRANSFER_ASSETS,
  getTransferAsset,
  type CantonTransferAsset,
  type CantonTransferAssetId
} from "@/lib/canton-assets";
import { formatBtc, parseBtc, timeAgo, truncatePartyId } from "@/lib/format";
import {
  DEFAULT_TRANSFER_EXPIRATION_SECONDS,
  TRANSFER_EXPIRATION_OPTIONS
} from "@/lib/transfer-options";
import type { ActivityRow } from "@/lib/types";
import { cn } from "@/lib/utils";

type Tab = "overview" | "transfers" | "history";

interface PendingOffer {
  contractId: string;
  sender: string;
  receiver: string;
  amountBtc: string;
  requestedAt: string;
  executeBefore: string;
  instrumentId?: { admin?: string; id?: string };
}

function offerAssetSymbol(offer: PendingOffer): string {
  return offer.instrumentId?.id === "Amulet" ? "CC" : "CBTC";
}

const POLL_MS = 30_000;

function truncateParty(party: string): string {
  if (!party) return "";
  const [name, hash] = party.split("::");
  if (!hash) return party;
  return `${name}…${hash.slice(-8)}`;
}

export default function AccountPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-[40vh] items-center justify-center text-muted-foreground">
          Loading…
        </div>
      }
    >
      <AccountPageInner />
    </Suspense>
  );
}

function AccountPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { party, ready, isManaged, isLoop } = useCantonIdentity();
  const {
    total,
    locked,
    utxoCount,
    ccTotal,
    isLoading: balanceLoading
  } = useBalance();
  const invalidateBalances = useInvalidateBalances();
  const {
    activity,
    isLoading: historyLoading,
    refetch: refetchHistory
  } = useTransfers();

  const tabParam = searchParams.get("tab");
  const initialTab: Tab =
    tabParam === "transfers" || tabParam === "history" ? tabParam : "overview";
  const [tab, setTab] = useState<Tab>(initialTab);
  const [showTransfer, setShowTransfer] = useState(false);

  const [incoming, setIncoming] = useState<PendingOffer[]>([]);
  const [outgoing, setOutgoing] = useState<PendingOffer[]>([]);
  const [offersLoading, setOffersLoading] = useState(false);
  const [offersError, setOffersError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (ready && !party) router.replace("/login");
  }, [ready, party, router]);

  const loadOffers = useCallback(async () => {
    if (!isManaged) return;
    setOffersError(null);
    try {
      const [inRes, outRes] = await Promise.all([
        fetch("/api/transfers/pending", { cache: "no-store" }),
        fetch("/api/transfers/outgoing", { cache: "no-store" })
      ]);
      const inJson = (await inRes.json()) as {
        offers?: PendingOffer[];
        error?: string;
      };
      const outJson = (await outRes.json()) as {
        offers?: PendingOffer[];
        error?: string;
      };
      if (!inRes.ok)
        throw new Error(inJson.error ?? `Incoming (${inRes.status})`);
      if (!outRes.ok)
        throw new Error(outJson.error ?? `Outgoing (${outRes.status})`);
      setIncoming(inJson.offers ?? []);
      setOutgoing(outJson.offers ?? []);
    } catch (e) {
      setOffersError(e instanceof Error ? e.message : String(e));
    }
  }, [isManaged]);

  useEffect(() => {
    if (!isManaged || tab !== "transfers") return;
    setOffersLoading(true);
    void loadOffers().finally(() => setOffersLoading(false));
    const id = setInterval(() => void loadOffers(), POLL_MS);
    return () => clearInterval(id);
  }, [isManaged, tab, loadOffers]);

  const transferHistory = useMemo(
    () => activity.filter((a) => a.kind === "sent" || a.kind === "received"),
    [activity]
  );

  const acceptOffer = async (offerContractId: string) => {
    setAccepting((s) => ({ ...s, [offerContractId]: true }));
    try {
      const res = await fetch("/api/transfers/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offerContractId })
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok)
        throw new Error(data.error ?? `Accept failed (${res.status})`);
      setIncoming((cur) => cur.filter((o) => o.contractId !== offerContractId));
      invalidateBalances();
      refetchHistory();
    } catch (e) {
      setOffersError(e instanceof Error ? e.message : String(e));
    } finally {
      setAccepting((s) => {
        const next = { ...s };
        delete next[offerContractId];
        return next;
      });
    }
  };

  if (!ready) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-muted-foreground">
        Loading…
      </div>
    );
  }

  if (!party) return null;

  if (isLoop && !isManaged) {
    return (
      <div className="mx-auto max-w-md space-y-4 py-16 text-center">
        <h1 className="text-2xl font-semibold">Account</h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          P2P transfers for Loop wallet users are coming soon. Send from your
          Loop wallet, or sign in with email for a hosted Canton party.
        </p>
        <Link
          href="/swap"
          className="inline-flex rounded-xl bg-primary px-5 py-2.5 text-sm font-medium text-on-primary"
        >
          Back to Swap
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 pb-10">
      <UTXOWarning count={utxoCount} />

      {/* Page header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Account</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Your Canton balances and transfers
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowTransfer(true)}
          className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-5 py-2.5 text-sm font-medium text-on-primary transition-opacity hover:opacity-90"
        >
          <span className="material-symbols-outlined text-[18px]">send</span>
          Send
        </button>
      </div>

      {/* Tab bar */}
      <div className="flex gap-2 rounded-xl bg-muted/50 p-1">
        {(
          [
            ["overview", "Overview"],
            ["transfers", "Pending"],
            ["history", "History"]
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={cn(
              "flex-1 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
              tab === id
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === "overview" && (
        <OverviewTab
          total={total}
          locked={locked}
          ccTotal={ccTotal}
          loading={balanceLoading}
          party={party}
        />
      )}
      {tab === "transfers" && (
        <TransfersTab
          incoming={incoming}
          outgoing={outgoing}
          loading={offersLoading}
          error={offersError}
          accepting={accepting}
          onAccept={(id) => void acceptOffer(id)}
          onRefresh={() => void loadOffers()}
        />
      )}
      {tab === "history" && (
        <HistoryTab rows={transferHistory} loading={historyLoading} />
      )}

      {showTransfer && (
        <TransferModal
          cbtcBalance={total}
          cbtcLocked={locked}
          ccBalance={ccTotal ?? "0"}
          onClose={() => setShowTransfer(false)}
          onSuccess={() => {
            setShowTransfer(false);
            setTab("history");
            invalidateBalances();
            refetchHistory();
            void loadOffers();
          }}
        />
      )}
    </div>
  );
}

function OverviewTab({
  total,
  locked,
  ccTotal,
  loading,
  party
}: {
  total: string;
  locked: string;
  ccTotal: string | null;
  loading: boolean;
  party: string;
}) {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-2xl border border-foreground/10 bg-card p-6 shadow-sm">
          <p className="text-sm font-medium text-muted-foreground">
            CBTC balance
          </p>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="font-mono text-3xl font-semibold tabular-nums tracking-tight">
              {loading ? "…" : total}
            </span>
            <span className="text-base font-medium text-primary">CBTC</span>
          </div>
          {locked !== "0" && locked !== "" && (
            <p className="mt-2 text-xs text-muted-foreground">
              {locked} CBTC locked in pending transfers
            </p>
          )}
        </div>
        <div className="rounded-2xl border border-foreground/10 bg-card p-6 shadow-sm">
          <p className="text-sm font-medium text-muted-foreground">
            CC balance
          </p>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="font-mono text-3xl font-semibold tabular-nums tracking-tight">
              {loading ? "…" : (ccTotal ?? "0")}
            </span>
            <span className="text-base font-medium text-primary">CC</span>
          </div>
        </div>
      </div>

      <ReceivePanel party={party} />
    </div>
  );
}

function ReceivePanel({ party }: { party: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(party);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="w-full min-w-0 rounded-2xl border border-foreground/10 bg-card p-6 shadow-sm">
      <h2 className="text-base font-semibold">Receive assets</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Share your Canton party ID so others can send you CBTC or CC.
      </p>

      <div className="mt-6 grid w-full min-w-0 gap-6 sm:grid-cols-[auto_1fr] sm:items-start">
        <div className="mx-auto shrink-0 rounded-xl bg-white p-3 shadow-sm sm:mx-0">
          <QRCodeSVG value={party} size={160} level="M" />
        </div>

        <div className="min-w-0 flex-1 space-y-3">
          <div className="w-full min-w-0 rounded-xl border border-foreground/10 bg-muted/30 px-4 py-3">
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Party ID
            </p>
            <p className="break-all font-mono text-xs leading-relaxed text-foreground">
              {party}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void copy()}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-foreground/15 bg-card py-2.5 text-sm font-medium transition-colors hover:bg-muted/50"
          >
            <span className="material-symbols-outlined text-[18px]">
              {copied ? "check" : "content_copy"}
            </span>
            {copied ? "Copied" : "Copy party ID"}
          </button>
        </div>
      </div>
    </div>
  );
}

function TransfersTab({
  incoming,
  outgoing,
  loading,
  error,
  accepting,
  onAccept,
  onRefresh
}: {
  incoming: PendingOffer[];
  outgoing: PendingOffer[];
  loading: boolean;
  error: string | null;
  accepting: Record<string, boolean>;
  onAccept: (id: string) => void;
  onRefresh: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Offers expire after 24 hours if not accepted.
        </p>
        <button
          type="button"
          onClick={onRefresh}
          className="text-sm font-medium text-primary hover:underline"
        >
          Refresh
        </button>
      </div>

      {error && (
        <p className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      )}

      <OfferSection
        title="Incoming"
        empty="No incoming offers"
        loading={loading}
        offers={incoming}
        direction="incoming"
        accepting={accepting}
        onAccept={onAccept}
      />
      <OfferSection
        title="Outgoing"
        empty="No outgoing offers"
        loading={loading}
        offers={outgoing}
        direction="outgoing"
        accepting={accepting}
        onAccept={onAccept}
      />
    </div>
  );
}

function OfferSection({
  title,
  empty,
  loading,
  offers,
  direction,
  accepting,
  onAccept
}: {
  title: string;
  empty: string;
  loading: boolean;
  offers: PendingOffer[];
  direction: "incoming" | "outgoing";
  accepting: Record<string, boolean>;
  onAccept: (id: string) => void;
}) {
  return (
    <section className="rounded-2xl border border-foreground/10 bg-card shadow-sm">
      <h3 className="border-b border-foreground/10 px-4 py-3 text-sm font-semibold">
        {title}
      </h3>
      {loading && offers.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">
          Loading…
        </p>
      ) : offers.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">
          {empty}
        </p>
      ) : (
        <ul className="divide-y divide-foreground/10">
          {offers.map((o) => (
            <li
              key={o.contractId}
              className="flex items-start justify-between gap-4 px-4 py-4"
            >
              <div className="min-w-0">
                <p className="font-mono text-base font-medium tabular-nums">
                  {o.amountBtc} {offerAssetSymbol(o)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {direction === "incoming" ? "From" : "To"}{" "}
                  <span className="font-mono">
                    {truncateParty(
                      direction === "incoming" ? o.sender : o.receiver
                    )}
                  </span>
                </p>
                {o.executeBefore && (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Expires {new Date(o.executeBefore).toLocaleString()}
                  </p>
                )}
              </div>
              {direction === "incoming" ? (
                <button
                  type="button"
                  onClick={() => onAccept(o.contractId)}
                  disabled={!!accepting[o.contractId]}
                  className="shrink-0 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-on-primary disabled:opacity-50"
                >
                  {accepting[o.contractId] ? "Accepting…" : "Accept"}
                </button>
              ) : (
                <span className="shrink-0 rounded-full bg-amber-500/15 px-2.5 py-1 text-xs font-medium text-amber-800 dark:text-amber-200">
                  Pending
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function HistoryTab({
  rows,
  loading
}: {
  rows: ActivityRow[];
  loading: boolean;
}) {
  if (loading && rows.length === 0) {
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">
        Loading…
      </p>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border border-foreground/10 bg-card px-4 py-12 text-center text-sm text-muted-foreground shadow-sm">
        No transfer history yet
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-2xl border border-foreground/10 bg-card shadow-sm">
      <ul className="divide-y divide-foreground/10">
        {rows.map((row) => (
          <li
            key={row.id}
            className="flex items-center justify-between gap-4 px-4 py-4"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium capitalize">
                {row.kind}{" "}
                <span className="font-mono tabular-nums">{row.amount}</span>
              </p>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {truncatePartyId(row.counterparty)} · {timeAgo(row.timestamp)}
              </p>
            </div>
            <span
              className={cn(
                "shrink-0 rounded-full px-2.5 py-1 text-xs font-medium",
                row.status === "complete"
                  ? "bg-green-500/15 text-green-800 dark:text-green-200"
                  : "bg-muted text-muted-foreground"
              )}
            >
              {row.status}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

type TransferStep = "form" | "review" | "done" | "error";

function ModalDetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5 text-sm">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right leading-snug text-foreground">
        {value}
      </span>
    </div>
  );
}

function TransferAssetIcon({
  assetId,
  className
}: {
  assetId: CantonTransferAssetId;
  className?: string;
}) {
  const src = assetId === "CBTC" ? "/cbtc.png" : "/cc-logo.png";
  const alt = assetId === "CBTC" ? "BitSafe CBTC" : "Canton Coin";

  return (
    <span
      className={cn(
        "relative inline-flex size-7 shrink-0 overflow-hidden rounded-full ring-1 ring-foreground/10",
        className
      )}
    >
      <Image
        src={src}
        alt={alt}
        fill
        sizes="32px"
        className="rounded-full object-cover"
      />
    </span>
  );
}

function AssetBadge({ asset }: { asset: CantonTransferAsset }) {
  return (
    <div className="flex shrink-0 items-center gap-2 rounded-full bg-muted/50 py-1.5 pl-1.5 pr-3 ring-1 ring-foreground/10">
      <TransferAssetIcon assetId={asset.id} className="size-7" />
      <div className="leading-tight">
        <div className="text-sm font-semibold">{asset.symbol}</div>
        <div className="text-[10px] text-muted-foreground">{asset.label}</div>
      </div>
    </div>
  );
}

function NetworkFeeSummary({
  ccTotal,
  ccSubsidizedOnDevnet,
  receiveAmount,
  assetSymbol
}: {
  ccTotal: string | null;
  ccSubsidizedOnDevnet: boolean;
  receiveAmount: string;
  assetSymbol: string;
}) {
  return (
    <div className="rounded-xl border border-foreground/10 bg-muted/25 px-4 py-3 text-sm">
      <div className="space-y-2">
        <div className="flex justify-between gap-3">
          <span className="text-muted-foreground">Recipient gets</span>
          <span className="font-mono font-medium tabular-nums">
            {receiveAmount} {assetSymbol}
          </span>
        </div>
        <div className="flex justify-between gap-3">
          <span className="text-muted-foreground">Platform fee</span>
          <span>None</span>
        </div>
        <div className="flex justify-between gap-3">
          <span className="text-muted-foreground">Canton network fee</span>
          <span className="text-right text-xs leading-snug">
            Small amount in Canton Coin
            {ccTotal != null && (
              <>
                <br />
                <span className="text-muted-foreground">
                  Your balance: {ccTotal} CC
                </span>
              </>
            )}
          </span>
        </div>
      </div>
      {/*   <p className="mt-3 border-t border-foreground/10 pt-3 text-xs leading-relaxed text-muted-foreground">
        Network fees are paid in Canton Coin, not deducted from the transfer amount.{" "}
        {ccSubsidizedOnDevnet
          ? "On this network, fees are often covered by the operator."
          : "Amount varies per transaction."}
      </p> */}
    </div>
  );
}

function expirationLabel(seconds: number): string {
  return (
    TRANSFER_EXPIRATION_OPTIONS.find((o) => o.seconds === seconds)?.label ??
    `${Math.round(seconds / 3600)}h`
  );
}

function TransferModal({
  cbtcBalance,
  cbtcLocked,
  ccBalance,
  onClose,
  onSuccess
}: {
  cbtcBalance: string;
  cbtcLocked: string;
  ccBalance: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [mounted, setMounted] = useState(false);
  const [step, setStep] = useState<TransferStep>("form");
  const [submitting, setSubmitting] = useState(false);
  const [asset, setAsset] = useState<CantonTransferAssetId>("CBTC");
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [expirationSeconds, setExpirationSeconds] = useState(
    DEFAULT_TRANSFER_EXPIRATION_SECONDS
  );
  const [error, setError] = useState("");
  const [resultMsg, setResultMsg] = useState("");
  const { ccTotal, ccSubsidizedOnDevnet } = useBalance();

  const selectedAsset = getTransferAsset(asset);
  const balance = asset === "CBTC" ? cbtcBalance : ccBalance;
  const locked = asset === "CBTC" ? cbtcLocked : "0";

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, submitting]);

  const availableSats = useMemo(() => {
    const totalSats = parseBtc(balance || "0");
    const lockedSats = parseBtc(locked || "0");
    return totalSats > lockedSats ? totalSats - lockedSats : 0n;
  }, [balance, locked]);

  const amountSats = parseBtc(amount || "0");
  const recipientValid = recipient.trim().includes("::");
  const amountValid =
    amount !== "" && amountSats > 0n && amountSats <= availableSats;
  const canReview = recipientValid && amountValid;

  const submit = async () => {
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch("/api/transfers/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient: recipient.trim(),
          amount: amount.trim(),
          asset,
          memo: memo.trim() || undefined,
          expirationSeconds
        })
      });
      const data = (await res.json()) as {
        transferKind?: string;
        error?: string;
      };
      if (!res.ok)
        throw new Error(data.error ?? `Transfer failed (${res.status})`);

      setResultMsg(
        data.transferKind === "direct"
          ? "Transfer completed instantly."
          : `Offer sent — the recipient must accept within ${expirationLabel(expirationSeconds).toLowerCase()}.`
      );
      setStep("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep("review");
    } finally {
      setSubmitting(false);
    }
  };

  if (!mounted) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="transfer-modal-title"
    >
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={submitting ? undefined : onClose}
      />

      <div className="relative z-10 w-full max-w-[520px] shrink-0 rounded-3xl border border-foreground/10 bg-card shadow-xl">
        <div className="flex items-center justify-between gap-3 border-b border-foreground/10 px-5 py-4 sm:px-6">
          <h2
            id="transfer-modal-title"
            className="text-lg font-semibold text-foreground"
          >
            {step === "review"
              ? "Confirm send"
              : step === "done"
                ? "Sent"
                : "Send"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-full p-1 text-on-surface-variant transition-all hover:bg-muted hover:text-foreground disabled:opacity-30"
            aria-label="Close"
          >
            <span className="material-symbols-outlined text-[22px]">close</span>
          </button>
        </div>

        <div className="px-5 py-4 sm:px-6 sm:py-5">
          {step === "form" && (
            <div className="space-y-3">
              <div className="rounded-2xl bg-muted/40 p-3 ring-1 ring-transparent">
                <label
                  htmlFor="transfer-asset"
                  className="mb-2 block text-sm font-medium text-muted-foreground"
                >
                  Asset
                </label>
                <select
                  id="transfer-asset"
                  value={asset}
                  onChange={(e) => {
                    setAsset(e.target.value as CantonTransferAssetId);
                    setAmount("");
                  }}
                  className="w-full rounded-lg border border-foreground/10 bg-card px-3 py-2 text-sm outline-none focus:border-primary"
                >
                  {CANTON_TRANSFER_ASSETS.map((id) => {
                    const a = getTransferAsset(id);
                    return (
                      <option key={id} value={id}>
                        {a.symbol} — {a.label}
                      </option>
                    );
                  })}
                </select>
              </div>

              <div className="rounded-2xl bg-muted/40 p-3 ring-1 ring-transparent">
                <label
                  htmlFor="transfer-recipient"
                  className="mb-2 block text-sm font-medium text-muted-foreground"
                >
                  Recipient party ID
                </label>
                <input
                  id="transfer-recipient"
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                  placeholder="alice::1220abcdef…"
                  className="box-border w-full min-w-0 rounded-xl border-0 bg-transparent px-0 py-1 font-mono text-sm text-foreground outline-none placeholder:text-muted-foreground/50"
                />
                {recipient.length > 0 && !recipientValid && (
                  <p className="mt-2 text-xs text-destructive">
                    Must be a Canton party ID (contains ::)
                  </p>
                )}
              </div>

              <div className="rounded-2xl bg-muted/40 p-3 ring-1 ring-transparent">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <label
                    htmlFor="transfer-amount"
                    className="text-sm font-medium text-muted-foreground"
                  >
                    Amount
                  </label>
                  <button
                    type="button"
                    className="rounded-md px-1.5 py-0.5 text-xs font-semibold text-primary transition-colors hover:bg-primary/10"
                    onClick={() => setAmount(formatBtc(availableSats))}
                  >
                    MAX
                  </button>
                </div>
                <div className="flex items-baseline gap-2">
                  <input
                    id="transfer-amount"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    inputMode="decimal"
                    placeholder="0.0"
                    className="min-w-0 flex-1 bg-transparent text-2xl font-semibold leading-none tracking-tight text-foreground outline-none placeholder:text-muted-foreground/40"
                  />
                  <span className="text-sm font-medium text-muted-foreground">
                    {selectedAsset.symbol}
                  </span>
                </div>
                <p className="mt-3 text-xs text-muted-foreground">
                  Available {formatBtc(availableSats)} {selectedAsset.symbol}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-2xl bg-muted/40 p-3 ring-1 ring-transparent">
                  <label
                    htmlFor="transfer-expiration"
                    className="mb-2 block text-sm font-medium text-muted-foreground"
                  >
                    Offer expires
                  </label>
                  <select
                    id="transfer-expiration"
                    value={expirationSeconds}
                    onChange={(e) =>
                      setExpirationSeconds(Number(e.target.value))
                    }
                    className="w-full rounded-lg border border-foreground/10 bg-card px-3 py-2 text-sm outline-none focus:border-primary"
                  >
                    {TRANSFER_EXPIRATION_OPTIONS.map((o) => (
                      <option key={o.seconds} value={o.seconds}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="rounded-2xl bg-muted/40 p-3 ring-1 ring-transparent">
                  <label
                    htmlFor="transfer-memo"
                    className="mb-2 block text-sm font-medium text-muted-foreground"
                  >
                    Memo <span className="font-normal">(optional)</span>
                  </label>
                  <input
                    id="transfer-memo"
                    value={memo}
                    onChange={(e) => setMemo(e.target.value.slice(0, 256))}
                    placeholder="Reference"
                    className="box-border w-full min-w-0 rounded-lg border border-foreground/10 bg-card px-3 py-2 text-sm outline-none focus:border-primary"
                  />
                </div>
              </div>

              <NetworkFeeSummary
                ccTotal={ccTotal}
                ccSubsidizedOnDevnet={ccSubsidizedOnDevnet}
                receiveAmount={amount || "0"}
                assetSymbol={selectedAsset.symbol}
              />

              <button
                type="button"
                disabled={!canReview}
                onClick={() => setStep("review")}
                className="w-full rounded-2xl bg-primary py-3.5 text-base font-semibold text-on-primary transition-all hover:opacity-90 active:scale-[0.99] disabled:opacity-40"
              >
                Review
              </button>
            </div>
          )}

          {step === "review" && (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div className="text-3xl font-medium tabular-nums text-foreground">
                  {amount}{" "}
                  <span className="text-xl text-muted-foreground">
                    {selectedAsset.symbol}
                  </span>
                </div>
                <AssetBadge asset={selectedAsset} />
              </div>

              <div className="flex flex-col gap-1 border-t border-foreground/10 pt-4">
                <ModalDetailRow
                  label="Recipient"
                  value={truncatePartyId(recipient.trim())}
                />
                <div className="rounded-lg bg-muted/30 px-3 py-2">
                  <p className="break-all font-mono text-[11px] leading-relaxed text-muted-foreground">
                    {recipient.trim()}
                  </p>
                </div>
                <ModalDetailRow
                  label="Offer expires"
                  value={expirationLabel(expirationSeconds)}
                />
                {memo.trim() && (
                  <ModalDetailRow label="Memo" value={memo.trim()} />
                )}
                <ModalDetailRow
                  label="Settlement"
                  value="Instant or pending accept"
                />
              </div>

              <NetworkFeeSummary
                ccTotal={ccTotal}
                ccSubsidizedOnDevnet={ccSubsidizedOnDevnet}
                receiveAmount={amount}
                assetSymbol={selectedAsset.symbol}
              />

              <p className="text-xs leading-relaxed text-muted-foreground">
                If the recipient has auto-accept enabled, {selectedAsset.symbol}{" "}
                arrives instantly. Otherwise they must accept your offer before
                it expires.
              </p>

              {error && (
                <p className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </p>
              )}

              <div className="flex flex-col gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => void submit()}
                  disabled={submitting}
                  className="flex w-full items-center justify-center gap-2 rounded-2xl bg-primary py-4 text-base font-semibold text-on-primary transition-all hover:opacity-90 active:scale-[0.99] disabled:opacity-70"
                >
                  {submitting && (
                    <span className="inline-block size-4 animate-spin rounded-full border-2 border-on-primary/40 border-t-on-primary" />
                  )}
                  {submitting ? "Submitting transfer…" : "Confirm send"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setError("");
                    setStep("form");
                  }}
                  disabled={submitting}
                  className="w-full rounded-2xl py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
                >
                  Back
                </button>
              </div>
            </div>
          )}

          {(step === "done" || step === "error") && (
            <div className="space-y-4 py-2 text-center">
              <span
                className={cn(
                  "material-symbols-outlined text-[40px]",
                  step === "error" ? "text-destructive" : "text-primary"
                )}
              >
                {step === "error" ? "error" : "check_circle"}
              </span>
              <p
                className={cn(
                  "text-sm leading-relaxed",
                  step === "error" ? "text-destructive" : "text-foreground"
                )}
              >
                {step === "error" ? error : resultMsg}
              </p>
              <button
                type="button"
                onClick={() => {
                  if (step === "done") onSuccess();
                  else {
                    setStep("form");
                    setError("");
                  }
                }}
                className="w-full rounded-2xl bg-primary py-3.5 text-base font-semibold text-on-primary transition-all hover:opacity-90 active:scale-[0.99]"
              >
                {step === "done" ? "View in history" : "Try again"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

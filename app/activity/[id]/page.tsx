"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  Clock,
  Copy as CopyIcon
} from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

import { Card, CardContent } from "@/components/ui/card";
import { NETWORK } from "@/lib/constants";
import { formatBtc } from "@/lib/format";
import type { ActivityRow } from "@/lib/types";
import { cn } from "@/lib/utils";

/* ─── Types ─── */

type RedeemStatus = "burned" | "broadcasting" | "sent" | "stalled";
type MintStatus = "pending" | "minted";

interface RedeemDetail {
  id: string;
  destinationBtcAddress: string | null;
  amount: string;
  btcTxId: string | null;
  status: RedeemStatus;
  /** burn timestamp — API returns this as both `createdAt` (legacy) and `burnAt` */
  createdAt: string;
  /** alias: the API (RedeemHistoryItem) uses burnAt; we normalise below */
  burnAt?: string;
  requestSeenAt: string | null;
  /** alias: API uses requestAt */
  requestAt?: string | null;
  btcConfirmedAt: string | null;
  /** alias: API uses completedAt */
  completedAt?: string | null;
}

interface MintDetail {
  id: string;
  amount: string | null;
  bitcoinAddress: string | null;
  depositAccountCreatedAt: string | null;
  depositAccountContractId: string | null;
  deliveredAt: string | null;
  deliveryUpdateId: string | null;
  status: MintStatus;
}

type ActivityDetail =
  | { kind: "redeem"; redeem: RedeemDetail }
  | { kind: "mint"; mint: MintDetail };

/* ─── Helpers ─── */

function explorerTxUrl(txId: string | null | undefined): string | null {
  if (!txId) return null;
  const id = encodeURIComponent(txId.trim());
  if (NETWORK.name === "mainnet") return `https://mempool.space/tx/${id}`;
  if (NETWORK.name === "testnet")
    return `https://mempool.space/testnet/tx/${id}`;
  return null;
}

function explorerAddrUrl(address: string | null | undefined): string | null {
  if (!address) return null;
  const a = encodeURIComponent(address.trim());
  if (NETWORK.name === "mainnet") return `https://mempool.space/address/${a}`;
  if (NETWORK.name === "testnet")
    return `https://mempool.space/testnet/address/${a}`;
  return null;
}

function fmtFull(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function fmtShort(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

/* ─── Page ─── */

export default function ActivityDetailPage() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();

  const placeholder = (): ActivityDetail | undefined => {
    const cached = queryClient.getQueriesData<ActivityRow[]>({
      queryKey: ["activity"]
    });
    for (const [, rows] of cached) {
      const row = rows?.find((r) => r.id === id);
      if (!row) continue;
      if (row.kind === "redeemed") {
        // Map activity status back to RedeemStatus. "pending" = burned (submitted,
        // waiting for bridge); "broadcasting" / "stalled" pass through unchanged.
        const redeemStatus: RedeemStatus =
          row.status === "complete"
            ? "sent"
            : row.status === "broadcasting"
              ? "broadcasting"
              : row.status === "stalled"
                ? "stalled"
                : "burned";
        // counterparty is "Bitcoin withdrawal" when we didn't capture the BTC
        // address from the ledger — treat that as null so the detail page doesn't
        // show a fake address.
        const btcAddr =
          row.counterparty && row.counterparty !== "Bitcoin withdrawal"
            ? row.counterparty
            : null;
        return {
          kind: "redeem",
          redeem: {
            id: row.id,
            destinationBtcAddress: btcAddr,
            amount: row.amount,
            btcTxId: row.btcTxId ?? null,
            status: redeemStatus,
            createdAt: row.timestamp,
            requestSeenAt: null,
            btcConfirmedAt: null
          }
        };
      }
      if (row.kind === "minted") {
        return {
          kind: "mint",
          mint: {
            id: row.id,
            amount: row.amount === "0" ? null : row.amount,
            bitcoinAddress: row.bitcoinAddress ?? null,
            depositAccountCreatedAt: null,
            depositAccountContractId: null,
            deliveredAt: row.timestamp,
            deliveryUpdateId: row.id,
            status: row.status === "complete" ? "minted" : "pending"
          }
        };
      }
    }
    return undefined;
  };

  const { data, error, isLoading } = useQuery({
    queryKey: ["activity-detail", id],
    enabled: !!id,
    placeholderData: placeholder,
    queryFn: async (): Promise<ActivityDetail> => {
      const res = await fetch(`/api/activity/${id}`);
      const json = (await res.json()) as ActivityDetail | { error?: string };
      if (!res.ok || !("kind" in json))
        throw new Error(
          ("error" in json && json.error) || "Activity not found."
        );
      return json;
    }
  });

  // Normalise field-name aliases: the API (RedeemHistoryItem) uses burnAt /
  // requestAt / completedAt; the page interface uses createdAt / requestSeenAt /
  // btcConfirmedAt. Coerce here so the views always get the right names.
  const rawDetail = data ?? null;
  const detail: ActivityDetail | null = rawDetail
    ? rawDetail.kind === "redeem"
      ? {
          kind: "redeem",
          redeem: {
            ...rawDetail.redeem,
            createdAt:
              rawDetail.redeem.createdAt ??
              (rawDetail.redeem as unknown as { burnAt?: string }).burnAt ??
              "",
            requestSeenAt:
              rawDetail.redeem.requestSeenAt ??
              (rawDetail.redeem as unknown as { requestAt?: string | null })
                .requestAt ??
              null,
            btcConfirmedAt:
              rawDetail.redeem.btcConfirmedAt ??
              (rawDetail.redeem as unknown as { completedAt?: string | null })
                .completedAt ??
              null
          }
        }
      : rawDetail
    : null;
  const errorMsg = error instanceof Error ? error.message : null;
  const loading = isLoading && !detail;

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <Link
        href="/activity"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-4 w-4" /> Back to activity
      </Link>

      {loading && <PageSkeleton />}

      {!loading && errorMsg && (
        <Card>
          <CardContent className="py-16 text-center text-sm text-muted-foreground">
            {errorMsg}
          </CardContent>
        </Card>
      )}

      {!loading && detail?.kind === "redeem" && (
        <RedeemView redeem={detail.redeem} />
      )}
      {!loading && detail?.kind === "mint" && <MintView mint={detail.mint} />}
    </div>
  );
}

/* ─── Skeleton ─── */

function PageSkeleton() {
  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div className="h-5 w-28 animate-pulse rounded-full bg-muted" />
        <div className="h-12 w-64 animate-pulse rounded bg-muted" />
        <div className="h-4 w-48 animate-pulse rounded bg-muted" />
      </div>
      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <Card>
          <CardContent className="space-y-6 py-6 px-6">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex gap-4">
                <div className="h-6 w-6 shrink-0 animate-pulse rounded-full bg-muted mt-0.5" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
                  <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
        <div className="space-y-3">
          {[0, 1].map((i) => (
            <Card key={i}>
              <CardContent className="py-4 px-4 space-y-2">
                <div className="h-3 w-20 animate-pulse rounded bg-muted" />
                <div className="h-4 w-full animate-pulse rounded bg-muted" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ─── Shared sub-components ─── */

type BadgeTone = "success" | "info" | "warning" | "neutral";

function Badge({ label, tone }: { label: string; tone: BadgeTone }) {
  const cls: Record<BadgeTone, string> = {
    success:
      "bg-green-500/10 text-green-600 dark:text-green-400 border border-green-500/20",
    info: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20",
    warning:
      "bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20",
    neutral: "bg-muted text-muted-foreground border border-border"
  };
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center rounded-full px-3 text-[11px] font-medium tracking-wide",
        cls[tone]
      )}
    >
      {label}
    </span>
  );
}

function DetailCard({
  label,
  children
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="py-4 px-4">
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          {label}
        </p>
        {children}
      </CardContent>
    </Card>
  );
}

function CopyableField({
  label,
  value,
  href,
  hrefLabel
}: {
  label: string;
  value: string;
  href?: string | null;
  hrefLabel?: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };
  return (
    <DetailCard label={label}>
      <div className="flex items-start gap-2">
        <p className="flex-1 break-all font-mono text-xs leading-relaxed">
          {value}
        </p>
        <button
          type="button"
          onClick={copy}
          className="shrink-0 inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        >
          {copied ? (
            <>
              <Check className="h-3 w-3" />
              Copied
            </>
          ) : (
            <>
              <CopyIcon className="h-3 w-3" />
              Copy
            </>
          )}
        </button>
      </div>
      {href && (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-blue-500 hover:underline"
        >
          {hrefLabel ?? "Open"} <ArrowUpRight className="h-3 w-3" />
        </a>
      )}
    </DetailCard>
  );
}

/* ─── Timeline step ─── */

function Step({
  done = false,
  active = false,
  error = false,
  last = false,
  title,
  detail,
  time
}: {
  done?: boolean;
  active?: boolean;
  error?: boolean;
  last?: boolean;
  title: string;
  detail: string;
  time?: string;
}) {
  const dot = error
    ? "border border-amber-500/50 text-amber-500"
    : done
      ? "border border-green-500/40 bg-green-500/10 text-green-500"
      : active
        ? "border border-foreground/40 text-foreground"
        : "border border-border/40 text-muted-foreground/20";

  return (
    <li className="flex gap-4">
      <div className="flex flex-col items-center">
        <span
          className={cn(
            "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px]",
            dot
          )}
        >
          {done ? (
            <Check className="h-3 w-3" strokeWidth={2} />
          ) : error ? (
            "!"
          ) : active ? (
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
          ) : null}
        </span>
        {!last && <div className="mt-1 w-px flex-1 bg-border min-h-[28px]" />}
      </div>
      <div className={cn("flex-1 pb-6", last && "pb-0")}>
        <div className="flex items-start justify-between gap-6">
          <div className="space-y-0.5">
            <p
              className={cn(
                "text-sm font-semibold leading-snug",
                !(done || active || error) && "text-muted-foreground/40"
              )}
            >
              {title}
            </p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              {detail}
            </p>
          </div>
          {time && (
            <p className="shrink-0 text-[11px] tabular-nums text-muted-foreground whitespace-nowrap">
              {time}
            </p>
          )}
        </div>
      </div>
    </li>
  );
}

/* ─── REDEEM VIEW ─── */

function RedeemView({ redeem }: { redeem: RedeemDetail }) {
  const tone: BadgeTone =
    redeem.status === "sent"
      ? "success"
      : redeem.status === "stalled"
        ? "warning"
        : "info";
  const statusLabel = {
    burned: "Redemption in progress",
    broadcasting: "Broadcasting to Bitcoin",
    sent: "Bitcoin sent",
    stalled: "Stalled — bridge delay"
  }[redeem.status];

  // Always show the details column — even pending redeems have a destination address and initiated time.
  const hasDetails = true;

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="space-y-2">
        <Badge label={statusLabel} tone={tone} />
        <div className="flex items-baseline gap-2">
          <h1 className="text-5xl font-bold tabular-nums tracking-tight">
            {formatBtc(redeem.amount)}
          </h1>
          <span className="text-2xl font-medium text-muted-foreground">
            CBTC
          </span>
        </div>
        {redeem.createdAt && (
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Clock className="h-3.5 w-3.5 shrink-0" />{" "}
            {fmtFull(redeem.createdAt)}
          </p>
        )}
      </div>

      {/* Body */}
      <div
        className={cn("grid gap-6", hasDetails && "lg:grid-cols-[1fr_380px]")}
      >
        {/* Timeline */}
        <Card>
          <CardContent className="py-6 px-6">
            <p className="mb-6 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
              Timeline
            </p>
            <ol className="space-y-0">
              <Step
                done
                title={`Burned ${formatBtc(redeem.amount)} CBTC`}
                detail="Destroyed on Canton ledger."
                time={fmtShort(redeem.createdAt)}
                last={false}
              />
              <Step
                done={redeem.status !== "burned"}
                active={redeem.status === "burned"}
                title="Bridge picked up redemption"
                detail={
                  redeem.status === "burned"
                    ? "Waiting for the bridge to assign a Bitcoin transaction…"
                    : "Bridge assigned a Bitcoin transaction."
                }
                time={fmtShort(redeem.requestSeenAt)}
                last={false}
              />
              <Step
                done={redeem.status === "sent"}
                active={redeem.status === "broadcasting"}
                error={redeem.status === "stalled"}
                title="Bitcoin broadcast"
                detail={
                  redeem.status === "sent"
                    ? "Confirmed on the Bitcoin network."
                    : redeem.status === "stalled"
                      ? "Transaction assigned but not yet on-chain."
                      : "Broadcasting to the Bitcoin network…"
                }
                time={fmtShort(redeem.btcConfirmedAt)}
                last
              />
            </ol>
          </CardContent>
        </Card>

        {/* Details column */}
        {hasDetails && (
          <div className="space-y-3">
            {redeem.createdAt && (
              <DetailCard label="Initiated">
                <p className="text-sm font-medium">
                  {fmtFull(redeem.createdAt)}
                </p>
              </DetailCard>
            )}
            {redeem.destinationBtcAddress && (
              <DetailCard label="Destination address">
                <p className="break-all font-mono text-xs leading-relaxed">
                  {redeem.destinationBtcAddress}
                </p>
                {(() => {
                  const url = explorerAddrUrl(redeem.destinationBtcAddress);
                  return url ? (
                    <a
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-blue-500 hover:underline"
                    >
                      Track on mempool.space{" "}
                      <ArrowUpRight className="h-3 w-3" />
                    </a>
                  ) : null;
                })()}
              </DetailCard>
            )}
            {redeem.btcTxId && (
              <CopyableField
                label="Bitcoin transaction ID"
                value={redeem.btcTxId}
                href={explorerTxUrl(redeem.btcTxId)}
                hrefLabel="View on mempool.space"
              />
            )}
            {redeem.status === "stalled" && (
              <Card className="border-amber-400/30 bg-amber-50 dark:bg-amber-950/20">
                <CardContent className="py-4 px-4 text-xs leading-relaxed text-amber-800 dark:text-amber-300">
                  Your CBTC is burned and recorded on Canton. This is a delay on
                  the bridge side. Contact{" "}
                  <a
                    href="mailto:support@bitsafe.finance"
                    className="font-semibold underline"
                  >
                    support@bitsafe.finance
                  </a>{" "}
                  if it doesn&apos;t resolve.
                </CardContent>
              </Card>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── MINT VIEW ─── */

interface BtcInfo {
  txid: string | null;
  blockHeight: number | null;
  receivedBtc: number | null;
  tipHeight: number | null;
}

const CONFS_REQUIRED = 6;

async function fetchBtcInfo(address: string): Promise<BtcInfo | null> {
  const base =
    NETWORK.name === "mainnet"
      ? "https://mempool.space/api"
      : NETWORK.name === "testnet"
        ? "https://mempool.space/testnet/api"
        : null;
  if (!base) return null;
  try {
    const [addrRes, tipRes, txsRes] = await Promise.all([
      fetch(`${base}/address/${encodeURIComponent(address)}`),
      fetch(`${base}/blocks/tip/height`),
      fetch(`${base}/address/${encodeURIComponent(address)}/txs`)
    ]);
    if (!addrRes.ok || !tipRes.ok) return null;
    const addr = (await addrRes.json()) as {
      chain_stats?: { funded_txo_sum?: number };
      mempool_stats?: { funded_txo_sum?: number };
    };
    const tipHeight = Number(await tipRes.text());
    const receivedSat =
      (addr.chain_stats?.funded_txo_sum ?? 0) +
      (addr.mempool_stats?.funded_txo_sum ?? 0);
    let txid: string | null = null;
    let blockHeight: number | null = null;
    if (txsRes.ok) {
      const txs = (await txsRes.json()) as Array<{
        txid: string;
        status?: { block_height?: number };
      }>;
      const oldest = [...txs].reverse()[0];
      if (oldest) {
        txid = oldest.txid;
        blockHeight = oldest.status?.block_height ?? null;
      }
    }
    return {
      txid,
      blockHeight,
      receivedBtc: receivedSat > 0 ? receivedSat / 1e8 : null,
      tipHeight: Number.isFinite(tipHeight) ? tipHeight : null
    };
  } catch {
    return null;
  }
}

function MintView({ mint }: { mint: MintDetail }) {
  const [btc, setBtc] = useState<BtcInfo | null>(null);
  const [btcLoading, setBtcLoading] = useState(false);

  useEffect(() => {
    if (!mint.bitcoinAddress) return;
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      setBtcLoading(true);
      void fetchBtcInfo(mint.bitcoinAddress!).then((info) => {
        if (!cancelled) {
          setBtc(info);
          setBtcLoading(false);
        }
      });
    });
    return () => {
      cancelled = true;
    };
  }, [mint.bitcoinAddress]);

  const confs =
    btc?.blockHeight && btc?.tipHeight
      ? Math.max(0, btc.tipHeight - btc.blockHeight + 1)
      : 0;
  const btcSeen = !!btc?.txid;
  const confirmed = confs >= CONFS_REQUIRED;
  const delivered = mint.status === "minted";
  const isOrphan = !mint.depositAccountContractId;

  const statusLabel = delivered
    ? "CBTC received"
    : btcSeen
      ? confirmed
        ? "Waiting for delivery"
        : `Confirming on Bitcoin (${confs}/${CONFS_REQUIRED})`
      : "Awaiting Bitcoin deposit";
  const tone: BadgeTone = delivered ? "success" : btcSeen ? "info" : "neutral";
  const timestamp = mint.deliveredAt ?? mint.depositAccountCreatedAt;

  const hasDetails = !!(mint.deliveredAt || mint.bitcoinAddress || btc?.txid);

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="space-y-2">
        <Badge label={statusLabel} tone={tone} />
        <div className="flex items-baseline gap-2">
          <h1 className="text-5xl font-bold tabular-nums tracking-tight">
            {mint.amount ? formatBtc(mint.amount) : "—"}
          </h1>
          <span className="text-2xl font-medium text-muted-foreground">
            CBTC
          </span>
        </div>
        {timestamp && (
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Clock className="h-3.5 w-3.5 shrink-0" /> {fmtFull(timestamp)}
          </p>
        )}
      </div>

      {/* Body */}
      <div
        className={cn("grid gap-6", hasDetails && "lg:grid-cols-[1fr_380px]")}
      >
        {/* Timeline */}
        <Card>
          <CardContent className="py-6 px-6">
            <p className="mb-6 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
              Timeline
            </p>
            {isOrphan ? (
              <ol className="space-y-0">
                <Step
                  done
                  title="Bitcoin received"
                  detail={
                    btc?.receivedBtc
                      ? `${btc.receivedBtc.toFixed(8)} BTC deposited.`
                      : "BTC was received."
                  }
                  time={
                    btc?.blockHeight ? `block ${btc.blockHeight}` : undefined
                  }
                  last={false}
                />
                <Step
                  done
                  title={`${CONFS_REQUIRED} Bitcoin confirmations`}
                  detail="Confirmed on the Bitcoin network."
                  last={false}
                />
                <Step
                  done
                  title="CBTC delivered to your wallet"
                  detail={`${mint.amount ? formatBtc(mint.amount) + " " : ""}CBTC minted to your wallet.`}
                  time={fmtShort(mint.deliveredAt)}
                  last
                />
              </ol>
            ) : (
              <ol className="space-y-0">
                <Step
                  done={!!mint.depositAccountCreatedAt}
                  title="Deposit account created"
                  detail="A Bitcoin deposit address was issued for you on Canton."
                  time={fmtShort(mint.depositAccountCreatedAt)}
                  last={false}
                />
                <Step
                  done={btcSeen || delivered}
                  active={!btcSeen && !delivered}
                  title="Bitcoin received"
                  detail={
                    btcLoading
                      ? "Checking the Bitcoin chain…"
                      : btcSeen
                        ? btc?.receivedBtc
                          ? `${btc.receivedBtc.toFixed(8)} BTC seen at deposit address.`
                          : "Deposit detected."
                        : delivered
                          ? "BTC was received."
                          : "Send BTC to your deposit address."
                  }
                  time={
                    btc?.blockHeight ? `block ${btc.blockHeight}` : undefined
                  }
                  last={false}
                />
                <Step
                  done={confirmed || delivered}
                  active={btcSeen && !confirmed && !delivered}
                  title={`${CONFS_REQUIRED} Bitcoin confirmations`}
                  detail={
                    delivered
                      ? "Confirmed."
                      : btcSeen
                        ? confirmed
                          ? "Confirmed. Bridge releasing CBTC."
                          : `${confs} of ${CONFS_REQUIRED} — ~10 min each.`
                        : "Starts once your BTC is in a block."
                  }
                  last={false}
                />
                <Step
                  done={delivered}
                  active={confirmed && !delivered}
                  title="CBTC delivered to your wallet"
                  detail={
                    delivered
                      ? `${mint.amount ? formatBtc(mint.amount) + " " : ""}CBTC is in your wallet.`
                      : "Bridging onto Canton…"
                  }
                  time={fmtShort(mint.deliveredAt)}
                  last
                />
              </ol>
            )}
          </CardContent>
        </Card>

        {/* Details column */}
        {hasDetails && (
          <div className="space-y-3">
            {mint.deliveredAt && (
              <DetailCard label="Delivered at">
                <p className="text-sm font-medium">
                  {fmtFull(mint.deliveredAt)}
                </p>
              </DetailCard>
            )}
            {mint.bitcoinAddress && (
              <DetailCard label="Bitcoin deposit address">
                <p className="break-all font-mono text-xs leading-relaxed">
                  {mint.bitcoinAddress}
                </p>
                {(() => {
                  const url = explorerAddrUrl(mint.bitcoinAddress);
                  return url ? (
                    <a
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-blue-500 hover:underline"
                    >
                      Track on mempool.space{" "}
                      <ArrowUpRight className="h-3 w-3" />
                    </a>
                  ) : null;
                })()}
              </DetailCard>
            )}
            {btc?.txid && (
              <CopyableField
                label="Bitcoin deposit transaction"
                value={btc.txid}
                href={explorerTxUrl(btc.txid)}
                hrefLabel="View on mempool.space"
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

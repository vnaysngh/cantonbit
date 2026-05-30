"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  Copy as CopyIcon,
} from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { NETWORK } from "@/lib/constants";
import { formatBtc } from "@/lib/format";
import type { ActivityRow } from "@/lib/types";
import { cn } from "@/lib/utils";

type RedeemStatus = "burned" | "broadcasting" | "sent" | "stalled";
type MintStatus = "pending" | "minted";

interface RedeemDetail {
  id: string;
  destinationBtcAddress: string | null;
  amount: string;
  btcTxId: string | null;
  status: RedeemStatus;
  createdAt: string;
  requestSeenAt: string | null;
  btcConfirmedAt: string | null;
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

function btcExplorerTxUrl(txId: string | null | undefined): string | null {
  if (!txId) return null;
  const id = encodeURIComponent(txId.trim());
  switch (NETWORK.name) {
    case "mainnet":
      return `https://mempool.space/tx/${id}`;
    case "testnet":
      return `https://mempool.space/testnet/tx/${id}`;
    default:
      return null;
  }
}

function btcExplorerAddressUrl(address: string | null | undefined): string | null {
  if (!address) return null;
  const addr = encodeURIComponent(address.trim());
  switch (NETWORK.name) {
    case "mainnet":
      return `https://mempool.space/address/${addr}`;
    case "testnet":
      return `https://mempool.space/testnet/address/${addr}`;
    default:
      return null;
  }
}

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

const REDEEM_TITLE: Record<RedeemStatus, string> = {
  burned: "Redemption in progress",
  broadcasting: "Redemption in progress",
  sent: "Bitcoin sent",
  stalled: "Taking longer than expected",
};

export default function ActivityDetailPage() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();

  // PERF: seed the detail page from the activity-feed cache, so when the user
  // clicks a row they came from /activity the page renders an immediate
  // skeleton with what we already know (amount, kind, status, btcTxId,
  // bitcoinAddress) — no waiting for the full /api/activity/[id] re-scan.
  // The real fetch still runs in the background and fills in the rest.
  const placeholder = (): ActivityDetail | undefined => {
    // The feed query is keyed ["activity", partyId] but we don't know the
    // party here. Find ANY cached "activity" entry containing this id.
    const cached = queryClient.getQueriesData<ActivityRow[]>({
      queryKey: ["activity"],
    });
    for (const [, rows] of cached) {
      const row = rows?.find((r) => r.id === id);
      if (!row) continue;
      if (row.kind === "redeemed") {
        return {
          kind: "redeem",
          redeem: {
            id: row.id,
            destinationBtcAddress: row.counterparty ?? null,
            amount: row.amount,
            btcTxId: row.btcTxId ?? null,
            status: row.status === "complete" ? "sent" : (row.status as RedeemStatus),
            createdAt: row.timestamp,
            requestSeenAt: null,
            btcConfirmedAt: null,
          },
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
            status: row.status === "complete" ? "minted" : "pending",
          },
        };
      }
    }
    return undefined;
  };

  // React Query: stale-while-revalidate. If we've fetched this id before in
  // the session, the cached detail renders instantly while the background
  // refetch refreshes the status (useful for pending redeems).
  const { data, error, isLoading } = useQuery({
    queryKey: ["activity-detail", id],
    enabled: !!id,
    // Cached-row seed: instant first paint with what we already know.
    placeholderData: placeholder,
    queryFn: async (): Promise<ActivityDetail> => {
      const res = await fetch(`/api/activity/${id}`);
      const json = (await res.json()) as
        | { kind: "redeem"; redeem: RedeemDetail }
        | { kind: "mint"; mint: MintDetail }
        | { error?: string };
      if (!res.ok || !("kind" in json)) {
        throw new Error(
          ("error" in json && json.error) || "Activity not found.",
        );
      }
      return json;
    },
  });
  const detail = data ?? null;
  const errorMsg = error instanceof Error ? error.message : null;
  // With placeholderData seeded, isLoading is true only on the very first
  // visit (no feed cached). After that, the page renders instantly.
  const loading = isLoading && !detail;

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <Link
        href="/activity"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Back to activity
      </Link>

      {/* Hide the title until we know the kind — otherwise the fallback flashes
          the wrong word (e.g. "Redemption" briefly before resolving to "Mint"). */}
      {detail && (
        <h1 className="text-2xl font-semibold tracking-tight">
          {detail.kind === "mint" ? "Mint" : "Redemption"}
        </h1>
      )}

      {loading && <DetailSkeleton />}

      {!loading && errorMsg && (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
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

/* ─────────────────────────── skeleton ─────────────────────────── */

/**
 * A real card-shaped skeleton, not an empty grey box. Mirrors the layout of
 * the actual detail card so the layout shift on load is invisible.
 */
function DetailSkeleton() {
  return (
    <Card>
      <CardContent className="space-y-6 py-6">
        <div className="space-y-2">
          <div className="h-3 w-20 animate-pulse rounded bg-muted" />
          <div className="h-7 w-44 animate-pulse rounded bg-muted" />
        </div>
        <div className="grid grid-cols-2 gap-6">
          <div className="space-y-2">
            <div className="h-3 w-16 animate-pulse rounded bg-muted" />
            <div className="h-5 w-24 animate-pulse rounded bg-muted" />
          </div>
          <div className="space-y-2">
            <div className="h-3 w-28 animate-pulse rounded bg-muted" />
            <div className="h-5 w-full animate-pulse rounded bg-muted" />
          </div>
        </div>
        <div className="space-y-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex items-start gap-3">
              <div className="mt-0.5 h-5 w-5 shrink-0 animate-pulse rounded-full bg-muted" />
              <div className="flex-1 space-y-1.5">
                <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
                <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

/* ─────────────────────────── reusable bits ─────────────────────────── */

/** Status badge shown above the card title. Replaces the old colored title. */
function StatusBadge({
  label,
  tone,
}: {
  label: string;
  tone: "success" | "info" | "warning" | "neutral";
}) {
  const classes = {
    success:
      "bg-green-500/10 text-green-700 dark:bg-green-500/15 dark:text-green-400",
    info: "bg-blue-500/10 text-blue-700 dark:bg-blue-500/15 dark:text-blue-400",
    warning:
      "bg-amber-500/10 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400",
    neutral: "bg-muted text-muted-foreground",
  }[tone];
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center rounded-full px-2.5 text-[11px] font-medium",
        classes,
      )}
    >
      {label}
    </span>
  );
}

/** Field that shows a long identifier with a copy button + optional external link. */
function IdentifierField({
  label,
  value,
  href,
  hrefLabel,
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
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* ignore */
    }
  };
  return (
    <div className="space-y-2 rounded-xl border bg-muted/30 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <button
          type="button"
          onClick={copy}
          className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label="Copy"
        >
          {copied ? (
            <>
              <Check className="h-3.5 w-3.5" /> Copied
            </>
          ) : (
            <>
              <CopyIcon className="h-3.5 w-3.5" /> Copy
            </>
          )}
        </button>
      </div>
      <p className="break-all font-mono text-[11px] leading-relaxed">{value}</p>
      {href && (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs font-medium text-foreground/80 hover:text-foreground"
        >
          {hrefLabel ?? "Open"} <ArrowUpRight className="h-3.5 w-3.5" />
        </a>
      )}
    </div>
  );
}

/* ─────────────────────────── REDEEM VIEW ─────────────────────────── */

function RedeemView({ redeem }: { redeem: RedeemDetail }) {
  const tone =
    redeem.status === "sent"
      ? "success"
      : redeem.status === "stalled"
        ? "warning"
        : "info";

  return (
    <Card>
      <CardContent className="space-y-6 py-6">
        {/* Header: status pill + headline amount. */}
        <div className="space-y-3">
          <StatusBadge label={REDEEM_TITLE[redeem.status]} tone={tone} />
          <div className="flex items-baseline gap-2">
            <span className="text-4xl font-semibold tracking-tight tabular-nums">
              {formatBtc(redeem.amount)}
            </span>
            <span className="text-sm font-medium text-muted-foreground">
              CBTC
            </span>
          </div>
          {redeem.destinationBtcAddress && (
            <div className="text-xs text-muted-foreground">
              to{" "}
              <span className="break-all font-mono text-foreground/80">
                {redeem.destinationBtcAddress}
              </span>
            </div>
          )}
        </div>

        {/* Step timeline. */}
        <ol className="space-y-4">
          <Step
            done
            title={`Burned ${formatBtc(redeem.amount)} CBTC`}
            detail="Destroyed on Canton."
            time={fmtTime(redeem.createdAt)}
          />
          <Step
            done={redeem.status !== "burned"}
            active={redeem.status === "burned"}
            title="Bridge prepared transaction"
            detail={
              redeem.status === "burned"
                ? "Waiting for the bridge to pick up your redemption…"
                : "The bridge assigned a Bitcoin transaction."
            }
            time={fmtTime(redeem.requestSeenAt)}
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
                  ? "The transaction hasn't appeared on-chain yet."
                  : "Broadcasting to the Bitcoin network…"
            }
            time={fmtTime(redeem.btcConfirmedAt)}
          />
        </ol>

        {redeem.btcTxId && (
          <IdentifierField
            label="Bitcoin transaction"
            value={redeem.btcTxId}
            href={btcExplorerTxUrl(redeem.btcTxId)}
            hrefLabel="View on mempool.space"
          />
        )}

        {(() => {
          const url = btcExplorerAddressUrl(redeem.destinationBtcAddress);
          return url ? (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              Track destination address <ArrowUpRight className="h-3.5 w-3.5" />
            </a>
          ) : null;
        })()}

        {redeem.status === "stalled" && (
          <p className="rounded-xl border border-amber-300/60 bg-amber-50 px-3 py-3 text-xs leading-relaxed text-amber-900 dark:border-amber-700/40 dark:bg-amber-950/30 dark:text-amber-200">
            The bridge assigned a Bitcoin transaction but it hasn&apos;t been
            broadcast yet. Your CBTC is burned and the redemption is recorded on
            Canton — this is a delay on the bridge&apos;s side. If it
            doesn&apos;t clear soon, contact{" "}
            <a
              href="mailto:support@bitsafe.finance"
              className="font-medium underline"
            >
              support@bitsafe.finance
            </a>
            .
          </p>
        )}

        <Link href="/activity" className="block">
          <Button variant="outline" className="w-full">
            Back to activity
          </Button>
        </Link>
      </CardContent>
    </Card>
  );
}

/* ─────────────────────────── MINT VIEW ─────────────────────────── */

/**
 * A summary of what mempool.space knows about the deposit address.
 * Fetched once on the detail page (not the activity feed) so we don't pay the
 * mempool round-trip per row.
 */
interface BtcAddressInfo {
  /** First incoming tx to the deposit address — likely the user's deposit. */
  txid: string | null;
  /** Block height the deposit tx confirmed in. Null = unconfirmed. */
  blockHeight: number | null;
  /** Total BTC sent to the address. */
  receivedBtc: number | null;
  /** Current Bitcoin tip height (for confirmation count). */
  tipHeight: number | null;
}

const CONFIRMATIONS_REQUIRED = 6;

async function fetchBtcAddressInfo(
  address: string,
): Promise<BtcAddressInfo | null> {
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
      fetch(`${base}/address/${encodeURIComponent(address)}/txs`),
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
        status?: { confirmed?: boolean; block_height?: number };
      }>;
      // Pick the OLDEST incoming tx (the original deposit), not the most recent.
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
      tipHeight: Number.isFinite(tipHeight) ? tipHeight : null,
    };
  } catch {
    return null;
  }
}

function MintView({ mint }: { mint: MintDetail }) {
  const [btc, setBtc] = useState<BtcAddressInfo | null>(null);
  const [btcLoading, setBtcLoading] = useState(false);

  useEffect(() => {
    if (!mint.bitcoinAddress) return;
    let cancelled = false;
    // Microtask defer so we don't setState synchronously in the effect body.
    void Promise.resolve().then(() => {
      if (cancelled) return;
      setBtcLoading(true);
      void fetchBtcAddressInfo(mint.bitcoinAddress!).then((info) => {
        if (cancelled) return;
        setBtc(info);
        setBtcLoading(false);
      });
    });
    return () => {
      cancelled = true;
    };
  }, [mint.bitcoinAddress]);

  const confirmations =
    btc?.blockHeight && btc?.tipHeight
      ? Math.max(0, btc.tipHeight - btc.blockHeight + 1)
      : 0;
  const btcSeen = !!btc?.txid;
  const confirmedEnough = confirmations >= CONFIRMATIONS_REQUIRED;
  const delivered = mint.status === "minted";

  const title = delivered
    ? "CBTC received"
    : btcSeen
      ? confirmedEnough
        ? "Waiting for delivery to your wallet"
        : `Confirming on Bitcoin (${confirmations}/${CONFIRMATIONS_REQUIRED})`
      : "Awaiting Bitcoin deposit";

  const tone = delivered ? "success" : btcSeen ? "info" : "neutral";

  return (
    <Card>
      <CardContent className="space-y-6 py-6">
        {/* Header. */}
        <div className="space-y-3">
          <StatusBadge label={title} tone={tone} />
          <div className="flex items-baseline gap-2">
            <span className="text-4xl font-semibold tracking-tight tabular-nums">
              {mint.amount ? formatBtc(mint.amount) : "—"}
            </span>
            <span className="text-sm font-medium text-muted-foreground">
              CBTC
            </span>
          </div>
          {mint.bitcoinAddress && (
            <div className="text-xs text-muted-foreground">
              from{" "}
              <span className="break-all font-mono text-foreground/80">
                {mint.bitcoinAddress}
              </span>
            </div>
          )}
        </div>

        {/* Timeline (full or orphan). */}
        {mint.depositAccountContractId ? (
          <ol className="space-y-4">
            <Step
              done={!!mint.depositAccountCreatedAt}
              title="Deposit account created"
              detail="A Bitcoin deposit address was issued for you on Canton."
              time={fmtTime(mint.depositAccountCreatedAt)}
            />
            <Step
              done={btcSeen || delivered}
              active={!btcSeen && !delivered}
              title="Bitcoin received at deposit address"
              detail={
                btcLoading
                  ? "Checking the Bitcoin chain…"
                  : btcSeen
                    ? btc?.receivedBtc
                      ? `${btc.receivedBtc.toFixed(8)} BTC seen at the deposit address.`
                      : "Deposit detected."
                    : delivered
                      ? "BTC was received and bridged."
                      : "Send BTC to the deposit address above."
              }
              time={btc?.blockHeight ? `block ${btc.blockHeight}` : "—"}
            />
            <Step
              done={confirmedEnough || delivered}
              active={btcSeen && !confirmedEnough && !delivered}
              title="6 confirmations on Bitcoin"
              detail={
                delivered
                  ? "Confirmed."
                  : btcSeen
                    ? confirmedEnough
                      ? "Confirmed. The bridge can now release CBTC."
                      : `${confirmations} of ${CONFIRMATIONS_REQUIRED} confirmations. ~10 minutes each.`
                    : "Will start counting once your BTC is in a block."
              }
              time="—"
            />
            <Step
              done={delivered}
              active={confirmedEnough && !delivered}
              title="CBTC delivered to your wallet"
              detail={
                delivered
                  ? `${mint.amount ? formatBtc(mint.amount) + " " : ""}CBTC is in your wallet.`
                  : "Bridging onto Canton and into your wallet."
              }
              time={fmtTime(mint.deliveredAt)}
            />
          </ol>
        ) : (
          // Orphan: only show what we actually know.
          <ol className="space-y-4">
            <Step
              done
              title="CBTC delivered to your wallet"
              detail={`${mint.amount ? formatBtc(mint.amount) + " " : ""}CBTC was minted to your wallet.`}
              time={fmtTime(mint.deliveredAt)}
            />
          </ol>
        )}

        {!mint.depositAccountContractId && (
          <p className="rounded-xl border bg-muted/30 px-3 py-3 text-xs leading-relaxed text-muted-foreground">
            The original Bitcoin deposit happened outside our recent activity
            window, so the deposit-side timeline isn&apos;t shown. The CBTC
            mint to your wallet is the on-ledger record below.
          </p>
        )}

        {btc?.txid && (
          <IdentifierField
            label="Bitcoin deposit transaction"
            value={btc.txid}
            href={btcExplorerTxUrl(btc.txid)}
            hrefLabel="View on mempool.space"
          />
        )}

        {(() => {
          const url = btcExplorerAddressUrl(mint.bitcoinAddress);
          return url ? (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              Track the deposit address <ArrowUpRight className="h-3.5 w-3.5" />
            </a>
          ) : null;
        })()}

        <Link href="/activity" className="block">
          <Button variant="outline" className="w-full">
            Back to activity
          </Button>
        </Link>
      </CardContent>
    </Card>
  );
}

/* ─────────────────────────── shared step UI ─────────────────────────── */

function Step({
  done = false,
  active = false,
  error = false,
  title,
  detail,
  time,
}: {
  done?: boolean;
  active?: boolean;
  error?: boolean;
  title: string;
  detail: string;
  time: string;
}) {
  const indicatorClass = error
    ? "bg-amber-500 text-white"
    : done
      ? "bg-green-500 text-white"
      : active
        ? "bg-foreground text-background"
        : "bg-muted text-muted-foreground/40 border border-border";

  return (
    <li className="flex items-start gap-3">
      <span
        aria-hidden
        className={cn(
          "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full",
          indicatorClass,
        )}
      >
        {done ? (
          <Check className="h-3 w-3" strokeWidth={3} />
        ) : error ? (
          <span className="text-[11px] font-bold leading-none">!</span>
        ) : active ? (
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
        ) : null}
      </span>
      <span className="flex-1 space-y-0.5">
        <span className="flex items-baseline justify-between gap-2">
          <span
            className={cn(
              "text-sm font-medium leading-tight",
              !(done || active || error) && "text-muted-foreground/60",
            )}
          >
            {title}
          </span>
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
            {time}
          </span>
        </span>
        <span className="block text-xs leading-relaxed text-muted-foreground">
          {detail}
        </span>
      </span>
    </li>
  );
}

"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

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
  btcTxId: string | null;
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
        // Don't use placeholder for in-flight mints — the activity feed has
        // incomplete data (no block height, no confirmation count) and the
        // flash of wrong state is worse than a brief loading skeleton.
        if (row.status !== "complete") return undefined;
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
            btcTxId: row.btcTxId ?? null,
            status: "minted"
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
    <div className="mx-auto w-full max-w-container-max space-y-md pb-lg">
      <Link
        href="/activity"
        className="inline-flex w-fit items-center gap-xs text-on-secondary-container transition-colors hover:text-primary active:scale-95"
      >
        <span className="material-symbols-outlined text-[20px]">arrow_back</span>
        <span className="font-label-sm text-label-sm">Back to activity</span>
      </Link>

      {loading && <PageSkeleton />}

      {!loading && errorMsg && (
        <div className="rounded-xl border border-outline-variant bg-surface-container-lowest p-md text-center font-body-md text-body-md text-on-secondary-container">
          {errorMsg}
        </div>
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
    <div className="space-y-lg">
      <div className="space-y-sm">
        <div className="h-6 w-28 animate-pulse rounded-full bg-surface-container-high" />
        <div className="h-12 w-64 animate-pulse rounded-lg bg-surface-container-high" />
        <div className="h-4 w-48 animate-pulse rounded bg-surface-container-high" />
      </div>
      <div className="grid grid-cols-1 gap-md lg:grid-cols-12">
        <div className="rounded-xl border border-outline-variant bg-surface-container-lowest p-md lg:col-span-7">
          <div className="space-y-lg">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex gap-md">
                <div className="mt-0.5 h-6 w-6 shrink-0 animate-pulse rounded-full bg-surface-container-high" />
                <div className="flex-1 space-y-xs">
                  <div className="h-4 w-2/3 animate-pulse rounded bg-surface-container-high" />
                  <div className="h-3 w-1/2 animate-pulse rounded bg-surface-container-high" />
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="space-y-md lg:col-span-5">
          {[0, 1].map((i) => (
            <div
              key={i}
              className="rounded-xl border border-outline-variant bg-surface-container-lowest p-md"
            >
              <div className="mb-sm h-3 w-20 animate-pulse rounded bg-surface-container-high" />
              <div className="h-4 w-full animate-pulse rounded bg-surface-container-high" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ─── Shared sub-components (stitch_minimal wireframe) ─── */

type BadgeTone = "success" | "info" | "warning" | "neutral";

function StatusBadge({ label, tone }: { label: string; tone: BadgeTone }) {
  const cls: Record<BadgeTone, string> = {
    success:
      "bg-tertiary-container/10 text-tertiary border-tertiary-container/20",
    info: "bg-secondary-container/30 text-secondary border-secondary-container",
    warning:
      "bg-primary-container/20 text-primary border-primary-container/30",
    neutral:
      "bg-surface-container text-on-surface-variant border-outline-variant"
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-sm py-xs font-label-sm text-label-sm",
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
    <div className="rounded-xl border border-outline-variant bg-surface-container-lowest p-md">
      <h2 className="mb-sm font-label-sm text-label-sm uppercase tracking-widest text-on-surface-variant">
        {label}
      </h2>
      {children}
    </div>
  );
}

function ExplorerLink({
  href,
  label
}: {
  href: string;
  label: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="group mt-sm inline-flex w-fit items-center gap-xs font-label-sm text-label-sm text-primary transition-all hover:underline active:scale-95"
    >
      {label}
      <span className="material-symbols-outlined text-[14px] transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5">
        north_east
      </span>
    </a>
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
      <div className="mb-xs flex items-center justify-between gap-sm">
        <p className="flex-grow break-all rounded-lg border border-outline-variant bg-surface-container-low p-sm font-label-sm text-label-sm text-on-surface">
          {value}
        </p>
        <button
          type="button"
          onClick={copy}
          className="shrink-0 p-xs text-on-secondary-container transition-colors hover:text-primary active:scale-95"
          aria-label="Copy"
        >
          <span className="material-symbols-outlined text-[20px]">
            {copied ? "check" : "content_copy"}
          </span>
        </button>
      </div>
      {href && (
        <ExplorerLink href={href} label={hrefLabel ?? "View on mempool.space"} />
      )}
    </DetailCard>
  );
}

function DetailHeader({
  statusLabel,
  tone,
  amountDisplay,
  timestamp
}: {
  statusLabel: string;
  tone: BadgeTone;
  amountDisplay: string;
  timestamp: string | null;
}) {
  return (
    <section className="mb-lg">
      <div className="mb-sm">
        <StatusBadge label={statusLabel} tone={tone} />
      </div>
      <div className="mt-xs flex items-baseline gap-sm">
        <h1 className="font-headline-lg-mobile text-headline-lg-mobile font-bold text-on-surface md:font-headline-lg md:text-headline-lg md:font-semibold lg:text-display-lg lg:font-bold lg:tracking-tight">
          {amountDisplay}
        </h1>
        <span className="font-headline-md text-headline-md text-on-surface-variant">
          CBTC
        </span>
      </div>
      {timestamp && (
        <div className="mt-xs flex items-center gap-xs text-on-secondary-container">
          <span className="material-symbols-outlined text-[18px]">schedule</span>
          <span className="font-label-sm text-label-sm uppercase md:normal-case">
            {timestamp}
          </span>
        </div>
      )}
    </section>
  );
}

function TimelinePanel({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-outline-variant bg-surface-container-lowest p-md lg:col-span-7">
      <h2 className="mb-lg font-label-sm text-label-sm uppercase tracking-widest text-on-surface-variant">
        Timeline
      </h2>
      <div className="relative ml-xs space-y-lg">
        <div
          aria-hidden
          className="absolute bottom-2 left-3 top-2 w-0.5 bg-surface-container-high"
        />
        <ol className="relative space-y-lg">{children}</ol>
      </div>
    </div>
  );
}

/** Centered SVG check — avoids Material Symbol clipping in 24px circles. */
function TimelineCheckIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      className="h-3.5 w-3.5 shrink-0"
      aria-hidden
    >
      <path
        d="M3.5 8.25 6.5 11.25 12.5 4.75"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TimelineErrorIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      className="h-3.5 w-3.5 shrink-0"
      aria-hidden
    >
      <path
        d="M8 4.5v4M8 11.25h.01"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function Step({
  done = false,
  active = false,
  error = false,
  title,
  detail,
  time
}: {
  done?: boolean;
  active?: boolean;
  error?: boolean;
  title: string;
  detail: string;
  time?: string;
}) {
  const dotClass = cn(
    "relative z-10 flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full",
    error && "bg-primary-container text-on-primary",
    done && "bg-tertiary text-on-tertiary",
    active && !done && !error && "bg-tertiary text-on-tertiary active-dot",
    !done &&
      !active &&
      !error &&
      "border-2 border-surface-container-high bg-surface-container-lowest"
  );

  return (
    <li className="relative flex items-start gap-md">
      <div className={dotClass}>
        {done ? (
          <TimelineCheckIcon />
        ) : error ? (
          <TimelineErrorIcon />
        ) : active ? (
          <span className="h-2 w-2 animate-pulse-slow rounded-full bg-on-tertiary" />
        ) : null}
      </div>
      <div className="flex flex-1 items-start justify-between gap-md">
        <div>
          <h3
            className={cn(
              "font-semibold text-on-surface text-body-lg",
              !done && !active && !error && "text-on-surface-variant/60"
            )}
          >
            {title}
          </h3>
          <p className="font-body-md text-body-md text-on-secondary-container">
            {detail}
          </p>
        </div>
        {time ? (
          <span className="shrink-0 pt-1 font-label-sm text-label-sm text-on-surface-variant tabular-nums">
            {time}
          </span>
        ) : null}
      </div>
    </li>
  );
}

// Commented out per request — support cards (Bridge delay / Need help?) are
// disabled in both the redeem and mint detail views, so this is unused for now.
// function SupportCard({ children }: { children: React.ReactNode }) {
//   return (
//     <div className="rounded-xl border border-secondary-container bg-secondary-container/20 p-md">
//       <div className="flex gap-sm">
//         <span className="material-symbols-outlined text-secondary">info</span>
//         <div className="font-body-md text-body-md text-on-secondary-container">
//           {children}
//         </div>
//       </div>
//     </div>
//   );
// }

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

  return (
    <div>
      <DetailHeader
        statusLabel={statusLabel}
        tone={tone}
        amountDisplay={formatBtc(redeem.amount)}
        timestamp={redeem.createdAt ? fmtFull(redeem.createdAt) : null}
      />

      <div className="grid grid-cols-1 gap-md lg:grid-cols-12 lg:gap-md">
        <TimelinePanel>
          <Step
            done
            title={`Burned ${formatBtc(redeem.amount)} CBTC`}
            detail="Destroyed on Canton ledger."
            time={fmtShort(redeem.createdAt)}
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
            time={fmtShort(redeem.requestSeenAt) || undefined}
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
            time={fmtShort(redeem.btcConfirmedAt) || undefined}
          />
        </TimelinePanel>

        <div className="flex flex-col gap-md lg:col-span-5">
          {redeem.createdAt && (
            <DetailCard label="Initiated">
              <p className="font-body-lg font-semibold text-on-surface">
                {fmtFull(redeem.createdAt)}
              </p>
            </DetailCard>
          )}
          {redeem.destinationBtcAddress && (
            <DetailCard label="Destination address">
              <p className="mb-sm break-all rounded-lg border border-outline-variant bg-surface-container-low p-sm font-label-sm text-label-sm text-on-surface">
                {redeem.destinationBtcAddress}
              </p>
              {(() => {
                const url = explorerAddrUrl(redeem.destinationBtcAddress);
                return url ? (
                  <ExplorerLink href={url} label="Track on mempool.space" />
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
          {/* Commented out per request — "Bridge delay" support card.
          {redeem.status === "stalled" && (
            <SupportCard>
              <p className="font-semibold text-secondary">Bridge delay</p>
              <p className="mt-xs font-label-sm text-label-sm">
                Your CBTC is burned and recorded on Canton. Contact{" "}
                <a
                  href="mailto:support@bitsafe.finance"
                  className="font-semibold text-primary underline"
                >
                  support@bitsafe.finance
                </a>{" "}
                if it doesn&apos;t resolve.
              </p>
            </SupportCard>
          )}
          */}
        </div>
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

async function fetchBtcInfo(address: string, btcTxId?: string | null): Promise<BtcInfo | null> {
  const base =
    NETWORK.name === "mainnet"
      ? "https://mempool.space/api"
      : NETWORK.name === "testnet"
        ? "https://mempool.space/testnet/api"
        : null;
  if (!base) return null;
  try {
    const [addrRes, tipRes] = await Promise.all([
      fetch(`${base}/address/${encodeURIComponent(address)}`),
      fetch(`${base}/blocks/tip/height`),
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

    if (btcTxId) {
      // We know the specific tx — look it up directly for accurate block height.
      const txRes = await fetch(`${base}/tx/${encodeURIComponent(btcTxId)}`);
      if (txRes.ok) {
        const tx = (await txRes.json()) as {
          txid: string;
          status?: { block_height?: number };
        };
        txid = tx.txid;
        blockHeight = tx.status?.block_height ?? null;
      }
    } else {
      // No specific txid — fall back to the most recent tx on the address.
      const txsRes = await fetch(`${base}/address/${encodeURIComponent(address)}/txs`);
      if (txsRes.ok) {
        const txs = (await txsRes.json()) as Array<{
          txid: string;
          status?: { block_height?: number };
        }>;
        const newest = txs[0];
        if (newest) {
          txid = newest.txid;
          blockHeight = newest.status?.block_height ?? null;
        }
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
      void fetchBtcInfo(mint.bitcoinAddress!, mint.btcTxId).then((info) => {
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
    <div>
      <DetailHeader
        statusLabel={statusLabel}
        tone={tone}
        amountDisplay={mint.amount ? formatBtc(mint.amount) : "—"}
        timestamp={timestamp ? fmtFull(timestamp) : null}
      />

      <div className="grid grid-cols-1 gap-md lg:grid-cols-12">
        <TimelinePanel>
          {isOrphan ? (
            <>
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
              />
              <Step
                done
                title={`${CONFS_REQUIRED} Bitcoin confirmations`}
                detail="Confirmed on the Bitcoin network."
              />
              <Step
                done
                active={delivered}
                title="CBTC delivered to your wallet"
                detail={`${mint.amount ? formatBtc(mint.amount) + " " : ""}CBTC minted to your wallet.`}
                time={fmtShort(mint.deliveredAt) || undefined}
              />
            </>
          ) : (
            <>
              <Step
                done={!!mint.depositAccountCreatedAt}
                title="Deposit account created"
                detail="A Bitcoin deposit address was issued for you on Canton."
                time={fmtShort(mint.depositAccountCreatedAt) || undefined}
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
              />
              <Step
                done={confirmed || delivered}
                active={btcSeen && !confirmed && !delivered}
                title={`${CONFS_REQUIRED} Bitcoin confirmations`}
                detail={
                  delivered
                    ? "Confirmed on the Bitcoin network."
                    : btcSeen
                      ? confirmed
                        ? "Confirmed. Bridge releasing CBTC."
                        : `${confs} of ${CONFS_REQUIRED} — ~10 min each.`
                      : "Starts once your BTC is in a block."
                }
              />
              <Step
                done={delivered}
                active={confirmed && !delivered}
                title="CBTC delivered to your wallet"
                detail={
                  delivered
                    ? `${mint.amount ? formatBtc(mint.amount) + " " : ""}CBTC minted to your wallet.`
                    : "Bridging onto Canton…"
                }
                time={fmtShort(mint.deliveredAt) || undefined}
              />
            </>
          )}
        </TimelinePanel>

        {hasDetails && (
          <div className="flex flex-col gap-md lg:col-span-5">
            {mint.deliveredAt && (
              <DetailCard label="Delivered at">
                <p className="font-body-lg font-semibold text-on-surface">
                  {fmtFull(mint.deliveredAt)}
                </p>
              </DetailCard>
            )}
            {mint.bitcoinAddress && (
              <DetailCard label="Bitcoin deposit address">
                <p className="mb-sm break-all rounded-lg bg-surface-container-low p-sm font-label-sm text-label-sm text-on-surface">
                  {mint.bitcoinAddress}
                </p>
                {(() => {
                  const url = explorerAddrUrl(mint.bitcoinAddress);
                  return url ? (
                    <ExplorerLink href={url} label="Track on mempool.space" />
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
            {/* Commented out per request — "Need help?" support card.
            <SupportCard>
              <p className="font-semibold text-secondary">Need help?</p>
              <p className="mt-xs font-label-sm text-label-sm">
                If you have any issues with this transaction, contact our
                support team with your transaction ID.
              </p>
            </SupportCard>
            */}
          </div>
        )}
      </div>
    </div>
  );
}

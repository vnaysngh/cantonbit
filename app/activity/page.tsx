"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { useTransfers } from "@/hooks/useTransfers";
import { formatBtc } from "@/lib/format";
import type { ActivityKind, ActivityRow, ActivityStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

type Filter = "all" | ActivityKind;

// Only mint/redeem tabs surface — Send/Received history is out of scope.
// ActivityKind still includes 'sent' and 'received' so a future feed can
// store them; they just don't have a tab to filter on.
const TABS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "minted", label: "Minted" },
  { id: "redeemed", label: "Redeemed" },
];

const PAGE_SIZE = 20;

// Per-kind icon treatment — minted = green (inbound), redeemed = red (outbound).
const KIND_META = {
  minted: {
    icon: "add_circle",
    label: "Minted",
    iconBg: "bg-tertiary-container/30",
    iconFg: "text-tertiary",
  },
  redeemed: {
    icon: "remove_circle",
    label: "Redeemed",
    iconBg: "bg-error-container/40",
    iconFg: "text-error",
  },
  sent: {
    icon: "arrow_outward",
    label: "Sent",
    iconBg: "bg-error-container/40",
    iconFg: "text-error",
  },
  received: {
    icon: "south_west",
    label: "Received",
    iconBg: "bg-tertiary-container/30",
    iconFg: "text-tertiary",
  },
} as const;

/** Status pill visual mapping → the three wireframe states (+ in-between). */
function statusPill(status: ActivityStatus, kind: ActivityKind) {
  switch (status) {
    case "complete":
      return {
        label: "Completed",
        icon: "check_circle",
        className: "bg-tertiary-container/20 text-tertiary",
        pulse: false,
      };
    case "failed":
      return {
        label: "Failed",
        icon: "cancel",
        className: "bg-error-container/50 text-on-error-container",
        pulse: false,
      };
    case "broadcasting":
      return {
        label: kind === "minted" ? "BTC Detected" : "Broadcasting",
        icon: "sync",
        className: "bg-secondary-container text-secondary",
        pulse: true,
      };
    case "stalled":
      return {
        label: "Delayed",
        icon: "schedule",
        className: "bg-primary-container/20 text-primary",
        pulse: true,
      };
    default:
      return {
        label: "Pending",
        icon: "",
        className: "bg-secondary-container text-secondary",
        pulse: true,
      };
  }
}

/** MM/DD/YY HH:MM:SS (zero-padded, 24-hour) — e.g. "06/01/26 13:30:06". */
function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  const date = `${p(d.getMonth() + 1)}/${p(d.getDate())}/${p(d.getFullYear() % 100)}`;
  const time = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  return `${date} ${time}`;
}

export default function ActivityPage() {
  const { activity, isLoading } = useTransfers();
  const [filter, setFilter] = useState<Filter>("all");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // Reset pagination whenever the filter changes. Done in the event handler
  // (not an effect) so we never trigger a cascading render.
  const changeFilter = (next: Filter) => {
    setFilter(next);
    setVisibleCount(PAGE_SIZE);
  };

  const filtered = useMemo(() => {
    return filter === "all"
      ? activity
      : activity.filter((row) => row.kind === filter);
  }, [activity, filter]);

  const visible = filtered.slice(0, visibleCount);
  const hasMore = filtered.length > visibleCount;

  return (
    <div className="space-y-md py-md">
      {/* Header */}
      <header className="space-y-2">
        <h1 className="text-headline-lg text-on-background">Transaction History</h1>
        <p className="text-body-md text-on-surface-variant">
          Review your recent minting and redemption activity across the Oranj
          network.
        </p>
      </header>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex flex-wrap gap-2">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => changeFilter(tab.id)}
              className={cn(
                "rounded-full px-4 py-1.5 text-label-sm transition-colors",
                filter === tab.id
                  ? "bg-primary text-on-primary"
                  : "bg-surface-container text-on-surface-variant hover:bg-surface-container-high",
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="h-64 animate-pulse rounded-2xl border border-outline/10 bg-surface-container" />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-outline/10 bg-surface-container-lowest shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left">
              <thead>
                <tr className="border-b border-outline/10 bg-surface-container-low/60">
                  {["Type", "Amount", "Timestamp", "Status"].map(
                    (h) => (
                      <th
                        key={h}
                        className="px-6 py-4 font-mono text-label-sm uppercase tracking-wide text-on-surface-variant last:text-right"
                      >
                        {h}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {visible.length === 0 ? (
                  <tr>
                    <td
                      colSpan={4}
                      className="px-6 py-12 text-center text-body-md text-on-surface-variant"
                    >
                      {filter === "all"
                        ? "No activity yet."
                        : "No matching transactions."}
                    </td>
                  </tr>
                ) : (
                  visible.map((row, idx) => (
                    <ActivityRowItem
                      key={`${row.kind}-${row.id}-${idx}`}
                      row={row}
                    />
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination footer */}
          <div className="flex items-center justify-between gap-4 border-t border-outline/10 px-6 py-4">
            <span className="text-label-sm text-on-surface-variant">
              Showing {visible.length} of {filtered.length} entries
            </span>
            {hasMore && (
              <button
                onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-surface-container px-4 py-1.5 text-label-sm text-on-surface transition-colors hover:bg-surface-container-high"
              >
                Load more
                <span className="material-symbols-outlined text-[18px]">
                  expand_more
                </span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ActivityRowItem({ row }: { row: ActivityRow }) {
  const router = useRouter();
  const meta = KIND_META[row.kind];
  const pill = statusPill(row.status, row.kind);
  const href = row.redeemId
    ? `/activity/${row.redeemId}`
    : row.mintId
      ? `/activity/${row.mintId}`
      : null;

  return (
    <tr
      onClick={href ? () => router.push(href) : undefined}
      className={cn(
        "border-b border-outline/5 transition-colors last:border-0 hover:bg-surface-container/40",
        href && "cursor-pointer",
      )}
    >
      {/* Type */}
      <td className="px-6 py-4">
        <div className="flex items-center gap-3">
          <span
            className={cn(
              "flex h-10 w-10 items-center justify-center rounded-lg",
              meta.iconBg,
              meta.iconFg,
            )}
          >
            <span className="material-symbols-outlined text-[20px]">
              {meta.icon}
            </span>
          </span>
          <span className="text-body-md font-medium text-on-surface">
            {meta.label}
          </span>
        </div>
      </td>
      {/* Amount — Plus Jakarta Sans, same size/weight as every other data
          cell. No leading minus sign. tabular-nums keeps digits aligned. */}
      <td className="px-6 py-4">
        <span className="block text-body-md font-medium tabular-nums text-on-surface">
          {formatBtc(row.amount)} CBTC
        </span>
      </td>
      {/* Timestamp — MM/DD/YY HH:MM:SS, monospace + tabular for column-aligned digits */}
      <td className="px-6 py-4">
        <span className="font-mono text-body-md font-medium tabular-nums text-on-surface">
          {formatTimestamp(row.timestamp)}
        </span>
      </td>
      {/* Status */}
      <td className="px-6 py-4 text-right">
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-medium",
            pill.className,
          )}
        >
          {pill.pulse ? (
            <span className="h-1.5 w-1.5 animate-pulse-slow rounded-full bg-current" />
          ) : pill.icon ? (
            <span className="material-symbols-outlined text-[16px]">
              {pill.icon}
            </span>
          ) : null}
          {pill.label}
        </span>
      </td>
    </tr>
  );
}

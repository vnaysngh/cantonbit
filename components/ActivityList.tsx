"use client";

import { ArrowDownLeft, ArrowUpRight, Coins, Flame } from "lucide-react";
import Link from "next/link";

import { BalanceBadge } from "./BalanceBadge";
import { PartyIdDisplay } from "./PartyIdDisplay";
import { timeAgo } from "@/lib/format";
import type { ActivityRow, ActivityStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

const ICONS = {
  sent: ArrowUpRight,
  received: ArrowDownLeft,
  minted: Coins,
  redeemed: Flame,
} as const;

const KIND_LABEL = {
  sent: "Sent",
  received: "Received",
  minted: "Minted",
  redeemed: "Redeemed",
} as const;

/** Short status chip text + colour. `complete` shows nothing (the default). */
const STATUS_META: Record<
  ActivityStatus,
  { label: string; className: string } | null
> = {
  complete: null,
  pending: {
    label: "Pending",
    className:
      "bg-muted text-muted-foreground",
  },
  broadcasting: {
    label: "Broadcasting",
    className:
      "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  },
  stalled: {
    label: "Delayed",
    className:
      "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  },
  failed: {
    label: "Failed",
    className:
      "bg-destructive/15 text-destructive",
  },
};

interface Props {
  rows: ActivityRow[];
  emptyLabel?: string;
}

export function ActivityList({
  rows,
  emptyLabel = "No activity yet.",
}: Props) {
  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
        {emptyLabel}
      </div>
    );
  }

  return (
    <ul className="divide-y rounded-md border">
      {rows.map((row, idx) => {
        const Icon = ICONS[row.kind];
        const isInbound = row.kind === "received" || row.kind === "minted";
        const statusMeta = STATUS_META[row.status];
        // Redeems and mints both have a detail page; clicking the row opens
        // the full breakdown.
        const href = row.redeemId
          ? `/activity/${row.redeemId}`
          : row.mintId
            ? `/activity/${row.mintId}`
            : null;

        const inner = (
          <>
            <div className="flex min-w-0 items-center gap-3">
              <div
                className={cn(
                  "flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
                  isInbound
                    ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                    : "bg-muted text-muted-foreground",
                )}
              >
                <Icon className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">
                    {KIND_LABEL[row.kind]}
                  </span>
                  {statusMeta && (
                    <span
                      className={cn(
                        "rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                        statusMeta.className,
                      )}
                    >
                      {statusMeta.label}
                    </span>
                  )}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {row.kind === "redeemed" || row.kind === "minted" ? (
                    <span className="font-mono">{row.counterparty}</span>
                  ) : (
                    <PartyIdDisplay
                      partyId={row.counterparty}
                      showCopy={false}
                    />
                  )}
                </div>
              </div>
            </div>
            <div className="flex flex-col items-end gap-0.5">
              <BalanceBadge
                amount={isInbound ? row.amount : `-${row.amount}`}
                size="sm"
              />
              <span className="text-[10px] text-muted-foreground">
                {timeAgo(row.timestamp)}
              </span>
            </div>
          </>
        );

        return (
          // Composite key: row.id can repeat across kinds (a burn tx also
          // archives a holding); kind+id+idx is always unique.
          <li key={`${row.kind}-${row.id}-${idx}`}>
            {href ? (
              <Link
                href={href}
                className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-muted/50"
              >
                {inner}
              </Link>
            ) : (
              <div className="flex items-center justify-between gap-3 px-4 py-3">
                {inner}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

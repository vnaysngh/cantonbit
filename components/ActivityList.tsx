"use client";

import { ArrowDownLeft, ArrowUpRight, Coins, Flame } from "lucide-react";

import { BalanceBadge } from "./BalanceBadge";
import { PartyIdDisplay } from "./PartyIdDisplay";
import { timeAgo } from "@/lib/format";
import type { ActivityRow } from "@/lib/types";
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
      {rows.map((row) => {
        const Icon = ICONS[row.kind];
        const isInbound = row.kind === "received" || row.kind === "minted";
        return (
          <li
            key={row.id}
            className="flex items-center justify-between gap-3 px-4 py-3"
          >
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
                <div className="text-sm font-medium">{KIND_LABEL[row.kind]}</div>
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
          </li>
        );
      })}
    </ul>
  );
}

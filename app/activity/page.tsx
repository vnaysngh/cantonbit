"use client";

import { useMemo, useState } from "react";

import { ActivityList } from "@/components/ActivityList";
import { useTransfers } from "@/hooks/useTransfers";
import { cn } from "@/lib/utils";
import type { ActivityKind } from "@/lib/types";

type Filter = "all" | ActivityKind;

// Only mint/redeem tabs surface — Send/Received history is out of scope.
// ActivityKind still includes 'sent' and 'received' so a future feed can
// store them; they just don't have a tab to filter on.
const TABS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "minted", label: "Minted" },
  { id: "redeemed", label: "Redeemed" },
];

export default function ActivityPage() {
  const { activity, isLoading } = useTransfers();
  const [filter, setFilter] = useState<Filter>("all");

  const filtered = useMemo(() => {
    if (filter === "all") return activity;
    return activity.filter((row) => row.kind === filter);
  }, [activity, filter]);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Activity</h1>

      <div className="flex flex-wrap gap-1 rounded-md bg-muted p-1">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setFilter(tab.id)}
            className={cn(
              "rounded px-3 py-1.5 text-sm transition-colors",
              filter === tab.id
                ? "bg-background shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="h-48 animate-pulse rounded-md border bg-muted/30" />
      ) : (
        <ActivityList
          rows={filtered}
          emptyLabel={
            filter === "all"
              ? "No activity yet."
              : `No ${filter} transactions yet.`
          }
        />
      )}
    </div>
  );
}

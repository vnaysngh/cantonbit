"use client";

import { useEffect, useMemo, useState } from "react";

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

const PAGE_SIZE = 20;

export default function ActivityPage() {
  const { activity, isLoading } = useTransfers();
  const [filter, setFilter] = useState<Filter>("all");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // Reset pagination whenever the filter or the underlying data changes.
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [filter]);

  const filtered = useMemo(() => {
    if (filter === "all") return activity;
    return activity.filter((row) => row.kind === filter);
  }, [activity, filter]);

  const visible = filtered.slice(0, visibleCount);
  const hasMore = filtered.length > visibleCount;

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
          rows={visible}
          emptyLabel={
            filter === "all"
              ? "No activity yet."
              : `No ${filter} transactions yet.`
          }
          hasMore={hasMore}
          onLoadMore={() => setVisibleCount((c) => c + PAGE_SIZE)}
        />
      )}
    </div>
  );
}

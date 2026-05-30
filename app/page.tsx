"use client";

import Link from "next/link";
import { Flame, Pickaxe } from "lucide-react";

import { ActivityList } from "@/components/ActivityList";
import { BalanceBadge } from "@/components/BalanceBadge";
import { UTXOWarning } from "@/components/UTXOWarning";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useBalance } from "@/hooks/useBalance";
import { useTransfers } from "@/hooks/useTransfers";

const QUICK_ACTIONS = [
  { href: "/mint", label: "Mint", Icon: Pickaxe },
  { href: "/redeem", label: "Redeem", Icon: Flame },
] as const;

export default function DashboardPage() {
  const {
    total,
    utxoCount,
    isLoading: balanceLoading,
    error: balanceError,
  } = useBalance();
  const { activity, isLoading: activityLoading } = useTransfers();

  return (
    <div className="space-y-6">
      <UTXOWarning count={utxoCount} />

      {balanceError && (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          Couldn&apos;t load balance: {balanceError}
        </div>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Total balance
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {balanceLoading ? (
            <div className="h-12 w-48 animate-pulse rounded bg-muted" />
          ) : (
            <BalanceBadge amount={total} size="xl" />
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-3">
        {QUICK_ACTIONS.map(({ href, label, Icon }) => (
          <Link
            key={href}
            href={href}
            className="group flex flex-col items-center justify-center gap-2 rounded-lg border bg-card p-4 transition-colors hover:bg-accent"
          >
            <Icon className="h-5 w-5 text-muted-foreground group-hover:text-foreground" />
            <span className="text-sm font-medium">{label}</span>
          </Link>
        ))}
      </div>

      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Recent activity
          </h2>
          <Link
            href="/activity"
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            View all →
          </Link>
        </div>
        {activityLoading ? (
          <div className="h-32 animate-pulse rounded-md border bg-muted/30" />
        ) : (
          <ActivityList rows={activity.slice(0, 5)} />
        )}
      </section>
    </div>
  );
}

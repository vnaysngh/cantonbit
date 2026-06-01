"use client";

import Link from "next/link";

import { UTXOWarning } from "@/components/UTXOWarning";
import { useBalance } from "@/hooks/useBalance";
import { useTransfers } from "@/hooks/useTransfers";
import { formatBtc, timeAgo } from "@/lib/format";
import type { ActivityRow } from "@/lib/types";
import { cn } from "@/lib/utils";

const ACTION_CARDS = [
  {
    href: "/mint",
    title: "Mint CBTC",
    body: "Convert native Bitcoin into institutional-grade wrapped assets for the DeFi ecosystem.",
    cta: "Get Started"
  },
  {
    href: "/redeem",
    title: "Redeem Assets",
    body: "Exit the network and withdraw your original assets back to your cold storage wallet.",
    cta: "Withdraw Funds"
  }
] as const;

export default function DashboardPage() {
  const {
    total,
    utxoCount,
    isLoading: balanceLoading,
    error: balanceError
  } = useBalance();
  const { activity, isLoading: activityLoading } = useTransfers();

  return (
    <div className="space-y-md pb-md pt-md">
      <UTXOWarning count={utxoCount} />

      {balanceError && (
        <div
          role="alert"
          className="rounded-xl border border-error/30 bg-error-container/40 px-4 py-3 text-body-md text-on-error-container"
        >
          Couldn&apos;t load balance: {balanceError}
        </div>
      )}

      {/* Header */}
      <header className="space-y-2">
        <h1 className="text-display-lg text-on-background">Overview</h1>
      </header>

      {/* Bento grid */}
      <div className="grid grid-cols-1 gap-md lg:grid-cols-3">
        {/* Hero balance card */}
        <section className="rounded-2xl border border-outline/10 bg-surface-container-lowest p-8 shadow-sm">
          <span className="font-mono text-label-sm uppercase tracking-widest text-on-surface-variant">
            Total Portfolio Balance
          </span>
          <div className="mt-3 flex items-baseline gap-3">
            {balanceLoading ? (
              <div className="h-12 w-48 animate-pulse rounded-lg bg-surface-container" />
            ) : (
              <>
                <span className="font-mono text-display-lg tabular-nums text-on-background">
                  {formatBtc(total)}
                </span>
                <span className="text-headline-md text-primary-container">
                  CBTC
                </span>
              </>
            )}
          </div>
        </section>

        {/* Action cards */}
        {ACTION_CARDS.map((card) => (
          <Link
            key={card.href}
            href={card.href}
            className="group rounded-2xl border border-outline/10 bg-surface-container-lowest p-8 shadow-sm transition-all hover:border-primary/30"
          >
            <h2 className="text-headline-md text-on-background">
              {card.title}
            </h2>
            <p className="mt-2 text-body-md text-on-surface-variant">
              {card.body}
            </p>
            <span className="mt-5 inline-flex items-center gap-1.5 text-body-md font-medium text-primary transition-transform group-hover:gap-2.5">
              {card.cta}
              <span className="material-symbols-outlined text-[20px]">
                arrow_forward
              </span>
            </span>
          </Link>
        ))}

        {/* Recent activity */}
        <section className="rounded-2xl border border-outline/10 bg-surface-container-lowest p-8 shadow-sm lg:col-span-3">
          <div className="mb-md flex items-baseline justify-between">
            <h2 className="text-headline-md text-on-background">
              Recent Activity
            </h2>
            <Link
              href="/activity"
              className="text-body-md text-primary hover:opacity-80"
            >
              View All
            </Link>
          </div>
          {activityLoading ? (
            <div className="h-40 animate-pulse rounded-xl bg-surface-container" />
          ) : activity.length === 0 ? (
            <p className="rounded-xl border border-dashed border-outline/20 p-8 text-center text-body-md text-on-surface-variant">
              No activity yet.
            </p>
          ) : (
            <ul className="divide-y divide-outline/10">
              {activity.slice(0, 5).map((row, idx) => (
                <RecentRow key={`${row.kind}-${row.id}-${idx}`} row={row} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

const KIND_META = {
  minted: {
    icon: "add_circle",
    label: "Minting Confirmed",
    inbound: true,
    iconBg: "bg-tertiary-container/30",
    iconFg: "text-tertiary"
  },
  redeemed: {
    icon: "remove_circle",
    label: "Redemption",
    inbound: false,
    iconBg: "bg-error-container/40",
    iconFg: "text-error"
  },
  sent: {
    icon: "arrow_outward",
    label: "Sent",
    inbound: false,
    iconBg: "bg-error-container/40",
    iconFg: "text-error"
  },
  received: {
    icon: "south_west",
    label: "Received",
    inbound: true,
    iconBg: "bg-tertiary-container/30",
    iconFg: "text-tertiary"
  }
} as const;

function RecentRow({ row }: { row: ActivityRow }) {
  const meta = KIND_META[row.kind];
  const href = row.redeemId
    ? `/activity/${row.redeemId}`
    : row.mintId
      ? `/activity/${row.mintId}`
      : null;

  const inner = (
    <>
      <div className="flex min-w-0 items-center gap-3">
        <span
          className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-full",
            meta.iconBg,
            meta.iconFg
          )}
        >
          <span className="material-symbols-outlined text-[20px]">
            {meta.icon}
          </span>
        </span>
        <div className="min-w-0">
          <p className="text-body-md font-medium text-on-surface">
            {meta.label}
          </p>
          <p className="truncate font-mono text-label-sm text-on-surface-variant">
            {row.counterparty}
          </p>
        </div>
      </div>
      <div className="flex flex-col items-end">
        <span className="font-mono text-body-md tabular-nums text-on-surface">
          {meta.inbound ? "+" : "-"}
          {formatBtc(row.amount)} CBTC
        </span>
        <span className="text-label-sm text-on-surface-variant">
          {timeAgo(row.timestamp)}
        </span>
      </div>
    </>
  );

  return (
    <li>
      {href ? (
        <Link
          href={href}
          className="flex items-center justify-between gap-3 py-4 transition-colors hover:bg-surface-container/40"
        >
          {inner}
        </Link>
      ) : (
        <div className="flex items-center justify-between gap-3 py-4">
          {inner}
        </div>
      )}
    </li>
  );
}

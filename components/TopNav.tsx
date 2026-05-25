"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { NETWORK } from "@/lib/constants";
import { truncatePartyId } from "@/lib/format";
import { cn } from "@/lib/utils";

// cantonbit is a mint/redeem app, not a wallet — Send/Receive screens
// live in the repo (app/send, app/receive) but are hidden from nav.
// Re-add the two entries below to bring them back.
const NAV = [
  { href: "/", label: "Dashboard" },
  { href: "/mint", label: "Mint" },
  { href: "/redeem", label: "Redeem" },
  { href: "/activity", label: "Activity" },
] as const;

export function TopNav() {
  const pathname = usePathname();

  return (
    <header className="border-b">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3">
        <div className="flex items-center gap-6">
          <Link href="/" className="flex items-baseline gap-2">
            <span className="font-heading text-2xl font-medium tracking-tight">
              cantonbit
            </span>
            <span className="rounded-md bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              {NETWORK.name}
            </span>
          </Link>
          <nav className="hidden items-center gap-1 sm:flex">
            {NAV.map((item) => {
              const active =
                item.href === "/"
                  ? pathname === "/"
                  : pathname?.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-sm transition-colors",
                    active
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>
        {/* Show the WarpX party identity — no connect/disconnect needed */}
        <span
          className="rounded-md bg-muted px-2 py-1 font-mono text-xs"
          title={NETWORK.warpxPartyId}
        >
          {truncatePartyId(NETWORK.warpxPartyId)}
        </span>
      </div>
    </header>
  );
}

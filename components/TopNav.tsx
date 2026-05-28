"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

import { useState } from "react";

// Kept for easy re-enable — uncomment the <OranjLogo /> usage below.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { OranjLogo } from "@/components/OranjLogo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useWallet } from "@/hooks/useWallet";
import { NETWORK } from "@/lib/constants";
import { truncatePartyId } from "@/lib/format";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Dashboard" },
  { href: "/mint", label: "Mint" },
  { href: "/send", label: "Send" },
  { href: "/receive", label: "Receive" },
  { href: "/redeem", label: "Redeem" },
] as const;

export function TopNav() {
  const pathname = usePathname();
  const router = useRouter();
  const { partyId, isLoading } = useWallet();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!partyId) return;
    await navigator.clipboard.writeText(partyId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleLogout = async () => {
    const supabase = createSupabaseBrowserClient();
    await supabase.auth.signOut();
    router.push("/login");
  };

  return (
    <header className="border-b">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3">
        <div className="flex items-center gap-6">
          {/*
            Wordmark only for now. Logo is commented out — re-enable
            by uncommenting the <OranjLogo /> line below.
          */}
          <Link
            href="/"
            aria-label="Oranj — home"
            className="flex items-center gap-2"
          >
            {/* <OranjLogo className="h-8 w-8 shrink-0" /> */}
            <span className="font-heading text-2xl font-medium tracking-tight leading-none">
              Oranj
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

        <div className="flex items-center gap-2">
          {isLoading ? (
            <span className="rounded-md bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
              Loading…
            </span>
          ) : partyId ? (
            <>
              <button
                onClick={handleCopy}
                className="rounded-md bg-muted px-2 py-1 font-mono text-xs hover:bg-accent/50 transition-colors"
                title={copied ? "Copied!" : partyId}
              >
                {copied ? "Copied!" : truncatePartyId(partyId)}
              </button>
              <ThemeToggle />
              <button
                onClick={handleLogout}
                className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors"
              >
                Sign out
              </button>
            </>
          ) : (
            <ThemeToggle />
          )}
        </div>
      </div>
    </header>
  );
}

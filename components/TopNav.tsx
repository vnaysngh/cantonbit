"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

import { useState } from "react";

import { ThemeToggle } from "@/components/ThemeToggle";
import { useBalance } from "@/hooks/useBalance";
import { useWallet } from "@/hooks/useWallet";
import { formatBtc, truncatePartyId } from "@/lib/format";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Dashboard" },
  { href: "/mint", label: "Mint" },
  // Send/Receive hidden for now — flows still in progress, mint+redeem are the primary user actions.
  // { href: "/send", label: "Send" },
  // { href: "/receive", label: "Receive" },
  { href: "/redeem", label: "Redeem" }
] as const;

export function TopNav() {
  const pathname = usePathname();
  const router = useRouter();
  const { partyId, isLoading } = useWallet();
  const { total } = useBalance();
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
          <Link
            href="/"
            aria-label="Oranj — home"
            className="flex items-center gap-2"
          >
            {/* Light theme — dark text logo */}
            <Image
              src="/logo.png"
              alt="Oranj"
              width={80}
              height={25}
              className="block dark:hidden"
              priority
            />
            {/* Dark theme — white text logo */}
            <Image
              src="/logo-white.png"
              alt="Oranj"
              width={80}
              height={25}
              className="hidden dark:block"
              priority
            />
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
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
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
              <span
                className="rounded-md bg-muted px-2 py-1 font-mono text-xs tabular-nums"
                title="Your CBTC balance"
              >
                {formatBtc(total)}{" "}
                <span className="text-muted-foreground">CBTC</span>
              </span>
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

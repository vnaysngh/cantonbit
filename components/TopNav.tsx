"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

import { useState } from "react";

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
  { href: "/redeem", label: "Redeem" },
  { href: "/swap", label: "Swap" },
  { href: "/activity", label: "Activity" }
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
    <header className="sticky top-0 z-50 border-b border-outline-variant bg-surface/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 w-full max-w-[1200px] items-center justify-between gap-4 px-container-padding">
        {/* Brand */}
        <Link href="/" aria-label="Oranj — home" className="flex items-center gap-2">
          <Image
            src="/logo.png"
            alt="Oranj"
            width={64}
            height={0}
            style={{ height: "auto" }}
            priority
          />
        </Link>

        {/* Center navigation */}
        <nav className="hidden items-center gap-8 md:flex">
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
                  "text-body-md transition-colors",
                  active
                    ? "border-b-2 border-primary pb-1 text-primary"
                    : "text-on-surface-variant hover:text-on-surface"
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        {/* Actions */}
        <div className="flex items-center gap-3">
          {isLoading ? (
            <span className="inline-flex h-9 items-center rounded-full border border-outline-variant bg-surface-container px-3 text-label-sm text-on-surface">
              Loading…
            </span>
          ) : partyId ? (
            <>
              {/* Balance pill = outlined chip per the dashboard_web_v3 reference:
                  white fill (surface-container-lowest) + thin outline-variant
                  border + dark on-surface text. NOT the filled-blue variant.
                  Shares h-9 + inline-flex items-center with the party button so
                  both elements are exactly the same height and aligned. */}
              <span
                className="hidden h-9 items-center rounded-full border border-outline-variant bg-surface-container px-3 text-label-sm text-on-surface md:inline-flex"
                title="Your CBTC balance"
              >
                {formatBtc(total)} CBTC
              </span>
              <button
                onClick={handleCopy}
                className="inline-flex h-9 items-center rounded-lg bg-primary px-4 text-body-md text-on-primary transition-all hover:opacity-90 active:scale-95"
                title={copied ? "Copied!" : partyId}
              >
                {copied ? "Copied!" : truncatePartyId(partyId)}
              </button>
              <button
                onClick={handleLogout}
                title="Sign out"
                aria-label="Sign out"
                className="rounded-full p-2 text-on-surface-variant transition-all hover:bg-surface-container-high hover:text-on-surface"
              >
                <span className="material-symbols-outlined text-[20px]">logout</span>
              </button>
            </>
          ) : null}
        </div>
      </div>
    </header>
  );
}

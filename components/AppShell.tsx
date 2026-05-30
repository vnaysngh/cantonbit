"use client";

import { usePathname } from "next/navigation";
import { TopNav } from "@/components/TopNav";

/**
 * Renders the TopNav + main content wrapper for authenticated pages.
 * Suppressed entirely on /login so that page gets a clean full-screen layout.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isLogin = pathname === "/login";

  if (isLogin) {
    return <>{children}</>;
  }

  return (
    <>
      <TopNav />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
        {children}
      </main>
    </>
  );
}

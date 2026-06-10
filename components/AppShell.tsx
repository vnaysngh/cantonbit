"use client";

import { TopNav } from "@/components/TopNav";

/**
 * Renders the TopNav + main content wrapper around every page.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <>
      {/* Atmospheric gradient — two large blurred color blobs (orange top-right,
          blue bottom-left) sitting behind all content at low opacity. Fixed +
          pointer-events-none so it never interferes with scrolling or clicks.
          Lives in AppShell so it spans every authenticated page. */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 -z-10 overflow-hidden opacity-20"
      >
        <div className="absolute -right-[10%] -top-[10%] h-[50%] w-[50%] rounded-full bg-primary-container blur-[120px]" />
        <div className="absolute -bottom-[10%] -left-[10%] h-[40%] w-[40%] rounded-full bg-secondary-container blur-[100px]" />
      </div>

      <TopNav />
      <main className="mx-auto w-full max-w-[1200px] flex-1 px-container-padding pb-lg pt-md">
        {children}
      </main>
    </>
  );
}

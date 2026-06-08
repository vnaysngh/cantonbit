import type { Metadata } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";

import { WalletProvider } from "@/hooks/useWallet";
import { LoopWalletProvider } from "@/hooks/useLoopWallet";
import { EvmWalletProvider } from "@/hooks/useEvmWallet";
import { AppShell } from "@/components/AppShell";
import { QueryProvider } from "@/components/QueryProvider";
import { ThemeProvider } from "@/components/ThemeProvider";

// Single typeface across the entire app: Plus Jakarta Sans drives display,
// body, AND the (formerly monospace) data tokens. next/font self-hosts it and
// exposes --font-jakarta, which globals.css maps to --font-sans and --font-mono.
const jakarta = Plus_Jakarta_Sans({
  variable: "--font-jakarta",
  subsets: ["latin"],
  // 800 (extrabold) is for the wordmark — the logo uses the SAME typeface as the
  // app, just heavier + tighter, so it reads as a mark without clashing.
  weight: ["400", "500", "600", "700", "800"],
  display: "swap"
});

export const metadata: Metadata = {
  title: "OranjSwap",
  description: "Swap WBTC to CBTC across Arbitrum and Canton Network."
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      // suppressHydrationWarning needed because next-themes injects the
      // resolved theme class on <html> before React hydrates.
      suppressHydrationWarning
      className={`${jakarta.variable} h-full antialiased`}
    >
      <head>
        {/* Material Symbols (Outlined) — nav + status iconography. This is a
            root-layout <head>, so it loads for every page; the page-custom-font
            lint rule (aimed at per-page fonts) doesn't apply here. */}
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-full flex flex-col bg-surface text-on-background">
        {/* Clarity & Trust System is strictly light-mode — pin the theme so the
            UI matches the wireframes exactly and never flips to dark. */}
        <ThemeProvider
          attribute="class"
          forcedTheme="light"
          enableSystem={false}
          disableTransitionOnChange
        >
          <QueryProvider>
            <EvmWalletProvider>
              <LoopWalletProvider>
                <WalletProvider>
                  <AppShell>{children}</AppShell>
                </WalletProvider>
              </LoopWalletProvider>
            </EvmWalletProvider>
          </QueryProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}

import type { Metadata } from "next";
import { Fraunces, Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

import { WalletProvider } from "@/hooks/useWallet";
import { AppShell } from "@/components/AppShell";
import { QueryProvider } from "@/components/QueryProvider";
import { ThemeProvider } from "@/components/ThemeProvider";

// Body + UI. Inter ships excellent tabular numerals and is the de-facto
// premium-fintech sans (Stripe, Linear, Vercel, GitHub).
const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
  display: "swap"
});

// Brand serif. Fraunces has a soft, editorial high-end feel and a variable
// optical-size axis, so we get tight display weights and readable body
// weights from a single file.
const fraunces = Fraunces({
  variable: "--font-serif",
  subsets: ["latin"],
  display: "swap",
  axes: ["opsz", "SOFT"]
});

// Mono for party IDs, contract IDs, hashes, balance digits where we want
// fixed-width alignment.
const jetBrainsMono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  display: "swap"
});

export const metadata: Metadata = {
  title: "Oranj",
  description: "Mint, hold, and transfer CBTC on Canton Network."
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
      className={`${inter.variable} ${fraunces.variable} ${jetBrainsMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-background text-foreground font-sans">
        <ThemeProvider
          attribute="class"
          defaultTheme="light"
          enableSystem={false}
          disableTransitionOnChange
        >
          <QueryProvider>
            <WalletProvider>
              <AppShell>{children}</AppShell>
            </WalletProvider>
          </QueryProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}

import type { Metadata } from "next";
import { Fraunces, Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

import { WalletProvider } from "@/hooks/useWallet";
import { ThemeProvider } from "@/components/ThemeProvider";
import { TopNav } from "@/components/TopNav";

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
  description: "Mint, hold, and transfer cBTC on Canton Network."
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
          <WalletProvider>
            <TopNav />
            <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
              {children}
            </main>
          </WalletProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}

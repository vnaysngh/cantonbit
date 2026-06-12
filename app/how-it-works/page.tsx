import Link from "next/link";

import { Reveal } from "./Reveal";

export const metadata = {
  title: "How it works · OranjSwap",
  description:
    "How OranjSwap moves Bitcoin-backed tokens between EVM and Canton with hashlocked atomic swaps."
};

const STEPS = [
  {
    icon: "lock",
    title: "Lock your side",
    body: "You sign to lock your asset on EVM or Canton. The amount, counterparty, and refund deadline are fixed on-chain — nobody can rewrite them later."
  },
  {
    icon: "sync_lock",
    title: "Both legs lock",
    body: "The solver locks the other asset under the same hashlock. Until both sides are in place, neither party can walk away with the other's funds."
  },
  {
    icon: "key",
    title: "Claim or refund",
    body: "Reveal the secret to claim what you're owed; the same secret completes the other leg. If the swap stalls, timelocks refund each side independently."
  }
] as const;

const TAGS = ["HASHLOCKED", "TIMED REFUNDS", "NON-CUSTODIAL"] as const;

const dottedBg: React.CSSProperties = {
  backgroundImage:
    "radial-gradient(circle, color-mix(in srgb, var(--foreground) 8%, transparent) 1px, transparent 1px)",
  backgroundSize: "22px 22px"
};

export default function HowItWorksPage() {
  return (
    <div style={dottedBg} className="min-h-[calc(100vh-4rem)] w-full">
      <div className="mx-auto w-full max-w-[1080px] px-4 py-14 sm:py-20">
        <Reveal className="mx-auto max-w-[640px] text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary-container">
            EVM ↔ Canton
          </p>
          <h1 className="mt-3 text-3xl font-bold tracking-tight text-foreground sm:text-[2.75rem] sm:leading-[1.1]">
            How OranjSwap works
          </h1>
          <p className="mx-auto mt-4 max-w-[560px] text-[15px] leading-relaxed text-muted-foreground sm:text-base">
            Swap Bitcoin-backed tokens across chains. Both legs share one
            hashlock — a single secret settles the trade, and staggered
            timelocks protect each side if anything stops halfway.
          </p>
          {/*   <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
            {(["EVM → Canton", "Canton → EVM"] as const).map((dir) => (
              <span
                key={dir}
                className="rounded-full border border-foreground/10 bg-card/80 px-3 py-1 text-xs font-medium text-foreground/70"
              >
                {dir}
              </span>
            ))}
          </div> */}
        </Reveal>

        <div className="mt-14 grid grid-cols-1 gap-5 md:grid-cols-3">
          {STEPS.map((s, i) => (
            <Reveal key={s.title} delay={120 + i * 70}>
              <div className="h-full rounded-2xl border border-foreground/10 bg-card/70 p-6 shadow-sm backdrop-blur-sm transition-colors hover:border-foreground/20">
                <div className="flex items-center gap-3">
                  <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary-container/20">
                    <span className="material-symbols-outlined text-[22px] text-primary-container">
                      {s.icon}
                    </span>
                  </div>
                  <span className="text-xs font-semibold tabular-nums text-muted-foreground">
                    Step {i + 1}
                  </span>
                </div>
                <h2 className="mt-4 text-lg font-semibold text-foreground">
                  {s.title}
                </h2>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {s.body}
                </p>
              </div>
            </Reveal>
          ))}
        </div>

        <div className="mt-12 rounded-3xl border border-primary-container/30 bg-muted/40 px-6 py-12 text-center">
          <h2 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
            Ready to swap?
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground sm:text-base">
            Sign in with email or connect Loop, choose a direction, and follow
            the steps on the swap page.
          </p>
          <Link
            href="/swap"
            className="mt-6 inline-block rounded-xl bg-primary-container px-8 py-3.5 text-base font-semibold text-foreground shadow-sm transition-opacity hover:opacity-90"
          >
            Start a swap
          </Link>
          <p className="mt-6 text-[11px] font-medium tracking-wider text-muted-foreground">
            {TAGS.join(" · ")}
          </p>
        </div>
      </div>
    </div>
  );
}

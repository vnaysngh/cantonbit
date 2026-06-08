import Link from "next/link";

/**
 * How it works — three-card explainer matching the approved wireframe:
 * centered intro, a row of icon cards, and a CTA banner with a tag row. Copy is
 * OranjSwap's own (WBTC → CBTC bridge), not generic intent/solver marketing.
 */
export const metadata = {
  title: "How it works · OranjSwap",
  description: "How OranjSwap bridges WBTC on Arbitrum to CBTC on Canton.",
};

const STEPS = [
  {
    icon: "lock",
    title: "Lock your WBTC",
    body: "Deposit WBTC into an audited escrow on Arbitrum. The amount, recipient, and deadline are signed by you — and can't be changed by anyone.",
  },
  {
    icon: "swap_horiz",
    title: "Receive CBTC",
    body: "Once your deposit confirms, the bridge delivers CBTC to your Canton wallet at the live WBTC/BTC rate, minus a 0.2% fee. CBTC is redeemable 1:1 for BTC.",
  },
  {
    icon: "verified",
    title: "Settle — or refund",
    body: "The escrow finalises against your delivery. If anything fails first, your WBTC is automatically refunded — it never leaves escrow without a matching CBTC delivery.",
  },
];

const TAGS = ["NON-CUSTODIAL", "LIVE RATE", "DE-PEG PROTECTED"];

// Subtle dotted texture, inlined so the page is self-contained.
const dottedBg: React.CSSProperties = {
  backgroundImage:
    "radial-gradient(circle, color-mix(in srgb, var(--foreground) 8%, transparent) 1px, transparent 1px)",
  backgroundSize: "22px 22px",
};

export default function HowItWorksPage() {
  return (
    <div style={dottedBg} className="min-h-[calc(100vh-4rem)] w-full">
      <div className="mx-auto w-full max-w-[1080px] px-4 py-14 sm:py-20">
        {/* Intro */}
        <div className="mx-auto max-w-[640px] text-center">
          <h1 className="text-3xl font-bold tracking-tight text-foreground sm:text-[2.75rem] sm:leading-[1.1]">
            How OranjSwap Works
          </h1>
          <p className="mx-auto mt-4 max-w-[560px] text-[15px] leading-relaxed text-muted-foreground sm:text-base">
            Move your Bitcoin across chains. Lock WBTC on Arbitrum, receive CBTC
            on Canton — both are claims on 1 BTC, so you keep your value the whole
            way.
          </p>
        </div>

        {/* Three cards */}
        <div className="mt-14 grid grid-cols-1 gap-6 md:grid-cols-3">
          {STEPS.map((s, i) => (
            <div
              key={s.title}
              className="rounded-2xl border border-foreground/10 bg-card/70 p-6 shadow-sm backdrop-blur-sm transition-colors hover:border-foreground/20"
            >
              <div className="flex size-12 items-center justify-center rounded-xl bg-primary-container/20">
                <span className="material-symbols-outlined text-[24px] text-primary-container">
                  {s.icon}
                </span>
              </div>
              <h2 className="mt-5 text-lg font-semibold text-foreground">
                {i + 1}. {s.title}
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {s.body}
              </p>
            </div>
          ))}
        </div>

        {/* CTA banner */}
        <div className="mt-12 rounded-3xl border border-primary-container/30 bg-muted/40 px-6 py-12 text-center">
          <h2 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
            Ready to bridge your Bitcoin?
          </h2>
          <Link
            href="/swap"
            className="mt-6 inline-block rounded-xl bg-primary-container px-8 py-3.5 text-base font-semibold text-foreground shadow-sm transition-opacity hover:opacity-90"
          >
            Start a swap
          </Link>
          <div className="mt-7 flex items-center justify-center gap-3 text-xs font-medium tracking-wider text-muted-foreground">
            {TAGS.map((tag, i) => (
              <span key={tag} className="flex items-center gap-3">
                {i > 0 && (
                  <span className="size-1 rounded-full bg-muted-foreground/40" />
                )}
                {tag}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

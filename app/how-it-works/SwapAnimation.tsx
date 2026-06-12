"use client";

/**
 * Animated atomic-swap diagram for the How-it-works page. Pure SVG + CSS — no
 * Three.js/GSAP (keeps the bundle tiny). It TEACHES the mechanism: two chains,
 * both legs locked under one hashlock, the secret revealed once unlocks BOTH —
 * which is the whole product story. Plays once on view, then loops gently.
 *
 * Respects prefers-reduced-motion (renders the static end state).
 */
import { useEffect, useRef, useState } from "react";

export function SwapAnimation() {
  const ref = useRef<HTMLDivElement>(null);
  const [play, setPlay] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => { if (e.isIntersecting) { setPlay(true); io.disconnect(); } },
      { threshold: 0.4 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={ref} className="relative mx-auto w-full max-w-[680px]" data-play={play}>
      <svg viewBox="0 0 680 300" className="w-full" role="img" aria-label="Atomic swap: WBTC locked on EVM and CBTC on Canton, both released by one secret">
        <defs>
          <linearGradient id="evmGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#f7931a" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#f7931a" stopOpacity="0.04" />
          </linearGradient>
          <linearGradient id="cantonGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#b04a2a" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#b04a2a" stopOpacity="0.04" />
          </linearGradient>
          <filter id="soft" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="3" />
          </filter>
        </defs>

        {/* ── connecting rail ── */}
        <line x1="190" y1="150" x2="490" y2="150" stroke="currentColor" strokeOpacity="0.12" strokeWidth="2" strokeDasharray="4 6" />
        {/* the secret travelling the rail (animated) */}
        <circle className="secret-spark" cx="190" cy="150" r="5" fill="#b04a2a" filter="url(#soft)" />
        <circle className="secret-spark" cx="190" cy="150" r="3" fill="#fff" />

        {/* ── LEFT: EVM chain box ── */}
        <g className="chain-card chain-left">
          <rect x="40" y="70" width="150" height="160" rx="18" fill="url(#evmGrad)" stroke="#f7931a" strokeOpacity="0.35" strokeWidth="1.5" />
          <text x="115" y="100" textAnchor="middle" className="lbl" fill="currentColor" fillOpacity="0.55" fontSize="12" fontWeight="600">EVM CHAIN</text>
          {/* WBTC coin */}
          <circle cx="115" cy="150" r="26" fill="#f7931a" fillOpacity="0.15" stroke="#f7931a" strokeOpacity="0.5" strokeWidth="1.5" />
          <text x="115" y="155" textAnchor="middle" fill="#f7931a" fontSize="13" fontWeight="700">WBTC</text>
          {/* padlock that "snaps shut" then opens at reveal */}
          <g className="lock lock-left" transform="translate(115 198)">
            <rect x="-9" y="-2" width="18" height="14" rx="3" fill="#f7931a" fillOpacity="0.85" />
            <path className="shackle" d="M-5 -2 v-4 a5 5 0 0 1 10 0 v4" fill="none" stroke="#f7931a" strokeWidth="2.4" strokeLinecap="round" />
          </g>
        </g>

        {/* ── RIGHT: Canton chain box ── */}
        <g className="chain-card chain-right">
          <rect x="490" y="70" width="150" height="160" rx="18" fill="url(#cantonGrad)" stroke="#b04a2a" strokeOpacity="0.35" strokeWidth="1.5" />
          <text x="565" y="100" textAnchor="middle" className="lbl" fill="currentColor" fillOpacity="0.55" fontSize="12" fontWeight="600">CANTON</text>
          <circle cx="565" cy="150" r="26" fill="#b04a2a" fillOpacity="0.15" stroke="#b04a2a" strokeOpacity="0.5" strokeWidth="1.5" />
          <text x="565" y="155" textAnchor="middle" fill="#b04a2a" fontSize="13" fontWeight="700">CBTC</text>
          <g className="lock lock-right" transform="translate(565 198)">
            <rect x="-9" y="-2" width="18" height="14" rx="3" fill="#b04a2a" fillOpacity="0.85" />
            <path className="shackle" d="M-5 -2 v-4 a5 5 0 0 1 10 0 v4" fill="none" stroke="#b04a2a" strokeWidth="2.4" strokeLinecap="round" />
          </g>
        </g>

        {/* ── CENTER: the one secret/key ── */}
        <g className="keyhole" transform="translate(340 150)">
          <circle r="22" fill="currentColor" fillOpacity="0.05" stroke="currentColor" strokeOpacity="0.18" strokeWidth="1.5" />
          <text y="5" textAnchor="middle" fontSize="18">🔑</text>
        </g>
      </svg>

      <style jsx>{`
        /* Static-first: everything visible. Animate only when [data-play=true]. */
        :global([data-play="true"]) .chain-left { animation: rise 0.6s 0.05s both; }
        :global([data-play="true"]) .chain-right { animation: rise 0.6s 0.2s both; }
        :global([data-play="true"]) .keyhole { animation: pop 0.5s 0.55s both; }
        :global([data-play="true"]) .secret-spark { animation: travel 2.4s 1s ease-in-out infinite; }
        :global([data-play="true"]) .lock .shackle { animation: unlock 2.4s 1s ease-in-out infinite; transform-origin: center; }

        .chain-left, .chain-right, .keyhole { opacity: 0.999; }
        :global([data-play="false"]) .secret-spark { opacity: 0; }

        @keyframes rise {
          from { opacity: 0; transform: translateY(14px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes pop {
          0%   { opacity: 0; transform: translate(340px,150px) scale(0.6); }
          70%  { transform: translate(340px,150px) scale(1.12); }
          100% { opacity: 1; transform: translate(340px,150px) scale(1); }
        }
        /* the secret leaves Canton (user reveals on claim) and travels to EVM */
        @keyframes travel {
          0%   { transform: translate(0,0); opacity: 0; }
          12%  { opacity: 1; }
          50%  { transform: translate(150px,0); }   /* reaches the key */
          88%  { transform: translate(300px,0); opacity: 1; } /* reaches EVM */
          100% { transform: translate(300px,0); opacity: 0; }
        }
        /* both shackles lift open as the secret passes — "one secret, both legs" */
        @keyframes unlock {
          0%, 45%  { transform: translateY(0) rotate(0); }
          60%, 90% { transform: translateY(-4px) rotate(-18deg); }
          100%     { transform: translateY(0) rotate(0); }
        }
        @media (prefers-reduced-motion: reduce) {
          :global([data-play="true"]) * { animation: none !important; }
        }
      `}</style>
    </div>
  );
}

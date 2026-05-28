"use client";

/**
 * Oranj logomark — a single orange with a small green leaf nub on top.
 *
 * Designed to function as the literal letter "O" in the wordmark
 * "Oranj" — paired with the text "ranj" it reads as the full name.
 *
 * Scales cleanly from 16px favicon to hero size.
 */
export function OranjLogo({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 80 80"
      fill="none"
      aria-label="Oranj"
      className={className}
    >
      <circle cx="40" cy="42" r="30" fill="#F97316" />
      <path d="M 44 12 Q 52 6 50 16 Q 46 17 44 12 Z" fill="#10B981" />
    </svg>
  );
}

"use client";

import { useEffect, type ReactNode } from "react";

/**
 * Light-mode-only wrapper.
 *
 * The app no longer needs next-themes runtime script injection because the UI is
 * intentionally pinned to light mode in `app/layout.tsx`. Rendering
 * next-themes' script from this client component triggers React's "script tag
 * while rendering" warning, so keep this as a no-op compatibility wrapper for
 * existing layout props.
 */
export function ThemeProvider({
  children
}: {
  children: ReactNode;
  [key: string]: unknown;
}) {
  useEffect(() => {
    document.documentElement.classList.add("light");
  }, []);

  return <>{children}</>;
}

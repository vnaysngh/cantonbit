import { loopWebBase } from "@/lib/constants";

/** Open Loop in a new tab. Must run synchronously inside a user click handler. */
export function openLoopWalletTab(): Window | null {
  if (typeof window === "undefined") return null;
  // Do not pass noopener — browsers return null on success, which breaks detection.
  const tab = window.open(loopWebBase(), "_blank");
  if (tab) {
    try {
      tab.opener = null;
    } catch {
      /* cross-origin */
    }
  }
  return tab;
}

export function isPopupBlocked(win: Window | null): boolean {
  if (!win) return true;
  try {
    return win.closed;
  } catch {
    return true;
  }
}

/** Pre-open Loop before async prep so the browser keeps the user-gesture chain. */
export function preflightLoopPopup():
  | { ok: true; tab: Window | null }
  | { ok: false } {
  const tab = openLoopWalletTab();
  if (isPopupBlocked(tab)) return { ok: false };
  return { ok: true, tab };
}

export function isLoopPopupBlockedError(error: unknown): boolean {
  const maybe = error as { name?: unknown; message?: unknown; code?: unknown };
  const name = typeof maybe?.name === "string" ? maybe.name : "";
  const code = typeof maybe?.code === "string" ? maybe.code : "";
  const message =
    typeof maybe?.message === "string" ? maybe.message.toLowerCase() : "";
  return (
    name === "PopupClosedError" ||
    code === "POPUP_BLOCKED" ||
    code === "POPUP_CLOSED" ||
    message.includes("popup blocked") ||
    (message.includes("popup") && message.includes("block"))
  );
}

import { loopWebBase } from "@/lib/constants";

/** Open Loop in a new tab (manual fallback when the user clicks "Open Loop wallet"). */
export function openLoopWalletTab(): Window | null {
  if (typeof window === "undefined") return null;
  // Do not pass noopener — Chrome returns null on success, which breaks block detection.
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

/** True when window.open returned null or the tab was immediately closed (blocked). */
export function isPopupBlocked(win: Window | null): boolean {
  if (!win) return true;
  try {
    return win.closed;
  } catch {
    return true;
  }
}

/** True when the Loop SDK failed because the browser blocked its popup. */
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

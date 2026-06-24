/**
 * CBTC delivery: the user's side of the CoW-aligned swap settlement.
 *
 * The swap uses a MANDATORY auto-accept gate (like an EVM allowance — turned on
 * once, always on), so the delivered CBTC auto-accepts in the user's wallet and
 * the solver's accept-first/pay-second ordering holds. The outcome is confirmed
 * by reading the user's authoritative Loop transfer history. Both reads need the
 * Loop JWT (CORS-blocked + JWT-only from the browser).
 *
 * SIGNATURE LIFECYCLE — the user signs ONCE, as a PREREQUISITE on the swap screen
 * (not at connect, not on the Review-swap click):
 *   - `swapSessionActive()` probes whether a valid session exists — NO signature.
 *     The swap screen calls this on entry; if false, it shows the sign popup.
 *   - `mintSwapSession(provider)` performs the one "Exchange API Key" signature
 *     and caches the JWT in an httpOnly cookie on OUR server. Driven by the
 *     popup's "Sign in Loop wallet" CTA.
 *   - `hasCbtcAutoAccept()` / `getCbtcDeliveryHistory()` then read the cached JWT
 *     with NO signature. If the session expired (hours later) they transparently
 *     re-mint once and retry, so a long-lived tab self-heals.
 *
 * No private key ever leaves the wallet; the signature only proves wallet
 * ownership so our server can read the user's own Loop profile/history.
 */
import type { LoopProvider } from "@/hooks/useLoopWallet";

export type SwapSessionMintResult =
  | { ok: true }
  | { ok: false; message: string };

function extractSignature(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of ["signature", "sig", "payload", "result", "data"]) {
    const nested = extractSignature(record[key]);
    if (nested) return nested;
  }
  return null;
}

async function responseText(res: Response): Promise<string> {
  return (await res.text().catch(() => "")).trim();
}

function loopSignErrorMessage(error: unknown): string {
  const maybe = error as {
    name?: unknown;
    message?: unknown;
    code?: unknown;
    errorCode?: unknown;
  };
  const code =
    typeof maybe?.code === "string"
      ? maybe.code
      : typeof maybe?.errorCode === "string"
        ? maybe.errorCode
        : "";
  const message =
    typeof maybe?.message === "string" ? maybe.message.toLowerCase() : "";
  if (code === "POPUP_CLOSED" || message.includes("popup")) {
    return "Loop wallet window closed before signing. Keep the Loop wallet tab open, approve the signature, then return here.";
  }
  if (
    message.includes("reject") ||
    message.includes("declin") ||
    maybe?.name === "RejectRequestError"
  ) {
    return "Signature was declined in Loop wallet. Please approve it to continue.";
  }
  if (
    message.includes("not connected") ||
    message.includes("cannot reconnect") ||
    message.includes("failed to reconnect")
  ) {
    return "Loop wallet connection expired. Reconnect Loop wallet, then sign again.";
  }
  if (message.includes("timeout")) {
    return "Loop wallet did not return the signature in time. Open the Loop wallet tab and try again.";
  }
  return "Loop wallet did not complete the signature. Open Loop wallet and try again.";
}

/**
 * The "Exchange API Key" components the user's wallet signs. Our server exchanges
 * these for the Loop JWT (api_key) to read the user's /profile and /history (both
 * CORS-blocked + JWT-only from the browser). The signature proves wallet
 * ownership; no private key leaves the wallet. Returns null if the user declines.
 */
export async function signExchange(
  provider: LoopProvider
): Promise<{ public_key: string; signature: string; epoch: number } | null> {
  const epoch = Date.now();
  const message = `Exchange API Key for ${provider.party_id}\nTimestamp: ${epoch}`;
  const sigRaw = await provider.signMessage(message);
  const signature = extractSignature(sigRaw);
  if (!signature) return null;
  return { public_key: provider.public_key, signature, epoch };
}

/**
 * Is there a valid server-side JWT session right now? Pure probe — NO signature,
 * NO minting. Use it to decide whether to show the "sign to continue" gate.
 */
export async function swapSessionActive(partyId?: string): Promise<boolean> {
  try {
    const url = partyId
      ? `/api/swap/session?party=${encodeURIComponent(partyId)}`
      : "/api/swap/session";
    const probe = await fetch(url, {
      method: "GET",
      cache: "no-store",
      signal: AbortSignal.timeout(5000)
    });
    if (!probe.ok) return false;
    const { active } = (await probe.json()) as { active?: boolean };
    return active === true;
  } catch {
    return false;
  }
}

/**
 * Sign once (ONE "Exchange API Key" wallet prompt) and mint a fresh server
 * session. Returns true on success, false if the user declined or the exchange
 * failed. Exported so the swap screen can drive the explicit "Sign in your Loop
 * wallet" prerequisite action (rather than signing implicitly mid-flow).
 */
export async function mintSwapSession(
  provider: LoopProvider
): Promise<boolean> {
  return (await mintSwapSessionDetailed(provider)).ok;
}

export async function mintSwapSessionDetailed(
  provider: LoopProvider
): Promise<SwapSessionMintResult> {
  try {
    const exchange = await signExchange(provider);
    if (!exchange) {
      return {
        ok: false,
        message:
          "Loop wallet did not return a signature. Open the Loop wallet tab and approve the request."
      };
    }
    const res = await fetch("/api/swap/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify(exchange)
    });
    if (!res.ok) {
      const body = await responseText(res);
      return {
        ok: false,
        message: body
          ? `Loop signature could not be verified: ${body}`
          : "Loop signature could not be verified. Please try again."
      };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, message: loopSignErrorMessage(error) };
  }
}

/** Clear the server session (call on wallet logout). */
export async function clearSwapSession(): Promise<void> {
  try {
    await fetch("/api/swap/session", { method: "DELETE" });
  } catch {
    /* ignore */
  }
}

/**
 * GET a swap API route that needs the Loop JWT session. If the server says the
 * session is missing/expired (401 needsSignature), re-mint ONCE (one signature)
 * and retry — so a stale session self-heals without failing the swap. `provider`
 * is optional: pass it to allow the silent re-mint; omit it to fail fast on 401.
 */
async function getWithSession(
  path: string,
  provider?: LoopProvider | null
): Promise<Response | null> {
  let res = await fetch(path, { method: "GET" });
  if (res.status === 401 && provider) {
    const minted = await mintSwapSession(provider);
    if (!minted) return null; // user declined the re-mint
    res = await fetch(path, { method: "GET" });
  }
  return res;
}

/**
 * Whether the user has the CBTC auto-accept (utility preapproval) gate ON. This
 * is what makes the swap safe: with it on, the delivered CBTC auto-accepts, so
 * the solver's accept-first/pay-second ordering holds. Reads the cached Loop JWT
 * session — NO signature here (the session is a prerequisite established before
 * the swap). On a missing/expired session (401) it returns null WITHOUT a silent
 * re-mint, so the caller re-shows the sign gate rather than springing a surprise
 * signature on the Review-swap click. Returns true (ON), false (OFF), or null
 * (no session / couldn't read).
 *
 * (`provider` is kept in the signature for symmetry with the history read and
 * possible future use; this gate deliberately does not use it to re-mint.)
 */
export async function hasCbtcAutoAccept(
  _provider: LoopProvider
): Promise<boolean | null> {
  try {
    const res = await getWithSession("/api/swap/preapproval"); // no silent re-mint
    if (!res || !res.ok) return null;
    const { cbtcAutoAccept } = (await res.json()) as {
      cbtcAutoAccept?: boolean;
    };
    return cbtcAutoAccept === true;
  } catch {
    return null;
  }
}

/** A CBTC "received" transfer from the user's Loop history. */
export interface CbtcHistoryTransfer {
  id: string;
  amount: string;
  from: string;
  status: string; // "completed" | "rejected" | "pending"
  created_at: string;
}

/**
 * Read the AUTHORITATIVE outcome of the CBTC delivery from the user's Loop
 * transfer history (status completed=accepted, rejected=rejected). The user's own
 * history is the source of truth — the solver can't read it cross-participant.
 * Reads the cached Loop JWT session (no signature unless the session expired).
 * Returns the recent CBTC received transfers, or null if it couldn't read them.
 */
export async function getCbtcDeliveryHistory(
  provider: LoopProvider
): Promise<CbtcHistoryTransfer[] | null> {
  try {
    const res = await getWithSession("/api/swap/history", provider);
    if (!res || !res.ok) return null;
    const { transfers } = (await res.json()) as {
      transfers?: CbtcHistoryTransfer[];
    };
    return transfers ?? [];
  } catch {
    return null;
  }
}

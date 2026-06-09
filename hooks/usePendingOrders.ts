"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { getOrder, isTerminal, ApiError, type OrderView } from "@/lib/swap-api";

/**
 * Tracks a LIST of swap orders the user has in flight — the CoW model (a map of
 * pending orders, each polled independently), NOT a single "active order".
 *
 * Why: the old design stored ONE orderId in localStorage. Starting a second swap
 * (or a second browser tab) overwrote it, orphaning the first order on refresh.
 * CoW keeps every pending order in state and polls them all, so nothing is lost.
 *
 * This hook:
 *  - persists the id list in localStorage (survives refresh / resumes tracking),
 *  - polls each non-terminal order on an interval,
 *  - keeps terminal orders briefly (so the user sees the final state), then prunes,
 *  - dedupes ids and is multi-tab safe (re-reads storage on `storage` events).
 */
const STORAGE_KEY = "oranj.swap.orders";

/** ms a terminal (done/failed/refunded) order stays in the list before pruning. */
const TERMINAL_LINGER_MS = 60_000;
const POLL_MS = 4000;
/**
 * How long an order may continuously 404 before we treat it as gone. TIME-based
 * (not poll-count based) on purpose: a count is fragile to rapid re-ticks (HMR /
 * StrictMode double-mount can fire many polls in an instant and blow past a
 * counter). 20s of real wall-clock is immune to that and still tolerates the
 * brief post-submit window where the solver hasn't registered the order yet.
 */
const NOT_FOUND_GRACE_MS = 20_000;

export interface TrackedOrder {
  orderId: string;
  /** Latest fetched view, or null until the first poll resolves. */
  order: OrderView | null;
  /** True once the order reached a terminal status (done/failed/refunded/expired). */
  terminal: boolean;
  /** Wall-clock (ms) the order became terminal — used to linger then prune. */
  terminalAt: number | null;
}

function readIds(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is string => typeof x === "string" && /^0x[0-9a-fA-F]{64}$/.test(x),
    );
  } catch {
    return [];
  }
}

function writeIds(ids: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...new Set(ids)]));
  } catch {
    /* ignore quota / disabled storage */
  }
}

export function usePendingOrders() {
  const [orders, setOrders] = useState<TrackedOrder[]>([]);
  // Per-order wall-clock (ms) when we FIRST saw a sustained 404 — used to prune an
  // order that's been 404ing longer than NOT_FOUND_GRACE_MS. Cleared on any 2xx.
  const firstNotFoundAtRef = useRef<Record<string, number>>({});
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Hydrate the list from storage on mount, and stay in sync if another tab
  // changes it (CoW-style multi-tab safety).
  useEffect(() => {
    const hydrate = () => {
      const ids = readIds();
      setOrders((prev) => {
        const byId = new Map(prev.map((o) => [o.orderId, o]));
        return ids.map(
          (id) =>
            byId.get(id) ?? {
              orderId: id,
              order: null,
              terminal: false,
              terminalAt: null,
            },
        );
      });
    };
    hydrate();
    window.addEventListener("storage", hydrate);
    return () => window.removeEventListener("storage", hydrate);
  }, []);

  /** Add an order to the tracked list (idempotent). Call right after submit. */
  const addOrder = useCallback((orderId: string) => {
    if (!/^0x[0-9a-fA-F]{64}$/.test(orderId)) return;
    setOrders((prev) => {
      if (prev.some((o) => o.orderId === orderId)) return prev;
      const next = [
        ...prev,
        { orderId, order: null, terminal: false, terminalAt: null },
      ];
      writeIds(next.map((o) => o.orderId));
      return next;
    });
  }, []);

  /** Remove an order from the list (e.g. user dismisses a finished receipt). */
  const dismissOrder = useCallback((orderId: string) => {
    delete firstNotFoundAtRef.current[orderId];
    setOrders((prev) => {
      const next = prev.filter((o) => o.orderId !== orderId);
      writeIds(next.map((o) => o.orderId));
      return next;
    });
  }, []);

  // Poll every tracked order independently. ONE interval drives all of them.
  // Guarded against overlap (a slow tick won't double-count 404s) and against
  // React StrictMode double-mount (a module-stable lock). Empty dep array → the
  // interval is created exactly once; it reads ids fresh from storage each tick.
  const inFlightRef = useRef(false);
  useEffect(() => {
    const tick = async () => {
      if (inFlightRef.current) return; // don't overlap — prevents 404-streak races
      const ids = readIds();
      if (ids.length === 0) return;
      inFlightRef.current = true;
      try {
        const toPrune: string[] = [];
        await Promise.all(
          ids.map(async (orderId) => {
            try {
              const view = await getOrder(orderId);
              delete firstNotFoundAtRef.current[orderId]; // any 2xx clears the 404 timer
              setOrders((prev) =>
                prev.map((o) =>
                  o.orderId === orderId
                    ? {
                        ...o,
                        order: view,
                        terminal: isTerminal(view.status),
                        terminalAt:
                          isTerminal(view.status) && o.terminalAt == null
                            ? Date.now()
                            : o.terminalAt,
                      }
                    : o,
                ),
              );
            } catch (e) {
              if (e instanceof ApiError && e.status === 404) {
                // TIME-based grace: remember when the 404s started; only prune once
                // they've persisted longer than NOT_FOUND_GRACE_MS of wall-clock.
                // Immune to rapid re-ticks (a count would over-strike under HMR).
                const firstAt = firstNotFoundAtRef.current[orderId] ?? Date.now();
                firstNotFoundAtRef.current[orderId] = firstAt;
                // Gone (expired + pruned, or store reset). Drop it — WBTC is safe
                // (auto-refunds on-chain); leaving it would spin forever.
                if (Date.now() - firstAt >= NOT_FOUND_GRACE_MS) toPrune.push(orderId);
              }
              // other errors (network/5xx): keep polling, it's transient.
            }
          }),
        );

        // Prune: 404-dead orders + terminal orders that have lingered long enough.
        const now = Date.now();
        setOrders((prev) => {
          const keep = prev.filter((o) => {
            if (toPrune.includes(o.orderId)) return false;
            if (o.terminal && o.terminalAt != null && now - o.terminalAt > TERMINAL_LINGER_MS)
              return false;
            return true;
          });
          if (keep.length !== prev.length) writeIds(keep.map((o) => o.orderId));
          return keep;
        });
        toPrune.forEach((id) => delete firstNotFoundAtRef.current[id]);
      } finally {
        inFlightRef.current = false;
      }
    };

    void tick();
    pollRef.current = setInterval(tick, POLL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, []);

  return { orders, addOrder, dismissOrder };
}

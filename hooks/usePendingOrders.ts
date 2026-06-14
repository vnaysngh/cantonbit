"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { htlcApi } from "@/lib/htlc-client";
import { isHtlcTerminal } from "@/lib/htlc-track-order";
import type { SwapOrder } from "@/lib/htlc-types";

/** Minimal error type for HTTP failures from /api/htlc/{id}. */
class HtlcPollError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HtlcPollError";
    this.status = status;
  }
}

/**
 * Tracks in-flight HTLC swap orders (CoW-style list). Polls GET /api/htlc/{id}
 * on the Next.js app — NOT the legacy :8787 solver API.
 */
const STORAGE_KEY = "oranj.swap.orders";
const TERMINAL_LINGER_MS = 60_000;
const POLL_MS = 4000;
const NOT_FOUND_GRACE_MS = 20_000;

export interface TrackedOrder {
  orderId: string;
  order: SwapOrder | null;
  terminal: boolean;
  terminalAt: number | null;
}

function readIds(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is string => typeof x === "string" && /^0x[0-9a-fA-F]{64}$/.test(x)
    );
  } catch {
    return [];
  }
}

function writeIds(ids: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...new Set(ids)]));
  } catch {
    /* ignore */
  }
}

async function fetchHtlcOrder(orderId: string): Promise<SwapOrder> {
  const r = await fetch(`/api/htlc/${orderId}`, { cache: "no-store" });
  const j = (await r.json().catch(() => ({}))) as {
    order?: SwapOrder;
    error?: string;
  };
  if (!r.ok) {
    throw new HtlcPollError(r.status, j.error ?? `GET /api/htlc/${orderId} failed`);
  }
  if (!j.order) throw new HtlcPollError(500, "missing order in response");
  return j.order;
}

export function usePendingOrders() {
  const [orders, setOrders] = useState<TrackedOrder[]>([]);
  const firstNotFoundAtRef = useRef<Record<string, number>>({});
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
              terminalAt: null
            }
        );
      });
    };
    hydrate();
    window.addEventListener("storage", hydrate);
    return () => window.removeEventListener("storage", hydrate);
  }, []);

  const addOrder = useCallback((orderId: string) => {
    if (!/^0x[0-9a-fA-F]{64}$/.test(orderId)) return;
    setOrders((prev) => {
      if (prev.some((o) => o.orderId === orderId)) return prev;
      const next = [
        ...prev,
        { orderId, order: null, terminal: false, terminalAt: null }
      ];
      writeIds(next.map((o) => o.orderId));
      return next;
    });
  }, []);

  const dismissOrder = useCallback((orderId: string) => {
    delete firstNotFoundAtRef.current[orderId];
    setOrders((prev) => {
      const next = prev.filter((o) => o.orderId !== orderId);
      writeIds(next.map((o) => o.orderId));
      return next;
    });
  }, []);

  const inFlightRef = useRef(false);
  useEffect(() => {
    const tick = async () => {
      if (inFlightRef.current) return;
      const ids = readIds();
      if (ids.length === 0) return;
      inFlightRef.current = true;
      try {
        const toPrune: string[] = [];
        await Promise.all(
          ids.map(async (orderId) => {
            try {
              const order = await fetchHtlcOrder(orderId);
              delete firstNotFoundAtRef.current[orderId];
              setOrders((prev) =>
                prev.map((o) =>
                  o.orderId === orderId
                    ? {
                        ...o,
                        order,
                        terminal: isHtlcTerminal(order.status),
                        terminalAt:
                          isHtlcTerminal(order.status) && o.terminalAt == null
                            ? Date.now()
                            : o.terminalAt
                      }
                    : o
                )
              );
            } catch (e) {
              if (e instanceof HtlcPollError && e.status === 404) {
                const firstAt =
                  firstNotFoundAtRef.current[orderId] ?? Date.now();
                firstNotFoundAtRef.current[orderId] = firstAt;
                if (Date.now() - firstAt >= NOT_FOUND_GRACE_MS) {
                  toPrune.push(orderId);
                }
              }
            }
          })
        );

        const now = Date.now();
        setOrders((prev) => {
          const keep = prev.filter((o) => {
            if (toPrune.includes(o.orderId)) return false;
            if (
              o.terminal &&
              o.terminalAt != null &&
              now - o.terminalAt > TERMINAL_LINGER_MS
            ) {
              return false;
            }
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

/** Re-export for refund handler compatibility. */
export { HtlcPollError as ApiError };

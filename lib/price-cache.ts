import "server-only";

import { alert } from "./alert";

export interface PriceCacheEntry<T> {
  value: T;
  source: string;
  at: number;
}

export interface FreshPrice<T> extends PriceCacheEntry<T> {
  ageMs: number;
  stale: boolean;
}

export interface PriceSource<T> {
  name: string;
  fetch: () => Promise<T | null>;
}

/**
 * Shared fail-closed freshness policy for price/reference inputs.
 *
 * Fresh live source wins. If all sources fail, a previously validated cache entry
 * may be served for a short bounded stale window with an alert. Beyond that, the
 * caller refuses to quote/settle.
 */
export async function fetchWithFreshness<T>(params: {
  cached: PriceCacheEntry<T> | null;
  setCached: (entry: PriceCacheEntry<T>) => void;
  sources: PriceSource<T>[];
  freshMs: number;
  maxStaleMs: number;
  alertTitle: string;
  unavailableMessage: (reason: string) => string;
  validate?: (value: T) => T;
}): Promise<FreshPrice<T>> {
  const now = Date.now();
  if (params.cached && now - params.cached.at < params.freshMs) {
    const value = params.validate
      ? params.validate(params.cached.value)
      : params.cached.value;
    return {
      ...params.cached,
      value,
      ageMs: now - params.cached.at,
      stale: false
    };
  }

  const errors: string[] = [];
  for (const source of params.sources) {
    try {
      const raw = await source.fetch();
      if (raw == null) {
        errors.push(`${source.name}: invalid payload`);
        continue;
      }
      const value = params.validate ? params.validate(raw) : raw;
      const entry = { value, source: source.name, at: now };
      params.setCached(entry);
      return { ...entry, ageMs: 0, stale: false };
    } catch (e) {
      errors.push(`${source.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const reason = errors.join("; ");
  if (params.cached && now - params.cached.at < params.maxStaleMs) {
    void alert("warn", params.alertTitle, {
      source: params.cached.source,
      ageMs: now - params.cached.at,
      reason
    });
    const value = params.validate
      ? params.validate(params.cached.value)
      : params.cached.value;
    return {
      ...params.cached,
      value,
      ageMs: now - params.cached.at,
      stale: true
    };
  }

  throw new Error(params.unavailableMessage(reason));
}

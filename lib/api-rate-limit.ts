import "server-only";

import { createSupabaseServiceClient } from "./supabase/server";

const fallbackBuckets = new Map<string, number[]>();

function fallbackRateLimit(
  key: string,
  limit: number,
  windowSeconds: number
): boolean {
  const now = Date.now();
  const windowMs = windowSeconds * 1000;
  const hits = (fallbackBuckets.get(key) ?? []).filter(
    (time) => now - time < windowMs
  );
  if (hits.length >= limit) {
    fallbackBuckets.set(key, hits);
    return false;
  }
  hits.push(now);
  fallbackBuckets.set(key, hits);
  return true;
}

/** Distributed fixed-window rate limit backed by an atomic Postgres RPC. */
export async function distributedRateLimitOk(params: {
  scope: string;
  key: string;
  limit: number;
  windowSeconds?: number;
}): Promise<boolean> {
  const windowSeconds = params.windowSeconds ?? 60;
  const bucketKey = `${params.scope}:${params.key}`;
  try {
    const sb = await createSupabaseServiceClient();
    const { data, error } = await sb.rpc("consume_api_rate_limit", {
      p_key: bucketKey,
      p_limit: params.limit,
      p_window_seconds: windowSeconds
    });
    if (error) throw new Error(error.message);
    return data === true;
  } catch (e) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        `rate limiter unavailable: ${e instanceof Error ? e.message : e}`
      );
    }
    return fallbackRateLimit(bucketKey, params.limit, windowSeconds);
  }
}

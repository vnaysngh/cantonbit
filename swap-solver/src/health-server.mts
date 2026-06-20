/**
 * M-01: minimal health/readiness HTTP server for the solver daemons.
 *
 * Exposes GET /health (always 200 once the process is up) and GET /ready (200 only
 * if the last poll succeeded recently). A monitor (Railway healthcheck, uptime
 * probe) can hit /ready to detect a wedged/looping-but-failing daemon — the gap
 * the original M-01 finding flagged (a daemon that stays alive while every poll
 * 401s or throws).
 *
 * Heartbeat model: the daemon calls heartbeat.pollOk() after each successful loop
 * and heartbeat.settleOk() after each successful settlement. /ready is unhealthy if
 * no successful poll happened within READY_STALE_MS.
 */
import { createServer } from "node:http";

export interface Heartbeat {
  pollOk(): void;
  settleOk(): void;
  snapshot(): {
    startedAt: number;
    lastPollOkAt: number | null;
    lastSettleOkAt: number | null;
  };
}

export function startHealthServer(params: {
  name: string;
  port: number;
  /** A poll older than this (ms) marks /ready unhealthy. Default 3× the poll interval. */
  readyStaleMs: number;
  nowMs: () => number;
}): Heartbeat {
  const startedAt = params.nowMs();
  let lastPollOkAt: number | null = null;
  let lastSettleOkAt: number | null = null;

  const heartbeat: Heartbeat = {
    pollOk: () => {
      lastPollOkAt = params.nowMs();
    },
    settleOk: () => {
      lastSettleOkAt = params.nowMs();
    },
    snapshot: () => ({ startedAt, lastPollOkAt, lastSettleOkAt })
  };

  const server = createServer((req, res) => {
    const now = params.nowMs();
    const body = {
      daemon: params.name,
      startedAt,
      uptimeSec: Math.floor((now - startedAt) / 1000),
      lastPollOkAt,
      lastSettleOkAt,
      lastPollAgeSec:
        lastPollOkAt != null ? Math.floor((now - lastPollOkAt) / 1000) : null
    };
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/ready") {
      // Ready once at least one poll has succeeded and it was recent.
      const ready =
        lastPollOkAt != null && now - lastPollOkAt <= params.readyStaleMs;
      res.writeHead(ready ? 200 : 503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ready, ...body }));
      return;
    }
    // /health (and anything else) — liveness only.
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, ...body }));
  });

  server.on("error", (e) => {
    // A health server bind failure must never crash the daemon's core loop.
    console.error(`[${params.name}] health server error:`, e);
  });
  server.listen(params.port, () => {
    console.log(
      `[${params.name}] health server on :${params.port} (GET /health, /ready)`
    );
  });

  return heartbeat;
}

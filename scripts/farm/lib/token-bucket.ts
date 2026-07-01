/**
 * Traffic token-bucket model of the Canton free tier.
 *
 * The free tier is a leaky bucket: capacity `burstBytes` (400,000), refilling at
 * `refillBytesPerSec` (400000/1200 ≈ 333.3). Every transaction spends bytes; you
 * may only submit when the bucket holds enough. Mirroring that bucket locally
 * lets the farm BURST from a full bucket at startup, then self-pace to the
 * sustainable refill rate — never over-waiting, never overdrawing (which would
 * trigger SEQUENCER_NOT_ENOUGH_TRAFFIC_CREDIT).
 *
 * Pure/deterministic: the caller passes the current time in ms (no Date.now()
 * inside), so it is unit-testable and safe under workflow replay.
 */
export interface TokenBucketConfig {
  burstBytes: number;
  refillBytesPerSec: number;
  /** Fraction of the bucket we allow ourselves to use (headroom margin). */
  targetUtilization: number;
}

export class TokenBucket {
  private readonly cfg: TokenBucketConfig;
  /** Usable ceiling = burst × utilization; we never fill/spend above this. */
  private readonly cap: number;
  /**
   * The rate at which WE let ourselves accrue credit = raw refill × utilization.
   * Throttling our own accrual (not just the ceiling) is what leaves margin for
   * co-tenant node traffic on the shared bucket — and makes waitMsFor pace at the
   * conservative rate consistently.
   */
  private readonly effectiveRefill: number;
  private tokens: number;
  private lastMs: number;

  constructor(cfg: TokenBucketConfig, nowMs: number, startFull = true) {
    this.cfg = cfg;
    this.cap = cfg.burstBytes * cfg.targetUtilization;
    this.effectiveRefill = cfg.refillBytesPerSec * cfg.targetUtilization;
    this.tokens = startFull ? this.cap : 0;
    this.lastMs = nowMs;
  }

  /** Accrue refill (at the throttled effective rate) up to `nowMs`, clamped to cap. */
  private refillTo(nowMs: number): void {
    const elapsedSec = Math.max(0, (nowMs - this.lastMs) / 1000);
    this.tokens = Math.min(this.cap, this.tokens + elapsedSec * this.effectiveRefill);
    this.lastMs = nowMs;
  }

  /** Current available bytes at `nowMs` (read-only view; also advances refill). */
  available(nowMs: number): number {
    this.refillTo(nowMs);
    return this.tokens;
  }

  /**
   * Milliseconds to wait from `nowMs` before `bytes` can be afforded. 0 if
   * affordable now. Uses the throttled effective refill so the whole model paces
   * conservatively and consistently.
   */
  waitMsFor(bytes: number, nowMs: number): number {
    this.refillTo(nowMs);
    if (this.tokens >= bytes) return 0;
    const shortfall = bytes - this.tokens;
    return Math.ceil((shortfall / this.effectiveRefill) * 1000);
  }

  /** Spend `bytes` (call after actually submitting). Advances refill first. */
  spend(bytes: number, nowMs: number): void {
    this.refillTo(nowMs);
    this.tokens = Math.max(0, this.tokens - bytes);
  }

  /**
   * Snap the local level to a known real value (clamped to the usable cap) and
   * re-anchor the refill clock. Used as the feedback loop: when the node reports
   * its real `baseTrafficRemainder` in a traffic-rejection error, reset the mirror
   * to it so the local bucket stops tracking fiction.
   */
  reset(tokens: number, nowMs: number): void {
    this.tokens = Math.min(this.cap, Math.max(0, tokens));
    this.lastMs = nowMs;
  }

  /** Usable capacity (burst × utilization) — the most a single cycle may cost. */
  capacity(): number {
    return this.cap;
  }
}

/**
 * De-peg safety guard.
 *
 * Our swap quotes WBTC↔CBTC at 1:1 because both are claims on 1 BTC — par is
 * correct ONLY while each token actually holds its peg. If WBTC (or CBTC)
 * de-pegs from BTC, the 1:1 rate becomes wrong and the solver would be
 * arbitraged: e.g. if WBTC drops to 0.9 BTC, a user swaps 1 (cheap) WBTC for 1
 * (full) CBTC and drains the float.
 *
 * This guard reads the on-chain Chainlink **WBTC/BTC** price feed on the origin
 * chain (the direct de-peg signal) and PAUSES swaps if:
 *   - the price deviates from 1.0 by more than `maxDeviationBps`, or
 *   - the feed is stale (older than `maxStalenessSeconds`), or
 *   - the feed can't be read at all (fail-closed — refuse rather than risk it).
 *
 * It's a SAFETY oracle, not a pricing oracle: it never changes the 1:1 rate, it
 * only decides whether swapping is safe right now. Same idea CoW / serious
 * bridges use — a circuit breaker that halts on a peg break.
 *
 * NOTE: this watches the WBTC peg (on-chain, readable). A CBTC de-peg has no
 * public price feed; that risk is monitored off-chain (the CBTC issuer's
 * redemption health) and is documented as a residual.
 */
import {
  createPublicClient,
  http,
  type Address,
  type PublicClient
} from "viem";

/** Minimal Chainlink AggregatorV3 ABI — latestRoundData + decimals. */
const AGGREGATOR_ABI = [
  {
    name: "latestRoundData",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" }
    ]
  },
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }]
  }
] as const;

export interface DepegConfig {
  rpcUrl: string;
  /** Chainlink WBTC/BTC aggregator address on the origin chain. */
  feed: Address;
  /** Max allowed deviation from 1.0 BTC, in basis points. e.g. 100 = ±1%. */
  maxDeviationBps: number;
  /** Max feed age before we treat it as stale (seconds). e.g. 3600. */
  maxStalenessSeconds: number;
}

export type DepegStatus =
  | {
      ok: true;
      priceBtc: number;
      deviationBps: number;
      /** Raw WBTC/BTC price for EXACT integer pricing: priceBtc = priceRaw / 10^priceDecimals. */
      priceRaw: bigint;
      priceDecimals: number;
    }
  | { ok: false; reason: string; priceBtc?: number; deviationBps?: number };

export class DepegGuard {
  private cfg: DepegConfig;
  private pub: PublicClient;

  constructor(cfg: DepegConfig) {
    this.cfg = cfg;
    this.pub = createPublicClient({ transport: http(cfg.rpcUrl) });
  }

  /**
   * Is it safe to swap right now? Reads the live WBTC/BTC feed and checks
   * deviation + staleness. FAIL-CLOSED: any read error returns ok:false (we
   * refuse to quote/deliver when we can't confirm the peg).
   */
  async check(nowSeconds: number): Promise<DepegStatus> {
    let answer: bigint;
    let updatedAt: bigint;
    let decimals: number;
    try {
      const [, ans, , upd] = (await this.pub.readContract({
        address: this.cfg.feed,
        abi: AGGREGATOR_ABI,
        functionName: "latestRoundData"
      })) as readonly [bigint, bigint, bigint, bigint, bigint];
      decimals = (await this.pub.readContract({
        address: this.cfg.feed,
        abi: AGGREGATOR_ABI,
        functionName: "decimals"
      })) as number;
      answer = ans;
      updatedAt = upd;
    } catch (e) {
      return {
        ok: false,
        reason: `de-peg feed unreadable (fail-closed): ${errMsg(e)}`
      };
    }

    if (answer <= 0n) {
      return {
        ok: false,
        reason: `de-peg feed returned non-positive price (${answer})`
      };
    }
    // Staleness: a frozen feed could hide a de-peg.
    const ageSeconds = nowSeconds - Number(updatedAt);
    if (ageSeconds > this.cfg.maxStalenessSeconds) {
      return {
        ok: false,
        reason: `de-peg feed stale: ${ageSeconds}s old (max ${this.cfg.maxStalenessSeconds}s)`
      };
    }

    // Price in BTC (1.0 = perfect peg). Deviation in bps from 1.0.
    const priceBtc = Number(answer) / 10 ** decimals;
    const deviationBps = Math.round(Math.abs(priceBtc - 1) * 10000);
    if (deviationBps > this.cfg.maxDeviationBps) {
      return {
        ok: false,
        reason: `WBTC de-pegged: ${priceBtc.toFixed(5)} BTC (${deviationBps}bps off, max ${this.cfg.maxDeviationBps}bps) — swaps paused`,
        priceBtc,
        deviationBps
      };
    }
    return {
      ok: true,
      priceBtc,
      deviationBps,
      priceRaw: answer,
      priceDecimals: decimals
    };
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

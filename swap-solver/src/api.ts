/**
 * Solver HTTP API — the thin backend the /swap UI talks to.
 *
 * The solver remains the SINGLE SOURCE OF TRUTH for order state; the UI is a
 * dumb client that (1) asks for a quote, (2) signs + submits the Permit2
 * openFor, (3) polls order status. No chain logic lives in the browser beyond
 * signing.
 *
 * Endpoints
 *   GET  /health              → liveness + float + masked config
 *   POST /quote               → { user, wbtcAmount, cantonParty }
 *                               → { orderId, order, permit2TypedData, ... }
 *   POST /orders              → { order, signature, cantonParty }
 *                               → submits openFor on Base, registers the order
 *   GET  /orders/:orderId     → the order record (status the UI polls)
 *   GET  /orders              → recent orders (for a simple activity view)
 *
 * Built on Node's stdlib http (no new deps). CORS is permissive for local dev;
 * lock it down before exposing beyond localhost.
 *
 * SECURITY: this server holds NO secrets in its responses. It uses the agent key
 * only to SUBMIT openFor (a permissionless call — the user's signature is what
 * authorizes the pull). It never exposes keys, never signs on the user's behalf,
 * and binds the cantonParty preimage to the on-chain recipient hash before
 * storing (rejects a mismatch).
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  createWalletClient, createPublicClient, http as viemHttp, getContract,
  type Account, type Address, type Hex,
} from "viem";

import { makeNetworkConfig, type SwapNetworkConfig } from "./config.js";
import { buildOrder, verifyCantonParty, type SwapRequest } from "./order.js";
import { buildOpenForTypedData } from "./open-for.js";
import { ESCROW_ABI } from "./abi.js";
import { OrderStore, type OrderRecord, type SerializedOrder } from "./store.js";
import { serializeOrder, deserializeOrder } from "./convert.js";
import { refundOrder, type RefundDeps } from "./refund.js";
import { CantonClient } from "./canton.js";
import { resolveDelivery } from "./accept-watch.js";
import type { DepegStatus } from "./depeg.js";

export interface ApiDeps {
  cfg: SwapNetworkConfig;
  store: OrderStore;
  canton: CantonClient;
  /** Origin-chain RPC + the agent account that SUBMITS openFor. */
  rpcUrl: string;
  agentAccount: Account;
  chain: { id: number; name: string };
  /** bytes32 instrument id used as MandateOutput.token (opaque on EVM side). */
  cbtcToken: Hex;
  /** Hard ceiling on WBTC per order (base units, 8dp). 0n = no cap. */
  maxWbtcPerOrder: bigint;
  /**
   * Solver fee in basis points (1 bps = 0.01%). The quote is:
   *   cbtcOut = wbtcAmount × (WBTC/BTC price) × (10000 − feeBps) / 10000.
   * cBTC is redeemable 1:1 for BTC, so the rate is the live WBTC/BTC price (NOT a
   * flat 1:1 — WBTC trades slightly off par). When no de-peg feed is configured,
   * price falls back to par (1.0). The fee is the solver's cut for fronting
   * liquidity + bearing settlement risk; floor division → never overpays the user.
   */
  feeBps: number;
  /**
   * Optional de-peg circuit breaker. When set, `/quote` is rejected (and `/health`
   * reports paused) if WBTC de-pegs from BTC beyond the configured threshold —
   * because the 1:1 quote is only valid while the peg holds. Undefined = disabled.
   */
  depegGuard?: { check(nowSeconds: number): Promise<DepegStatus> };
}

/** JSON helpers that don't choke on bigint. */
function jsonReplacer(_k: string, v: unknown): unknown {
  return typeof v === "bigint" ? v.toString() : v;
}
// SECURITY (HIGH-4): CORS origin is configurable. Defaults to "*" for local dev
// (the API is loopback-bound, so cross-origin browser calls only come from the
// local UI), but a real deployment MUST set API_CORS_ORIGIN to the exact UI
// origin so a malicious site can't script the user's browser against the API.
const CORS_ORIGIN = process.env.API_CORS_ORIGIN ?? "*";
function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, jsonReplacer);
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": CORS_ORIGIN,
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  });
  res.end(payload);
}
// SECURITY (CoW DoS benchmark): tight body cap. The largest legitimate body is a
// signed order, well under 8 KiB; CoW caps at 16 KiB. We use 16 KiB.
const MAX_BODY_BYTES = 16 * 1024;

/**
 * Per-IP token-bucket rate limiter (CoW has a rate-limiter + sim timeout +
 * request-sharing; we lacked any throttle — the one real off-chain DoS GAP).
 * Refills `RATE_RPS` tokens/sec up to `RATE_BURST`. Cheap, in-memory, no deps.
 * Configurable via API_RATE_RPS / API_RATE_BURST; set API_RATE_RPS=0 to disable.
 */
const RATE_RPS = Number(process.env.API_RATE_RPS ?? 10);
const RATE_BURST = Number(process.env.API_RATE_BURST ?? 30);
const buckets = new Map<string, { tokens: number; ts: number }>();
function rateLimitOk(ip: string, nowMs: number): boolean {
  if (RATE_RPS <= 0) return true; // disabled
  const b = buckets.get(ip) ?? { tokens: RATE_BURST, ts: nowMs };
  // Refill since last seen.
  const refill = ((nowMs - b.ts) / 1000) * RATE_RPS;
  b.tokens = Math.min(RATE_BURST, b.tokens + refill);
  b.ts = nowMs;
  if (b.tokens < 1) {
    buckets.set(ip, b);
    return false;
  }
  b.tokens -= 1;
  buckets.set(ip, b);
  // Opportunistic cleanup so the map can't grow unbounded.
  if (buckets.size > 10_000) {
    for (const [k, v] of buckets) if (nowMs - v.ts > 60_000) buckets.delete(k);
  }
  return true;
}
function clientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? "unknown";
}
function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > MAX_BODY_BYTES) reject(new ApiError(413, "request body too large"));
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error("invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

/** Parse a positive bigint from a string|number, or throw a 400-friendly error. */
function parseAmount(v: unknown, field: string): bigint {
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) return BigInt(v);
  throw new ApiError(400, `${field} must be a non-negative integer (base units), got ${JSON.stringify(v)}`);
}

class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function createApi(deps: ApiDeps) {
  const { cfg, store, canton, rpcUrl, agentAccount, chain, cbtcToken, maxWbtcPerOrder, feeBps, depegGuard } = deps;
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps >= 10000) {
    throw new Error(`feeBps must be an integer in [0, 10000), got ${feeBps}`);
  }
  const account = agentAccount;
  const pub = createPublicClient({ transport: viemHttp(rpcUrl) });
  const wallet = createWalletClient({ account, transport: viemHttp(rpcUrl) });

  // Intake validity bounds (CoW OrderValidPeriodConfiguration analogue). A
  // submitted order's fillDeadline must leave at least this margin (so we can
  // actually deliver+settle), and not exceed the max lock window. Derived from
  // the configured windows so they stay consistent with what /quote builds.
  const minFillDeadlineMargin = Math.max(60, Math.floor(cfg.fillDeadlineSeconds / 3));
  const maxOrderValiditySeconds = cfg.expiresSeconds + 5 * 60; // a little slack over the quote window

  async function handleQuote(body: Record<string, unknown>) {
    // DE-PEG CIRCUIT BREAKER + LIVE PRICE: read the WBTC/BTC feed once. It (a)
    // pauses swaps on a de-peg (fail-closed), and (b) gives the live WBTC price in
    // BTC, which we use to PRICE the quote — WBTC trades slightly off 1 BTC
    // (e.g. 0.9978), so we must NOT quote a flat 1:1. cBTC is redeemable 1:1 BTC,
    // so the WBTC→cBTC rate = WBTC/BTC price.
    //   priceRaw / 10^priceDecimals = WBTC in BTC (e.g. 99775000 / 1e8 = 0.99775).
    // Default to par (1.0) only when the de-peg guard is disabled (no feed).
    let priceRaw = 100_000_000n; // 1.0 scaled to 8dp (par fallback when no feed)
    let priceDecimals = 8;
    if (depegGuard) {
      const peg = await depegGuard.check(nowSeconds());
      if (!peg.ok) {
        throw new ApiError(503, `swaps paused: ${peg.reason}`);
      }
      priceRaw = peg.priceRaw;
      priceDecimals = peg.priceDecimals;
    }
    const user = body.user as Address;
    if (typeof user !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(user)) {
      throw new ApiError(400, "user must be a 0x EVM address");
    }
    const cantonParty = body.cantonParty;
    if (typeof cantonParty !== "string" || !cantonParty.includes("::")) {
      throw new ApiError(400, "cantonParty must be a full Canton party id (contains '::')");
    }
    const wbtcAmount = parseAmount(body.wbtcAmount, "wbtcAmount");
    if (wbtcAmount === 0n) throw new ApiError(400, "wbtcAmount must be > 0");
    if (maxWbtcPerOrder > 0n && wbtcAmount > maxWbtcPerOrder) {
      // Human-readable (WBTC units) — this can surface in the UI, so no raw base
      // units. The frontend also pre-validates against /health's cap, so this is
      // a defense-in-depth backstop.
      const capBtc = (Number(maxWbtcPerOrder) / 1e8).toFixed(8).replace(/\.?0+$/, "");
      throw new ApiError(400, `Amount exceeds the per-swap limit of ${capBtc} WBTC`);
    }
    // QUOTE = wbtcAmount × (WBTC/BTC price) × (1 − feeBps). All BigInt, floor
    // division at each step → the user NEVER gets more than the true value
    // (no overpay) and the fee is exact. cBTC = 1 BTC (redeemable), so the only
    // price adjustment is WBTC's deviation from 1 BTC.
    const priceScale = 10n ** BigInt(priceDecimals);
    const cbtcAtPrice = (wbtcAmount * priceRaw) / priceScale; // WBTC value in BTC = cBTC before fee
    const cbtcAmount = (cbtcAtPrice * BigInt(10000 - feeBps)) / 10000n;
    if (cbtcAmount === 0n) {
      throw new ApiError(400, `amount too small after price + ${feeBps}bps fee (cBTC out rounds to 0)`);
    }

    const req: SwapRequest = {
      user, wbtcAmount, cbtcAmount, cantonParty, cbtcToken,
      nonce: BigInt(nowSeconds()),
    };
    const built = buildOrder(cfg, req, nowSeconds());

    // NOTE: we deliberately do NOT persist anything here (SECURITY: MED-1).
    // /quote is unauthenticated; writing to the store on every quote let an
    // attacker flood the on-disk recovery map. The cantonParty recovery is
    // instead written in /orders (handleCreateOrder) as part of the write-ahead,
    // BEFORE the irreversible openFor — so the crash-recovery guarantee is
    // preserved, but only ONE entry is ever written per real on-chain order.
    const typed = buildOpenForTypedData({ order: built.order, escrow: cfg.escrow, chainId: cfg.originChainId });

    return {
      orderId: built.orderId,
      order: serializeOrder(built.order),
      cantonParty,
      cbtcAmount: cbtcAmount.toString(),
      feeBps,
      // The live WBTC/BTC price used for this quote (scaled to wbtcPriceDecimals),
      // so the UI can show the REAL rate (1 WBTC = <price> CBTC), not a fake 1:1.
      wbtcPriceRaw: priceRaw.toString(),
      wbtcPriceDecimals: priceDecimals,
      // Everything the browser wallet needs to sign the Permit2 witness.
      permit2: {
        domain: typed.domain,
        types: typed.types,
        primaryType: typed.primaryType,
        message: typed.message,
      },
      escrow: cfg.escrow,
      wbtc: cfg.wbtc,
      expires: built.order.expires,
      fillDeadline: built.order.fillDeadline,
    };
  }

  async function handleCreateOrder(body: Record<string, unknown>) {
    const rawSig = body.signature as Hex;
    if (typeof rawSig !== "string" || !rawSig.startsWith("0x")) {
      throw new ApiError(400, "signature (0x-prefixed) is required");
    }
    // The escrow's openFor reads the FIRST byte of the signature to select the
    // verification scheme (SIGNATURE_TYPE_PERMIT2 = 0x00). A browser wallet's
    // eth_signTypedData_v4 returns a RAW 65-byte ECDSA signature (132 hex chars)
    // with no type byte → the escrow reverts SignatureNotSupported. So we prepend
    // 0x00 here. If a client already prefixed it (66 bytes), leave it untouched.
    const sigHexLen = rawSig.length - 2; // strip "0x"
    const sig: Hex =
      sigHexLen === 130 ? (`0x00${rawSig.slice(2)}` as Hex) // raw 65-byte sig → add Permit2 type byte
      : rawSig;                                              // already typed (e.g. CLI) — leave as-is
    const cantonParty = body.cantonParty;
    if (typeof cantonParty !== "string" || !cantonParty.includes("::")) {
      throw new ApiError(400, "cantonParty is required");
    }
    const sorder = body.order as SerializedOrder | undefined;
    if (!sorder || !Array.isArray(sorder.outputs) || sorder.outputs.length === 0) {
      throw new ApiError(400, "order (serialized StandardOrder) is required");
    }
    const order = deserializeOrder(sorder);

    // SECURITY: the cantonParty preimage MUST hash to the order's committed
    // recipient. Reject a mismatch so a caller can't bind a redirected party.
    const out0 = sorder.outputs[0];
    if (!out0) throw new ApiError(400, "order has no output");
    if (!verifyCantonParty(cantonParty, out0.recipient)) {
      throw new ApiError(400, "cantonParty does not match the order's recipient commitment");
    }

    // INTAKE VALIDATION — benchmarked against CoW's OrderValidPeriodConfiguration
    // .validate_period (services/crates/shared/src/order_validation.rs). CoW
    // rejects an order at POST time if validTo is too soon (can't be filled) or
    // too far (absurd). We do the same BEFORE the irreversible openFor, so a
    // malformed order can't lock the user's WBTC only to immediately fail the
    // delivery guard and need a refund. Our windows: fillDeadline must leave
    // enough margin to deliver+accept+settle; expires must be > fillDeadline and
    // not absurdly far out.
    {
      const now = nowSeconds();
      const fillDeadline = sorder.fillDeadline;
      const expires = sorder.expires;
      // CoW: too-soon → Insufficient. We need at least the delivery margin left.
      if (fillDeadline - now < minFillDeadlineMargin) {
        throw new ApiError(
          400,
          `order fillDeadline too soon: ${fillDeadline - now}s left, need ≥ ${minFillDeadlineMargin}s`,
        );
      }
      // CoW: too-far → Excessive. Cap the lock window so a bad client can't lock
      // WBTC for an unreasonable time.
      if (fillDeadline - now > maxOrderValiditySeconds) {
        throw new ApiError(
          400,
          `order fillDeadline too far: ${fillDeadline - now}s, max ${maxOrderValiditySeconds}s`,
        );
      }
      // The escrow invariant the whole settlement relies on: expires > fillDeadline
      // (the user's refund window must open only after the fill window closes).
      if (!(fillDeadline < expires)) {
        throw new ApiError(400, "order invariant violated: fillDeadline must be < expires");
      }
    }

    const escrowC = getContract({ address: cfg.escrow, abi: ESCROW_ABI, client: wallet });
    const orderId = (await escrowC.read.orderIdentifier([order])) as Hex;

    const existing = store.get(orderId);
    if (existing) {
      // Idempotent: already registered (UI retried). Return current state.
      return { orderId, status: existing.status, alreadyRegistered: true };
    }

    // WRITE-AHEAD: persist the order + cantonParty BEFORE submitting openFor.
    // openFor is IRREVERSIBLE (it pulls + locks the user's WBTC). If we submitted
    // first and the process died (crash / restart / dropped connection) before the
    // store write, the WBTC would be locked on-chain with NO record of the
    // cantonParty preimage — and since the chain only commits keccak256(party),
    // that preimage would be unrecoverable and the order could never be delivered
    // (only refunded). Recording first means a crash leaves a recoverable record:
    // the order is in the store WITH its cantonParty; the watcher/loop reconciles
    // its true on-chain status (Deposited) on the next tick and proceeds. The
    // openBlock is backfilled below once openFor mines.
    store.insertSeen(orderId, 0, sorder);
    store.update(orderId, { cantonParty, note: "registered; submitting openFor" });
    // Recovery map (MED-1): one entry per REAL order, written here (not at /quote)
    // so the unauthenticated /quote can't flood it. Lets the delivery path recover
    // the party if the record is ever lost (e.g. watcher-discovered order).
    store.rememberParty(orderId, cantonParty);

    // Submit openFor on the origin chain. The user's signature authorizes the
    // WBTC pull; the agent only pays gas to submit (permissionless).
    let openTx: Hex;
    try {
      openTx = await escrowC.write.openFor([order, order.user, sig], { account, chain: null });
      await pub.waitForTransactionReceipt({ hash: openTx });
    } catch (e) {
      // openFor failed (reverted, or we lost the receipt). The record stays so the
      // failure is visible and recoverable, but mark it so the loop doesn't try to
      // deliver against a lock that may not exist. If openFor actually reverted, no
      // WBTC was locked; if the receipt was merely lost, the next reconcile tick
      // reads the real on-chain status. Surface the error to the UI either way.
      store.update(orderId, { note: `openFor submit error: ${e instanceof Error ? e.message : e}` });
      throw new ApiError(502, `openFor submission failed: ${e instanceof Error ? e.message : e}`);
    }

    // openFor mined — record the block (best-effort) and keep status `seen`.
    const blockNumber = await pub.getBlockNumber().catch(() => 0n);
    store.update(orderId, { openBlock: Number(blockNumber), note: `openFor ${openTx}` });

    console.log(`[api] order ${orderId.slice(0, 12)}… registered + openFor ${openTx.slice(0, 12)}… (WBTC locked)`);
    return { orderId, status: "seen", openTx };
  }

  /**
   * POST /orders/:orderId/refund — return the locked WBTC to the user after the
   * order has expired without finalising. refund() is PERMISSIONLESS (the escrow
   * always sends inputs to order.user), so the solver can submit it on the user's
   * behalf — the funds go to the user regardless of who pays gas. Safe by design.
   */
  /**
   * POST /orders/:orderId/accepted — ADVISORY hint that the user's app saw the
   * cBTC delivery resolve. This endpoint is UNAUTHENTICATED, so its body is NOT
   * trusted to change order state (SECURITY: HIGH-2/HIGH-3). It only triggers an
   * immediate AUTHORITATIVE re-check via `resolveDelivery` — the exact same
   * on-ledger verification the watch loop runs — which advances `delivering →
   * delivered` ONLY if the solver's OWN ACS confirms the accept actually
   * happened. A malicious caller cannot:
   *   - force a finalise: `completed` does nothing unless the ledger shows the
   *     accept (a `delivering` order whose offer is still pending stays pending);
   *   - grief into `failed`: we never mark `failed` off a request body; the
   *     ledger check decides. (A genuine reject is detected by the watch loop and
   *     the order self-heals via the auto-refund sweep.)
   * The endpoint just makes the happy path feel instant; correctness comes
   * entirely from the on-ledger re-check, never from the caller.
   */
  async function handleAccepted(orderId: Hex, _body: Record<string, unknown>) {
    store.reload();
    const rec = store.get(orderId);
    if (!rec) throw new ApiError(404, "order not found");
    if (rec.status === "finalised" || rec.status === "refunded" || rec.status === "failed") {
      return { orderId, status: rec.status, alreadyTerminal: true };
    }
    // Authoritative re-check (ignores the request body entirely). Only advances
    // the order if the solver's own ledger view confirms the accept.
    await resolveDelivery(store, canton, orderId, { now: nowSeconds(), fromOffset: 0 }).catch(
      () => undefined,
    );
    const updated = store.get(orderId);
    return { orderId, status: updated?.status ?? rec.status };
  }

  // Shared refund deps — the same logic the watch loop's auto-refund sweep uses,
  // so on-demand and automatic refunds behave identically.
  const refundDeps: RefundDeps = { store, escrow: cfg.escrow, wallet, account, pub };

  async function handleRefund(orderId: Hex) {
    store.reload();
    const rec = store.get(orderId);
    if (!rec) throw new ApiError(404, "order not found");

    const outcome = await refundOrder(rec, refundDeps, nowSeconds());
    switch (outcome.kind) {
      case "refunded":
        return { orderId, status: "refunded", refundTx: outcome.refundTx };
      case "alreadyRefunded":
        return { orderId, status: "refunded", alreadyRefunded: true };
      case "alreadyFinalised":
        throw new ApiError(409, "order already finalised — nothing to refund");
      case "notYet":
        throw new ApiError(425, `not yet refundable — expires in ${outcome.secondsLeft}s`);
      case "error":
        throw new ApiError(502, `refund submission failed: ${outcome.message}`);
    }
  }

  async function handleHealth() {
    let floatSats: string | null = null;
    let floatError: string | null = null;
    try {
      floatSats = (await canton.getFloatSats()).toString();
    } catch (e) {
      floatError = e instanceof Error ? e.message : String(e);
    }
    // De-peg status — so ops/UI can see if swaps are paused and why.
    let depeg: { paused: boolean; priceBtc?: number; deviationBps?: number; reason?: string } | null = null;
    if (depegGuard) {
      const peg = await depegGuard.check(nowSeconds());
      depeg = peg.ok
        ? { paused: false, priceBtc: peg.priceBtc, deviationBps: peg.deviationBps }
        : { paused: true, priceBtc: peg.priceBtc, deviationBps: peg.deviationBps, reason: peg.reason };
    }
    return {
      ok: true,
      network: cfg.network,
      chain: chain.name,
      escrow: cfg.escrow,
      oracle: cfg.oracle,
      wbtc: cfg.wbtc,
      agent: account.address,
      maxWbtcPerOrder: maxWbtcPerOrder.toString(),
      feeBps,
      floatSats,
      floatError,
      depeg,
    };
  }

  const server = createServer((req, res) => {
    void route(req, res).catch((e) => {
      if (e instanceof ApiError) return send(res, e.status, { error: e.message });
      send(res, 500, { error: e instanceof Error ? e.message : "internal error" });
    });
  });

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (method === "OPTIONS") return send(res, 204, {});

    // SECURITY: per-IP rate limit on everything except /health (which monitors
    // poll). Cheap in-memory token bucket; the one real off-chain DoS gap vs CoW.
    if (path !== "/health" && !rateLimitOk(clientIp(req), Date.now())) {
      return send(res, 429, { error: "rate limit exceeded — slow down" });
    }

    // Request log: write paths and errors are the ones we care about; GET /orders
    // polling would spam, so only log the meaningful actions + any non-2xx.
    const logReq = method !== "GET";
    if (logReq) console.log(`[api] ${method} ${path}`);

    if (method === "GET" && path === "/health") return send(res, 200, await handleHealth());

    if (method === "POST" && path === "/quote") {
      const body = (await readBody(req)) as Record<string, unknown>;
      return send(res, 200, await handleQuote(body));
    }

    if (method === "POST" && path === "/orders") {
      const body = (await readBody(req)) as Record<string, unknown>;
      return send(res, 201, await handleCreateOrder(body));
    }

    // NOTE (SECURITY: HIGH-4): the global `GET /orders` list endpoint was REMOVED.
    // It returned every recent order's id, full cantonParty preimage, and amounts
    // to any anonymous caller — an information leak AND the enumeration primitive
    // that made other attacks turnkey. No UI path used it (the UI tracks a single
    // order by id via GET /orders/:id). An authenticated admin/activity view, if
    // ever needed, must be gated + scoped to the caller's own orders.

    const m = path.match(/^\/orders\/(0x[0-9a-fA-F]{64})$/);
    if (method === "GET" && m) {
      // Reload so the UI sees status advanced by the loop (seen→…→finalised).
      store.reload();
      const rec = store.get(m[1] as Hex);
      if (!rec) return send(res, 404, { error: "order not found" });
      return send(res, 200, publicOrder(rec));
    }

    const r = path.match(/^\/orders\/(0x[0-9a-fA-F]{64})\/refund$/);
    if (method === "POST" && r) {
      return send(res, 200, await handleRefund(r[1] as Hex));
    }

    // The user's app reports the cBTC delivery outcome (from their Loop history).
    const ac = path.match(/^\/orders\/(0x[0-9a-fA-F]{64})\/accepted$/);
    if (method === "POST" && ac) {
      const body = (await readBody(req)) as Record<string, unknown>;
      return send(res, 200, await handleAccepted(ac[1] as Hex, body));
    }

    return send(res, 404, { error: `no route for ${method} ${path}` });
  }

  return server;
}

/** Project an OrderRecord to a UI-safe shape (no internal-only churn). */
// The fields the UI tracking view needs, and only those. SECURITY (HIGH-4): we
// do NOT echo the full cantonParty preimage — the order is only reachable by
// someone who knows its 64-hex id (the user's own order), and the UI already
// holds the party from the quote. `note` is kept (the user's own failure reason,
// shown in the UI). The global list endpoint that leaked these across all users
// was removed.
function publicOrder(rec: OrderRecord) {
  return {
    orderId: rec.orderId,
    status: rec.status,
    cbtcAmount: rec.order.outputs[0]?.amount,
    wbtcAmount: rec.order.inputs[0]?.[1],
    fillDeadline: rec.order.fillDeadline,
    expires: rec.order.expires,
    fillTimestamp: rec.fillTimestamp,
    attestTxHash: rec.attestTxHash,
    finaliseTxHash: rec.finaliseTxHash,
    note: rec.note,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
  };
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Network config helper re-export so callers don't import config separately. */
export { makeNetworkConfig };

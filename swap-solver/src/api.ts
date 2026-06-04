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
import { allOrders } from "./monitor.js";
import { CantonClient } from "./canton.js";

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
   * Solver fee in basis points (1 bps = 0.01%). The user receives
   * cbtcOut = wbtcIn * (10000 - feeBps) / 10000. 0 = clean 1:1 (no fee).
   * WBTC and cBTC are both 1:1-backed claims on BTC, so par is the baseline;
   * the fee is the solver's cut for fronting liquidity + bearing settlement risk.
   */
  feeBps: number;
}

/** JSON helpers that don't choke on bigint. */
function jsonReplacer(_k: string, v: unknown): unknown {
  return typeof v === "bigint" ? v.toString() : v;
}
function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, jsonReplacer);
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  });
  res.end(payload);
}
function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 1_000_000) reject(new Error("body too large"));
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
  const { cfg, store, canton, rpcUrl, agentAccount, chain, cbtcToken, maxWbtcPerOrder, feeBps } = deps;
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps >= 10000) {
    throw new Error(`feeBps must be an integer in [0, 10000), got ${feeBps}`);
  }
  const account = agentAccount;
  const pub = createPublicClient({ transport: viemHttp(rpcUrl) });
  const wallet = createWalletClient({ account, transport: viemHttp(rpcUrl) });

  async function handleQuote(body: Record<string, unknown>) {
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
      throw new ApiError(400, `wbtcAmount ${wbtcAmount} exceeds per-order cap ${maxWbtcPerOrder}`);
    }
    // WBTC and cBTC are both 1:1-backed claims on BTC (both 8dp), so par is the
    // baseline rate. The solver fee (feeBps) is subtracted from the cBTC the user
    // receives. floor division → never overpays the user. feeBps=0 → clean 1:1.
    const cbtcAmount = (wbtcAmount * BigInt(10000 - feeBps)) / 10000n;
    if (cbtcAmount === 0n) {
      throw new ApiError(400, `amount too small after ${feeBps}bps fee (cBTC out rounds to 0)`);
    }

    const req: SwapRequest = {
      user, wbtcAmount, cbtcAmount, cantonParty, cbtcToken,
      nonce: BigInt(nowSeconds()),
    };
    const built = buildOrder(cfg, req, nowSeconds());

    const typed = buildOpenForTypedData({ order: built.order, escrow: cfg.escrow, chainId: cfg.originChainId });

    return {
      orderId: built.orderId,
      order: serializeOrder(built.order),
      cantonParty,
      cbtcAmount: cbtcAmount.toString(),
      feeBps,
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

    const escrowC = getContract({ address: cfg.escrow, abi: ESCROW_ABI, client: wallet });
    const orderId = (await escrowC.read.orderIdentifier([order])) as Hex;

    const existing = store.get(orderId);
    if (existing) {
      // Idempotent: already registered (UI retried). Return current state.
      return { orderId, status: existing.status, alreadyRegistered: true };
    }

    // Submit openFor on Base. The user's signature authorizes the WBTC pull;
    // the agent only pays gas to submit (permissionless).
    let openTx: Hex;
    try {
      openTx = await escrowC.write.openFor([order, order.user, sig], { account, chain: null });
      await pub.waitForTransactionReceipt({ hash: openTx });
    } catch (e) {
      throw new ApiError(502, `openFor submission failed: ${e instanceof Error ? e.message : e}`);
    }

    // Register in the store so the solver loop picks it up. Record the openBlock
    // best-effort; the watcher would also catch it, but registering here makes
    // the UI's order visible immediately.
    const blockNumber = await pub.getBlockNumber().catch(() => 0n);
    store.insertSeen(orderId, Number(blockNumber), sorder);
    store.update(orderId, { cantonParty, note: `openFor ${openTx}` });

    return { orderId, status: "seen", openTx };
  }

  /**
   * POST /orders/:orderId/refund — return the locked WBTC to the user after the
   * order has expired without finalising. refund() is PERMISSIONLESS (the escrow
   * always sends inputs to order.user), so the solver can submit it on the user's
   * behalf — the funds go to the user regardless of who pays gas. Safe by design.
   */
  async function handleRefund(orderId: Hex) {
    store.reload();
    const rec = store.get(orderId);
    if (!rec) throw new ApiError(404, "order not found");
    if (rec.status === "finalised") throw new ApiError(409, "order already finalised — nothing to refund");
    if (rec.status === "refunded") return { orderId, status: "refunded", alreadyRefunded: true };

    const now = nowSeconds();
    if (now <= rec.order.expires) {
      throw new ApiError(425, `not yet refundable — expires in ${rec.order.expires - now}s`);
    }

    const order = deserializeOrder(rec.order);
    const escrowC = getContract({ address: cfg.escrow, abi: ESCROW_ABI, client: wallet });

    // If it was already claimed on-chain by a late finalise, don't try to refund.
    const onchain = Number(await escrowC.read.orderStatus([orderId]));
    if (onchain === 2 /* Claimed */) {
      store.update(orderId, { status: "finalised", note: "claimed on-chain (late finalise)" });
      throw new ApiError(409, "order was finalised on-chain — not refundable");
    }
    if (onchain === 3 /* Refunded */) {
      store.update(orderId, { status: "refunded", note: "already refunded on-chain" });
      return { orderId, status: "refunded", alreadyRefunded: true };
    }

    let refundTx: Hex;
    try {
      refundTx = await escrowC.write.refund([order], { account, chain: null });
      await pub.waitForTransactionReceipt({ hash: refundTx });
    } catch (e) {
      throw new ApiError(502, `refund submission failed: ${e instanceof Error ? e.message : e}`);
    }

    store.update(orderId, { status: "refunded", note: `refund ${refundTx}` });
    return { orderId, status: "refunded", refundTx };
  }

  async function handleHealth() {
    let floatSats: string | null = null;
    let floatError: string | null = null;
    try {
      floatSats = (await canton.getFloatSats()).toString();
    } catch (e) {
      floatError = e instanceof Error ? e.message : String(e);
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
      floatSats,
      floatError,
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

    if (method === "GET" && path === "/health") return send(res, 200, await handleHealth());

    if (method === "POST" && path === "/quote") {
      const body = (await readBody(req)) as Record<string, unknown>;
      return send(res, 200, await handleQuote(body));
    }

    if (method === "POST" && path === "/orders") {
      const body = (await readBody(req)) as Record<string, unknown>;
      return send(res, 201, await handleCreateOrder(body));
    }

    if (method === "GET" && path === "/orders") {
      // Re-read from disk: the solver LOOP process advances order state on disk;
      // this API process must reload or it serves a stale snapshot.
      store.reload();
      const recent = allOrders(store)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .slice(0, 50)
        .map(publicOrder);
      return send(res, 200, { orders: recent });
    }

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

    return send(res, 404, { error: `no route for ${method} ${path}` });
  }

  return server;
}

/** Project an OrderRecord to a UI-safe shape (no internal-only churn). */
function publicOrder(rec: OrderRecord) {
  return {
    orderId: rec.orderId,
    status: rec.status,
    cantonParty: rec.cantonParty,
    cbtcAmount: rec.order.outputs[0]?.amount,
    wbtcAmount: rec.order.inputs[0]?.[1],
    fillDeadline: rec.order.fillDeadline,
    expires: rec.order.expires,
    fillTimestamp: rec.fillTimestamp,
    cantonDeliveryRef: rec.cantonDeliveryRef,
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

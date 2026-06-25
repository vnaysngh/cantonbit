/**
 * Frontend client for the /api/htlc/* endpoints + the EVM/Loop actions.
 * Keeps the page component lean. The SECRET never leaves the browser until the
 * user reveals it at claim-counter.
 */
import { keccak_256 } from "@noble/hashes/sha3";

import {
  encodeApprove,
  encodeLock,
  encodeClaim,
  encodeRetake
} from "./htlc-evm-encode";
import { getBrowserEvmProvider, waitForEvmReceipt } from "./evm-wait-receipt";
import { htlcForwardLoopDeliveryProven } from "./swap-product-invariants";
import { getSwapErrorMessage, isTransientEvmFinalityError } from "./swap-api";

export interface HtlcOrderInput {
  id: string;
  direction: "evm-to-canton" | "canton-to-evm";
  hashLock: string;
  userTimelock: number;
  userCantonParty: string;
  solverCantonParty: string;
  solverTimelock: number;
  /** Cross-chain EVM leg fields */
  userEvmAddress?: string;
  solverEvmAddress?: string;
  wbtcAmount?: string;
  cbtcAmount?: string;
  /** "managed" (email, on-ledger HtlcLock) | "loop" (standard transfer + accept). */
  counterMode?: "managed" | "loop";
}

const bytesToHex = (b: Uint8Array) =>
  "0x" +
  Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");

/** Generate a 32-byte secret + its keccak256 hashLock (over the raw bytes).
 *  `randomBytes` is injected for testability; defaults to Web Crypto. */
export function generateSecret(
  randomBytes: (n: number) => Uint8Array = (n) => {
    const raw = new Uint8Array(n);
    (globalThis.crypto as Crypto).getRandomValues(raw);
    return raw;
  },
): { secret: string; hashLock: string } {
  const raw = randomBytes(32);
  if (raw.length !== 32) throw new Error("secret must be 32 bytes");
  const secret = bytesToHex(raw);
  const hashLock = bytesToHex(keccak_256(raw));
  return { secret, hashLock };
}

/** The canton/claim preimage form: lowercase hex of the secret, no 0x. */
export function secretToPreimage(secret: string): string {
  return (secret.startsWith("0x") ? secret.slice(2) : secret).toLowerCase();
}

// --- API calls ---
async function jpost(url: string, body?: unknown) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `POST ${url} failed (${r.status})`);
  return j;
}
async function jget(url: string, opts?: { signal?: AbortSignal }) {
  const r = await fetch(url, { signal: opts?.signal, cache: "no-store" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `GET ${url} failed (${r.status})`);
  return j;
}

/** Merge swap history when session party and Loop party differ (dual-login users). */
export async function fetchMergedSwapHistory(opts: {
  sessionAuthed: boolean;
  sessionParty: string | null;
  loopParty: string | null;
  /** When set, email-session history hides other wallets + never-started drafts. */
  userEvmAddress?: string | null;
}): Promise<{ orders: unknown[] }> {
  const urls: string[] = [];
  const evmQ = opts.userEvmAddress
    ? `&evm=${encodeURIComponent(opts.userEvmAddress)}`
    : "";
  if (opts.sessionAuthed && opts.sessionParty) urls.push(`/api/htlc/history?party=${encodeURIComponent(opts.sessionParty)}${evmQ}`);
  if (opts.loopParty && opts.loopParty !== opts.sessionParty) {
    urls.push(`/api/htlc/history?party=${encodeURIComponent(opts.loopParty)}`);
  }
  if (urls.length === 0) urls.push("/api/htlc/history");

  const results = await Promise.allSettled(urls.map((u) => jget(u)));
  const merged = new Map<string, unknown>();
  let lastError: Error | null = null;
  for (const result of results) {
    if (result.status === "rejected") {
      lastError =
        result.reason instanceof Error
          ? result.reason
          : new Error(String(result.reason));
      continue;
    }
    for (const o of (result.value.orders ?? []) as { id: string }[]) {
      merged.set(o.id, o);
    }
  }
  if (merged.size === 0 && lastError) throw lastError;
  const orders = [...merged.values()].sort(
    (a, b) =>
      (b as { createdAt: number }).createdAt -
      (a as { createdAt: number }).createdAt
  );
  return { orders };
}

export const htlcApi = {
  createOrder: (o: HtlcOrderInput) => jpost("/api/htlc", o),
  // RFQ quote (both directions, live WBTC/BTC price, 60s TTL, de-peg breaker).
  quoteReverse: (
    user: string,
    cbtcUnits: string,
    cantonParty: string
  ): Promise<{ wbtcAmount: string; wbtcPriceRaw: string; expires: number }> =>
    jpost("/api/htlc/quote", {
      user,
      cbtcAmount: cbtcUnits,
      cantonParty,
      direction: "canton-to-evm"
    }),
  getOrder: (
    id: string,
    opts?: { light?: boolean; signal?: AbortSignal }
  ) =>
    jget(`/api/htlc/${id}${opts?.light ? "?light=1" : ""}`, {
      signal: opts?.signal
    }),
  accept: (id: string) => jpost(`/api/htlc/${id}/accept`),
  recordMainLock: (id: string, mainLockTx: string) =>
    jpost(`/api/htlc/${id}/main-lock`, { mainLockTx }),
  // REVERSE (canton-to-evm): backend locks the user's CBTC on-ledger (CanActAs).
  lockMain: (id: string) => jpost(`/api/htlc/${id}/lock-main`),
  refundMain: (id: string) => jpost(`/api/htlc/${id}/refund-main`),
  // LOOP SELLER (canton-to-evm, external wallet): the user locks via the STANDARD
  // AllocationFactory_Allocate signed in their wallet; backend verifies on-ledger.
  prepareLockLoop: (
    id: string,
    holdingCids: string[]
  ): Promise<{
    command: unknown;
    disclosedContracts: unknown[];
    synchronizerId: string;
  }> => jpost(`/api/htlc/${id}/prepare-lock-loop`, { holdingCids }),
  confirmLockLoop: (
    id: string,
    opts?: { maxAttempts?: number; pollMs?: number }
  ) => jpost(`/api/htlc/${id}/confirm-lock-loop`, opts),
  lockCounter: (id: string) => jpost(`/api/htlc/${id}/lock-counter`),
  // Loop reveal+deliver. delivered=true → the CBTC auto-accepted (preapproval) and
  // there is NOTHING to accept — skip the wallet popup entirely.
  claimCounter: (
    id: string,
    preimage: string
  ): Promise<{ order: unknown; updateId: string; delivered: boolean }> =>
    jpost(`/api/htlc/${id}/claim-counter`, { preimage }),
  // LOOP standard accept (user signs a STANDARD TransferInstruction_Accept in their
  // wallet — no custom DAR). Then record the revealed preimage so the solver claims WBTC.
  prepareAccept: (
    id: string
  ): Promise<{
    command: unknown;
    disclosedContracts: unknown[];
    synchronizerId: string;
  }> => jpost(`/api/htlc/${id}/prepare-accept`),
  recordClaim: (id: string, preimage: string, updateId: string) =>
    jpost(`/api/htlc/${id}/claim-record`, { preimage, updateId }),
  // Participant-managed claim: the backend signs the CBTC claim via CanActAs (no Loop popup).
  claimManaged: (
    id: string,
    preimage: string
  ): Promise<{ ok: boolean; updateId: string }> =>
    jpost(`/api/htlc/${id}/claim-managed`, { preimage }),
  // Refund the CBTC counter (backend, after Canton timelock).
  refundCounter: (id: string) => jpost(`/api/htlc/${id}/refund-counter`),
  // Record the user's EVM retake (WBTC refund) after the EVM timelock.
  recordRetake: (id: string, retakeTx: string) =>
    jpost(`/api/htlc/${id}/retake-main`, { retakeTx }),
  getPreimage: (id: string) => jget(`/api/htlc/${id}/preimage`),
  recordMainClaim: (id: string, mainClaimTx: string) =>
    jpost(`/api/htlc/${id}/main-claim`, { mainClaimTx })
};

// --- EVM actions (via useEvmWallet) ---
type SendTx = (tx: {
  to: string;
  data: string;
  value?: string;
}) => Promise<string>;
type CallFn = (to: string, data: string) => Promise<string>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// allowance(owner, spender) selector + decode
function encodeAllowance(owner: string, spender: string): string {
  const sel = "0xdd62ed3e"; // allowance(address,address)
  const pad = (a: string) =>
    a.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  return sel + pad(owner) + pad(spender);
}
function decodeUint(hex: string): bigint {
  return hex && hex !== "0x" ? BigInt(hex) : 0n;
}

/**
 * Step 3 — approve WBTC (if needed) then lock it in the HTLC. Returns the lock tx.
 *
 * CRITICAL: sendTransaction returns when the tx is SUBMITTED, not mined. So after
 * approving we POLL the allowance (eth_call) until it reflects before locking —
 * otherwise the lock fires with allowance still 0 and reverts
 * (ERC20InsufficientAllowance, the "likely to fail" warning).
 */
export async function evmApproveAndLock(
  send: SendTx,
  call: CallFn,
  owner: string,
  p: {
    wbtc: string;
    escrow: string;
    amount: bigint;
    hashLock: string;
    unlockTime: number;
    receiver: string;
  }
): Promise<string> {
  const current = decodeUint(
    await call(p.wbtc, encodeAllowance(owner, p.escrow))
  );
  if (current < p.amount) {
    await send({ to: p.wbtc, data: encodeApprove(p.escrow, p.amount) });
    // poll until the allowance is on-chain (avoid the submit-vs-mined race)
    let ok = false;
    for (let i = 0; i < 40; i++) {
      await sleep(2000);
      const a = decodeUint(
        await call(p.wbtc, encodeAllowance(owner, p.escrow))
      );
      if (a >= p.amount) {
        ok = true;
        break;
      }
    }
    if (!ok)
      throw new Error(
        "Approval not confirmed on-chain yet — try again in a moment."
      );
  }
  return send({
    to: p.escrow,
    data: encodeLock({
      hashValue: p.hashLock,
      unlockTime: p.unlockTime,
      amount: p.amount,
      token: p.wbtc,
      receiver: p.receiver
    })
  });
}

/** Step 7 — claim the WBTC with the revealed preimage. */
export async function evmClaim(
  send: SendTx,
  escrow: string,
  preImage: string
): Promise<string> {
  return send({ to: escrow, data: encodeClaim(preImage) });
}

/** Refund — retake after the timelock. */
export async function evmRetake(
  send: SendTx,
  escrow: string,
  hashLock: string
): Promise<string> {
  return send({ to: escrow, data: encodeRetake(hashLock) });
}

// --- Shared CLAIM (used by both /swap and /orders) ---

/** Minimal Loop provider shape needed to sign a standard accept. */
interface LoopLike {
  party_id?: string;
  submitAndWaitForTransaction: (
    payload: unknown,
    options?: unknown
  ) => Promise<unknown>;
}

export function loopSubmitUpdateId(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const obj = result as Record<string, unknown>;
  for (const key of ["updateId", "update_id"]) {
    if (typeof obj[key] === "string" && obj[key]) return obj[key] as string;
  }
  for (const key of ["transactionTree", "transaction", "result", "data"]) {
    const nested = loopSubmitUpdateId(obj[key]);
    if (nested) return nested;
  }
  return null;
}

async function recordClaimWithRetry(
  orderId: string,
  preimage: string,
  updateId: string
): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < 8; i++) {
    try {
      await htlcApi.recordClaim(orderId, preimage, updateId);
      return;
    } catch (e) {
      lastError = e;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(
        "Loop accept succeeded but WarpX could not record the proof yet. Keep this page open — it will retry automatically."
      );
}

function loopForwardAcceptPending(order: {
  direction?: string;
  counterMode?: string;
  status?: string;
  counterTransferOfferCid?: string;
  counterTransferUpdateId?: string;
  counterClaimUpdateId?: string;
}): boolean {
  return (
    order.direction === "evm-to-canton" &&
    order.counterMode === "loop" &&
    order.status === "counter_claimed" &&
    !!order.counterTransferOfferCid &&
    !htlcForwardLoopDeliveryProven({
      direction: "evm-to-canton",
      counterMode: "loop",
      counterTransferUpdateId: order.counterTransferUpdateId,
      counterClaimUpdateId: order.counterClaimUpdateId
    })
  );
}

async function submitLoopForwardAccept(params: {
  orderId: string;
  preimage: string;
  loop: LoopLike;
}): Promise<void> {
  const { orderId, preimage, loop } = params;
  try {
    const { command, disclosedContracts, synchronizerId } =
      await htlcApi.prepareAccept(orderId);
    const userParty = loop.party_id ?? "";
    if (!userParty) {
      throw new Error(
        "Loop wallet party id is missing — reconnect Loop and try again."
      );
    }
    const result = (await loop.submitAndWaitForTransaction(
      {
        commands: [command],
        disclosedContracts,
        packageIdSelectionPreference: [],
        actAs: [userParty],
        readAs: [userParty],
        synchronizerId
      },
      undefined
    )) as unknown;
    const acceptUpdateId = loopSubmitUpdateId(result);
    if (!acceptUpdateId) {
      throw new Error(
        "Loop accepted the CBTC transfer, but did not return a ledger update id. Keep this page open while WarpX records the proof."
      );
    }
    await recordClaimWithRetry(orderId, preimage, acceptUpdateId);
  } catch (e) {
    const msg = getSwapErrorMessage(e);
    if (
      msg.includes("already delivered") ||
      msg.includes("Transfer Preapproval") ||
      msg.includes("no longer pending") ||
      msg.includes("reconcile your accept proof")
    ) {
      const { order: fresh } = await htlcApi.getOrder(orderId);
      const row = fresh as {
        counterTransferUpdateId?: string;
        counterClaimUpdateId?: string;
      };
      if (
        htlcForwardLoopDeliveryProven({
          direction: "evm-to-canton",
          counterMode: "loop",
          counterTransferUpdateId: row.counterTransferUpdateId,
          counterClaimUpdateId: row.counterClaimUpdateId
        })
      ) {
        const proofUpdateId =
          row.counterClaimUpdateId ?? row.counterTransferUpdateId;
        if (proofUpdateId) {
          await recordClaimWithRetry(orderId, preimage, proofUpdateId);
          return;
        }
      }
    }
    throw e;
  }
}

async function finishLoopForwardClaimAfterReveal(params: {
  orderId: string;
  preimage: string;
  reveal: { updateId: string; delivered: boolean };
  loop: LoopLike;
}): Promise<void> {
  const { orderId, preimage, reveal, loop } = params;
  if (reveal.delivered) {
    await recordClaimWithRetry(orderId, preimage, reveal.updateId);
    return;
  }

  const { order: afterReveal } = await htlcApi.getOrder(orderId);
  const deliveryRow = afterReveal as {
    direction?: string;
    counterMode?: string;
    counterTransferUpdateId?: string;
    counterClaimUpdateId?: string;
  };
  if (
    deliveryRow.direction === "evm-to-canton" &&
    deliveryRow.counterMode === "loop" &&
    htlcForwardLoopDeliveryProven({
      direction: "evm-to-canton",
      counterMode: "loop",
      counterTransferUpdateId: deliveryRow.counterTransferUpdateId,
      counterClaimUpdateId: deliveryRow.counterClaimUpdateId
    })
  ) {
    await recordClaimWithRetry(
      orderId,
      preimage,
      deliveryRow.counterClaimUpdateId ?? deliveryRow.counterTransferUpdateId!
    );
    return;
  }

  await submitLoopForwardAccept({ orderId, preimage, loop });
}

/**
 * Complete a claimable swap from its preimage — the SAME logic the /swap page runs,
 * extracted so /orders (and any tab) can claim a swap whose secret was persisted.
 * Branches by direction + counterMode:
 *   - canton-to-evm: the user claims the WBTC on EVM (MetaMask) — that reveals the
 *     secret; the daemon then claims the CBTC. Needs `send` (evm.sendTransaction).
 *   - evm-to-canton managed: backend signs the CBTC claim (CanActAs), no popup.
 *   - evm-to-canton loop: reveal-first → standard transfer auto-accepts, or the user
 *     signs a standard accept in their Loop wallet. Needs `loop` (the provider).
 */
export async function claimSwap(opts: {
  order: { id: string; direction: string; counterMode?: string };
  secret: string;
  escrow: string;
  send?: SendTx; // EVM sender (reverse claim)
  loop?: LoopLike | null; // Loop provider (forward loop accept)
}): Promise<{ tx?: string }> {
  const { order, secret, escrow } = opts;
  const preimage = secretToPreimage(secret);

  if (order.direction === "canton-to-evm") {
    if (!opts.send)
      throw new Error("Connect your EVM wallet to claim your WBTC.");
    const tx = await evmClaim(opts.send, escrow, preimage);
    const provider = getBrowserEvmProvider();
    if (!provider) throw new Error("no EVM provider");
    await waitForEvmReceipt(provider, tx);
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        await htlcApi.recordClaim(order.id, preimage, tx);
        break;
      } catch (e) {
        if (!isTransientEvmFinalityError(e) || attempt === 11) throw e;
        await sleep(2500);
      }
    }
    return { tx };
  }

  // evm-to-canton
  if (order.counterMode === "managed") {
    await htlcApi.claimManaged(order.id, preimage);
    return {};
  }
  // Loop buyer: reveal-first → deliver (auto-accept) or sign a standard accept.
  const loop = opts.loop;
  if (!loop) throw new Error("Connect your Loop wallet to accept your CBTC.");
  const { order: current } = await htlcApi.getOrder(order.id);
  if (loopForwardAcceptPending(current as Parameters<typeof loopForwardAcceptPending>[0])) {
    await submitLoopForwardAccept({ orderId: order.id, preimage, loop });
    return {};
  }
  const reveal = await htlcApi.claimCounter(order.id, preimage);
  await finishLoopForwardClaimAfterReveal({
    orderId: order.id,
    preimage,
    reveal,
    loop
  });
  return {};
}

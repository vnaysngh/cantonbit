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
async function jget(url: string) {
  const r = await fetch(url);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `GET ${url} failed (${r.status})`);
  return j;
}

/** Coalesce concurrent GETs to the same URL (poll loops + claim UI). */
const inflightGet = new Map<string, Promise<unknown>>();
function jgetDeduped(url: string): Promise<unknown> {
  let pending = inflightGet.get(url);
  if (!pending) {
    pending = jget(url).finally(() => {
      inflightGet.delete(url);
    });
    inflightGet.set(url, pending);
  }
  return pending;
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
  getOrder: (id: string) =>
    jgetDeduped(`/api/htlc/${id}`) as Promise<{ order: unknown }>,
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
  confirmLockLoop: (id: string) => jpost(`/api/htlc/${id}/confirm-lock-loop`),
  prepareWithdrawLoop: (
    id: string
  ): Promise<{
    command: unknown;
    disclosedContracts: unknown[];
    synchronizerId: string;
  }> => jpost(`/api/htlc/${id}/prepare-withdraw-loop`),
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
    await htlcApi.recordClaim(order.id, preimage, tx).catch(() => {});
    return { tx };
  }

  // evm-to-canton
  if (order.counterMode === "managed") {
    await htlcApi.claimManaged(order.id, preimage);
    return {};
  }
  // loop buyer: reveal-first → deliver (auto-accept) or sign a standard accept.
  const reveal = await htlcApi.claimCounter(order.id, preimage);
  if (reveal.delivered) {
    await htlcApi
      .recordClaim(order.id, preimage, reveal.updateId)
      .catch(() => {});
    return {};
  }
  const loop = opts.loop;
  if (!loop) throw new Error("Connect your Loop wallet to accept your CBTC.");
  const { command, disclosedContracts, synchronizerId } =
    await htlcApi.prepareAccept(order.id);
  const userParty = loop.party_id ?? "";
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
  )) as { updateId?: string; transactionTree?: { updateId?: string } };
  const updateId =
    result?.updateId ?? result?.transactionTree?.updateId ?? "submitted";
  await htlcApi.recordClaim(order.id, preimage, updateId);
  return {};
}

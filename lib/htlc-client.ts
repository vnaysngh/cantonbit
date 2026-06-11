/**
 * Frontend client for the /api/htlc/* endpoints + the EVM/Loop actions.
 * Keeps the page component lean. The SECRET never leaves the browser until the
 * user reveals it at claim-counter.
 */
import { keccak_256 } from "@noble/hashes/sha3";

import { encodeApprove, encodeLock, encodeClaim, encodeRetake } from "./htlc-evm-encode";

export interface HtlcOrderInput {
  id: string;
  direction: "evm-to-canton" | "canton-to-evm";
  hashLock: string;
  userEvmAddress: string;
  solverEvmAddress: string;
  wbtcAmount: string;       // base units (string)
  userTimelock: number;
  userCantonParty: string;
  solverCantonParty: string;
  cbtcAmount: string;       // BTC decimal string
  solverTimelock: number;
  // "managed" (email, on-ledger HtlcLock) | "loop" (standard transfer + accept).
  counterMode?: "managed" | "loop";
}

const bytesToHex = (b: Uint8Array) => "0x" + Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");

/** Generate a 32-byte secret + its keccak256 hashLock (over the raw bytes). */
export function generateSecret(): { secret: string; hashLock: string } {
  const raw = new Uint8Array(32);
  (globalThis.crypto as Crypto).getRandomValues(raw);
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
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
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

export const htlcApi = {
  createOrder: (o: HtlcOrderInput) => jpost("/api/htlc", o),
  getOrder: (id: string) => jget(`/api/htlc/${id}`),
  accept: (id: string) => jpost(`/api/htlc/${id}/accept`),
  recordMainLock: (id: string, mainLockTx: string) => jpost(`/api/htlc/${id}/main-lock`, { mainLockTx }),
  // REVERSE (canton-to-evm): backend locks the user's cBTC on-ledger (CanActAs).
  lockMain: (id: string) => jpost(`/api/htlc/${id}/lock-main`),
  refundMain: (id: string) => jpost(`/api/htlc/${id}/refund-main`),
  lockCounter: (id: string) => jpost(`/api/htlc/${id}/lock-counter`),
  // Loop reveal+deliver. delivered=true → the cBTC auto-accepted (preapproval) and
  // there is NOTHING to accept — skip the wallet popup entirely.
  claimCounter: (id: string, preimage: string): Promise<{ order: unknown; updateId: string; delivered: boolean }> =>
    jpost(`/api/htlc/${id}/claim-counter`, { preimage }),
  // On-ledger DAR claim (user signs via Loop): prepare the command, then record the result.
  prepareClaim: (id: string, preimage: string): Promise<{ command: unknown; disclosedContracts: unknown[]; synchronizerId: string }> =>
    jpost(`/api/htlc/${id}/claim-prepare`, { preimage }),
  // LOOP standard accept (user signs a STANDARD TransferInstruction_Accept in their
  // wallet — no custom DAR). Then record the revealed preimage so the solver claims WBTC.
  prepareAccept: (id: string): Promise<{ command: unknown; disclosedContracts: unknown[]; synchronizerId: string }> =>
    jpost(`/api/htlc/${id}/prepare-accept`),
  recordClaim: (id: string, preimage: string, updateId: string) =>
    jpost(`/api/htlc/${id}/claim-record`, { preimage, updateId }),
  // Participant-managed claim: the backend signs the cBTC claim via CanActAs (no Loop popup).
  claimManaged: (id: string, preimage: string): Promise<{ ok: boolean; updateId: string }> =>
    jpost(`/api/htlc/${id}/claim-managed`, { preimage }),
  // Refund the cBTC counter (backend, after Canton timelock).
  refundCounter: (id: string) => jpost(`/api/htlc/${id}/refund-counter`),
  // Record the user's EVM retake (WBTC refund) after the EVM timelock.
  recordRetake: (id: string, retakeTx: string) => jpost(`/api/htlc/${id}/retake-main`, { retakeTx }),
  getPreimage: (id: string) => jget(`/api/htlc/${id}/preimage`),
  recordMainClaim: (id: string, mainClaimTx: string) => jpost(`/api/htlc/${id}/main-claim`, { mainClaimTx }),
};

// --- EVM actions (via useEvmWallet) ---
type SendTx = (tx: { to: string; data: string; value?: string }) => Promise<string>;
type CallFn = (to: string, data: string) => Promise<string>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// allowance(owner, spender) selector + decode
function encodeAllowance(owner: string, spender: string): string {
  const sel = "0xdd62ed3e"; // allowance(address,address)
  const pad = (a: string) => a.replace(/^0x/, "").toLowerCase().padStart(64, "0");
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
  p: { wbtc: string; escrow: string; amount: bigint; hashLock: string; unlockTime: number; receiver: string },
): Promise<string> {
  const current = decodeUint(await call(p.wbtc, encodeAllowance(owner, p.escrow)));
  if (current < p.amount) {
    await send({ to: p.wbtc, data: encodeApprove(p.escrow, p.amount) });
    // poll until the allowance is on-chain (avoid the submit-vs-mined race)
    let ok = false;
    for (let i = 0; i < 40; i++) {
      await sleep(2000);
      const a = decodeUint(await call(p.wbtc, encodeAllowance(owner, p.escrow)));
      if (a >= p.amount) { ok = true; break; }
    }
    if (!ok) throw new Error("Approval not confirmed on-chain yet — try again in a moment.");
  }
  return send({
    to: p.escrow,
    data: encodeLock({ hashValue: p.hashLock, unlockTime: p.unlockTime, amount: p.amount, token: p.wbtc, receiver: p.receiver }),
  });
}

/** Step 7 — claim the WBTC with the revealed preimage. */
export async function evmClaim(send: SendTx, escrow: string, preImage: string): Promise<string> {
  return send({ to: escrow, data: encodeClaim(preImage) });
}

/** Refund — retake after the timelock. */
export async function evmRetake(send: SendTx, escrow: string, hashLock: string): Promise<string> {
  return send({ to: escrow, data: encodeRetake(hashLock) });
}

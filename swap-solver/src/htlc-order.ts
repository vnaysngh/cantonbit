/**
 * HTLC order primitives (T7) — the new, trustless-EVM-leg swap order.
 *
 * Replaces the oracle-proof order model with the Fusion+/Cancore HTLC model:
 * one secret `s` (H = keccak256(s)) binds the EVM leg and the Canton leg. The
 * USER generates `s` and commits to `H` in the signed order (per Cancore). The
 * solver never learns `s` until the user reveals it by claiming the Canton leg.
 *
 * This module is intentionally separate from order.ts (the old oracle order),
 * so the existing solver keeps running while the HTLC path is built alongside.
 * The old attestation machinery (attestTuple / proofDataHash) is NOT used here.
 *
 * Encoding contract (matches T2, verified against the EVM HTLCEscrow + Daml):
 *   - `s` (secret/preimage) is 32 random bytes.
 *   - H = keccak256(s) over the RAW bytes  ← EVM HTLCEscrow.claim hashes raw bytes.
 *   - The Canton leg hashes the LOWERCASE-HEX string of the same bytes
 *     (Daml DA.Crypto.Text.keccak256 takes a hex string), which yields the SAME
 *     digest. So we pass the hex form of `s` to the Canton claim; both produce H.
 */

import { keccak256, toHex, type Account, type Address, type Hex, type TypedDataDomain } from "viem";

/** A user-generated secret and its hashlock. The user keeps `secret` private
 *  until they claim the Canton leg; only `hashLock` goes into the signed order. */
export interface SwapSecret {
  /** 32 random bytes, as 0x-hex. The preimage. KEEP PRIVATE until reveal. */
  secret: Hex;
  /** H = keccak256(secret) over the raw bytes. Goes into the signed order. */
  hashLock: Hex;
}

/**
 * Generate a fresh secret + hashlock. Call on the USER side (browser/app) so the
 * solver never sees the secret. Uses the platform CSPRNG.
 *
 * `randomBytes` is injected for testability; defaults to Web Crypto.
 */
export function generateSecret(
  randomBytes: (n: number) => Uint8Array = defaultRandom,
): SwapSecret {
  const raw = randomBytes(32);
  const secret = toHex(raw); // 0x + 64 hex chars
  const hashLock = keccak256(raw); // keccak over the raw 32 bytes (EVM-compatible)
  return { secret, hashLock };
}

/** The lowercase-hex string of the secret bytes, WITHOUT the 0x prefix — this is
 *  what the Canton (Daml) claim takes as its `preimage` (BytesHex). Hashing this
 *  hex string in Daml yields the same H as keccak over the raw bytes on EVM. */
export function secretToCantonPreimage(secret: Hex): string {
  return secret.startsWith("0x") ? secret.slice(2).toLowerCase() : secret.toLowerCase();
}

/** Verify a revealed secret matches a committed hashlock (used by the solver
 *  after the user reveals on Canton, before claiming the EVM leg). */
export function verifySecret(secret: Hex, hashLock: Hex): boolean {
  const raw = hexToBytes(secret);
  return keccak256(raw).toLowerCase() === hashLock.toLowerCase();
}

/**
 * The staggered timelock ladder. The EVM (user/main) leg MUST expire LATER than
 * the Canton (solver/counter) leg, so that after the user reveals `s` on Canton
 * the solver still has time to claim the EVM leg before the user can refund it.
 *
 * Rule (Cancore): T_user (EVM) > T_solver (Canton); min total window 2h.
 * `gapSeconds` is the safety margin between them — must exceed
 *   (EVM finality + Canton skew_max + buffer). Sized in T3.
 */
export interface Timelocks {
  /** EVM HTLC unlock time (unix seconds). The user can `retake` after this. The LONGER one. */
  userTimelock: number;
  /** Canton HTLC unlock time (unix seconds). The solver can refund after this. The SHORTER one. */
  solverTimelock: number;
}

export function buildTimelocks(
  nowSeconds: number,
  totalWindowSeconds: number,
  gapSeconds: number,
): Timelocks {
  if (totalWindowSeconds < 2 * 60 * 60) {
    throw new Error("HTLC window must be >= 2h (Cancore minimum)");
  }
  if (gapSeconds <= 0 || gapSeconds >= totalWindowSeconds) {
    throw new Error("gapSeconds must be > 0 and < totalWindowSeconds");
  }
  const userTimelock = nowSeconds + totalWindowSeconds;
  const solverTimelock = userTimelock - gapSeconds; // earlier than the EVM leg
  return { userTimelock, solverTimelock };
}

/** A swap request in the HTLC model. The user signs an order committing to all
 *  of these so the solver cannot alter the hashlock, amounts, or deadlines. */
export interface HtlcSwapRequest {
  /** User's EVM address (locks WBTC on the EVM leg, signs the order). */
  user: Address;
  /** WBTC amount to lock (origin token base units, 8dp). */
  wbtcAmount: bigint;
  /** cBTC amount to receive (base units). */
  cbtcAmount: bigint;
  /** User's full Canton party id (the cBTC receiver). */
  cantonParty: string;
  /** H = keccak256(secret). The user generated the secret; only H is shared. */
  hashLock: Hex;
  /** Staggered timelocks (T_user > T_solver). */
  timelocks: Timelocks;
  /** Unique per-user nonce. */
  nonce: bigint;
}

/** Everything the solver + both legs need, kept together so they agree. */
export interface BuiltHtlcOrder {
  request: HtlcSwapRequest;
  /** swapId that ties the two legs together. keccak256 of the committed fields. */
  swapId: Hex;
}

/**
 * Derive a deterministic swapId from the committed order fields. Both legs and
 * the solver key off this so a given swap is unambiguous and replay-proof.
 */
export function buildHtlcOrder(req: HtlcSwapRequest): BuiltHtlcOrder {
  // swapId binds: user, amounts, recipient, hashLock, timelocks, nonce.
  const packed = keccak256(
    toHex(
      `${req.user.toLowerCase()}|${req.wbtcAmount}|${req.cbtcAmount}|${req.cantonParty}|` +
        `${req.hashLock.toLowerCase()}|${req.timelocks.userTimelock}|${req.timelocks.solverTimelock}|${req.nonce}`,
    ),
  );
  // sanity: timelock ladder must hold.
  if (!(req.timelocks.solverTimelock < req.timelocks.userTimelock)) {
    throw new Error("timelock ladder violated: solverTimelock must be < userTimelock");
  }
  return { request: req, swapId: packed };
}

// --- order commitment signature (T7) --------------------------------------
//
// In the HTLC model the user does NOT sign a Permit2 witness for the EVM leg —
// they send the HTLCEscrow.lock(...) transaction directly via MetaMask (per
// Cancore). What they sign here is an OFF-CHAIN ORDER COMMITMENT (EIP-712): it
// proves the order terms — crucially the hashLock + timelocks — are the user's,
// so the solver can match it and cannot substitute a different hashLock. This
// is the "Create Order" step (1).

/** EIP-712 domain for the off-chain HTLC swap order. `chainId` = the EVM origin
 *  chain; `verifyingContract` = the HTLCEscrow (binds the order to our escrow). */
export function htlcOrderDomain(chainId: number, escrow: Address): TypedDataDomain {
  return { name: "OranjHtlcSwap", version: "1", chainId, verifyingContract: escrow };
}

export const HTLC_ORDER_TYPES = {
  HtlcSwapOrder: [
    { name: "user", type: "address" },
    { name: "wbtcAmount", type: "uint256" },
    { name: "cbtcAmount", type: "uint256" },
    { name: "cantonRecipientHash", type: "bytes32" }, // keccak256(cantonParty)
    { name: "hashLock", type: "bytes32" },
    { name: "userTimelock", type: "uint64" },
    { name: "solverTimelock", type: "uint64" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

/** Build the EIP-712 typed data the user signs to commit to an HTLC swap order. */
export function buildHtlcOrderTypedData(params: {
  req: HtlcSwapRequest;
  chainId: number;
  escrow: Address;
}) {
  const { req, chainId, escrow } = params;
  return {
    domain: htlcOrderDomain(chainId, escrow),
    types: HTLC_ORDER_TYPES,
    primaryType: "HtlcSwapOrder" as const,
    message: {
      user: req.user,
      wbtcAmount: req.wbtcAmount,
      cbtcAmount: req.cbtcAmount,
      cantonRecipientHash: keccak256(toHex(req.cantonParty)),
      hashLock: req.hashLock,
      userTimelock: BigInt(req.timelocks.userTimelock),
      solverTimelock: BigInt(req.timelocks.solverTimelock),
      nonce: req.nonce,
    },
  };
}

/** Sign the HTLC swap order (user side). Returns the 65-byte EIP-712 signature. */
export async function signHtlcOrder(params: {
  account: Account;
  req: HtlcSwapRequest;
  chainId: number;
  escrow: Address;
}): Promise<Hex> {
  const typed = buildHtlcOrderTypedData(params);
  if (!params.account.signTypedData) {
    throw new Error("account cannot signTypedData (use a wallet/private-key account)");
  }
  return params.account.signTypedData(typed as never);
}

// --- helpers ---------------------------------------------------------------

function defaultRandom(n: number): Uint8Array {
  const a = new Uint8Array(n);
  // Web Crypto (browser + Node 19+).
  (globalThis.crypto as Crypto).getRandomValues(a);
  return a;
}

function hexToBytes(hex: Hex): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

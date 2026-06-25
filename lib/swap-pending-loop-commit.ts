/**
 * Persist Loop sign/commit context across UI retries so a lost commit response
 * does not mint a second order id or hash lock.
 */
import type { CantonSwapMvpAssetId } from "./canton-swap-types";

const STORAGE_KEY = "oranjswap.pendingLoopCommit";

type PendingStorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

let pendingStorageOverride: PendingStorageLike | null = null;

/** @internal test hook */
export function __setPendingLoopCommitStorageForTests(
  store: PendingStorageLike | null
): void {
  pendingStorageOverride = store;
}

function pendingStorage(): PendingStorageLike | null {
  if (pendingStorageOverride) return pendingStorageOverride;
  if (typeof sessionStorage === "undefined") return null;
  return sessionStorage;
}

export type PendingC2cLoopCommit = {
  flow: "c2c";
  orderId: string;
  createdAt: number;
  fromAsset: CantonSwapMvpAssetId;
  toAsset: CantonSwapMvpAssetId;
  inAmount: string;
  outAmount: string;
  userParty: string;
  submitUpdateId?: string;
  offerCid?: string;
};

export type PendingReverseLoopCommit = {
  flow: "reverse-htlc";
  hashLock: string;
  secret: string;
  userEvmAddress: string;
  userCantonParty: string;
  wbtcAmount: string;
  cbtcAmount: string;
  userTimelock: number;
  solverTimelock: number;
  createdAt?: number;
  submitUpdateId?: string;
  offerCidHint?: string;
};

export type PendingForwardHtlcCommit = {
  flow: "forward-htlc";
  hashLock: string;
  secret: string;
  userEvmAddress: string;
  userCantonParty: string;
  wbtcAmount: string;
  cbtcAmount: string;
  userTimelock: number;
  solverTimelock: number;
  counterMode: "managed" | "loop";
  prepared?: boolean;
};

export type PendingLoopCommit =
  | PendingC2cLoopCommit
  | PendingReverseLoopCommit
  | PendingForwardHtlcCommit;

function readRaw(): PendingLoopCommit | null {
  const storage = pendingStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PendingLoopCommit;
  } catch {
    return null;
  }
}

function writeRaw(next: PendingLoopCommit | null): void {
  const storage = pendingStorage();
  if (!storage) return;
  if (!next) {
    storage.removeItem(STORAGE_KEY);
    return;
  }
  storage.setItem(STORAGE_KEY, JSON.stringify(next));
}

export function readPendingLoopCommit(): PendingLoopCommit | null {
  return readRaw();
}

export function writePendingLoopCommit(next: PendingLoopCommit): void {
  writeRaw(next);
}

export function patchPendingLoopCommit(
  patch: Partial<PendingLoopCommit> & Pick<PendingLoopCommit, "flow">
): PendingLoopCommit | null {
  const prev = readRaw();
  if (!prev || prev.flow !== patch.flow) {
    if ("orderId" in patch || "hashLock" in patch) {
      writeRaw(patch as PendingLoopCommit);
      return patch as PendingLoopCommit;
    }
    return null;
  }
  const merged = { ...prev, ...patch } as PendingLoopCommit;
  writeRaw(merged);
  return merged;
}

export function clearPendingLoopCommit(): void {
  writeRaw(null);
}

/** HTLC secret still in sessionStorage when lock finished before vault persist. */
export function recallPendingHtlcSecret(orderId: string): string | null {
  const pending = readPendingLoopCommit();
  if (!pending) return null;
  const id = orderId.trim().toLowerCase();
  if (
    (pending.flow === "reverse-htlc" || pending.flow === "forward-htlc") &&
    pending.hashLock.trim().toLowerCase() === id &&
    typeof pending.secret === "string" &&
    pending.secret.length > 0
  ) {
    return pending.secret;
  }
  return null;
}

export function hasPendingHtlcSecret(orderId: string): boolean {
  return recallPendingHtlcSecret(orderId) !== null;
}

export function pendingC2cMatchesQuote(
  pending: PendingC2cLoopCommit,
  quote: {
    fromAsset: CantonSwapMvpAssetId;
    toAsset: CantonSwapMvpAssetId;
    inAmount: string;
    outAmount: string;
    userParty: string;
  }
): boolean {
  return (
    pending.fromAsset === quote.fromAsset &&
    pending.toAsset === quote.toAsset &&
    pending.inAmount === quote.inAmount &&
    pending.outAmount === quote.outAmount &&
    pending.userParty === quote.userParty
  );
}

export function pendingReverseMatchesQuote(
  pending: PendingReverseLoopCommit,
  quote: {
    cbtcAmount: string;
    wbtcAmount?: string;
    userCantonParty: string;
    userEvmAddress: string;
    userTimelock: number;
    solverTimelock: number;
  },
  wbtcAmount: string
): boolean {
  return (
    pending.cbtcAmount === quote.cbtcAmount &&
    pending.wbtcAmount === wbtcAmount &&
    pending.userCantonParty === quote.userCantonParty &&
    pending.userEvmAddress.toLowerCase() === quote.userEvmAddress.toLowerCase() &&
    pending.userTimelock === quote.userTimelock &&
    pending.solverTimelock === quote.solverTimelock
  );
}

export function pendingForwardMatchesQuote(
  pending: PendingForwardHtlcCommit,
  quote: {
    userCantonParty: string;
    userEvmAddress: string;
    wbtcAmount: string;
    cbtcAmount: string;
    userTimelock: number;
    solverTimelock: number;
    counterMode: "managed" | "loop";
  }
): boolean {
  return (
    pending.wbtcAmount === quote.wbtcAmount &&
    pending.cbtcAmount === quote.cbtcAmount &&
    pending.userCantonParty === quote.userCantonParty &&
    pending.userEvmAddress.toLowerCase() === quote.userEvmAddress.toLowerCase() &&
    pending.userTimelock === quote.userTimelock &&
    pending.solverTimelock === quote.solverTimelock &&
    pending.counterMode === quote.counterMode
  );
}

/**
 * Durable, non-secret recovery record for an EVM main-lock transaction whose
 * hash has been submitted but not yet acknowledged by the HTLC API.
 *
 * The encrypted secret remains in secret-vault. This record only lets the client
 * safely retry the idempotent `recordMainLock` call after RPC/API timeouts or a
 * page/browser restart.
 */

export type PendingMainLock = {
  swapId: string;
  lockTx: string;
  userCantonParty: string;
  userEvmAddress: string;
  expiresAt: number;
  createdAt: number;
  wbtcAmount?: string;
  cbtcAmount?: string;
  userTimelock?: number;
  solverTimelock?: number;
  counterMode?: "managed" | "loop";
};

type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

const KEY = "oranj.htlc.pending-main-lock.v1";
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

let storageOverride: StorageLike | null = null;

function storage(): StorageLike | null {
  if (storageOverride) return storageOverride;
  if (typeof window === "undefined") return null;
  return localStorage;
}

function isPendingMainLock(value: unknown): value is PendingMainLock {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<PendingMainLock>;
  return (
    typeof item.swapId === "string" &&
    HASH_RE.test(item.swapId) &&
    typeof item.lockTx === "string" &&
    HASH_RE.test(item.lockTx) &&
    typeof item.userCantonParty === "string" &&
    item.userCantonParty.length > 0 &&
    typeof item.userEvmAddress === "string" &&
    item.userEvmAddress.length > 0 &&
    typeof item.expiresAt === "number" &&
    Number.isFinite(item.expiresAt) &&
    typeof item.createdAt === "number" &&
    Number.isFinite(item.createdAt)
  );
}

function readStore(): Record<string, PendingMainLock> {
  const s = storage();
  if (!s) return {};
  try {
    const parsed = JSON.parse(s.getItem(KEY) ?? "{}") as Record<
      string,
      unknown
    >;
    const valid: Record<string, PendingMainLock> = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (isPendingMainLock(value) && value.swapId === id) valid[id] = value;
    }
    return valid;
  } catch {
    return {};
  }
}

function writeStore(store: Record<string, PendingMainLock>): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(KEY, JSON.stringify(store));
  } catch {
    /* storage disabled/quota exceeded */
  }
}

function purgeExpired(store: Record<string, PendingMainLock>): boolean {
  const now = Math.floor(Date.now() / 1000);
  let changed = false;
  for (const [id, pending] of Object.entries(store)) {
    if (pending.expiresAt < now) {
      delete store[id];
      changed = true;
    }
  }
  return changed;
}

export function rememberPendingMainLock(
  pending: Omit<PendingMainLock, "createdAt">
): boolean {
  const s = storage();
  if (!s) return false;
  const item: PendingMainLock = {
    ...pending,
    userEvmAddress: pending.userEvmAddress.trim().toLowerCase(),
    createdAt: Date.now()
  };
  if (!isPendingMainLock(item)) return false;
  const store = readStore();
  purgeExpired(store);
  store[item.swapId] = item;
  writeStore(store);
  return true;
}

export function readPendingMainLocks(): PendingMainLock[] {
  const store = readStore();
  if (purgeExpired(store)) writeStore(store);
  return Object.values(store).sort((a, b) => a.createdAt - b.createdAt);
}

export function selectPendingMainLock(
  pendingLocks: PendingMainLock[],
  identity: {
    userCantonParty: string;
    userEvmAddress: string;
    activeSwapId?: string | null;
  }
): PendingMainLock | undefined {
  const evm = identity.userEvmAddress.trim().toLowerCase();
  const matches = pendingLocks.filter(
    (pending) =>
      pending.userCantonParty === identity.userCantonParty &&
      pending.userEvmAddress === evm
  );
  return (
    matches.find((pending) => pending.swapId === identity.activeSwapId) ??
    matches[0]
  );
}

export function forgetPendingMainLock(swapId: string): void {
  const store = readStore();
  if (!store[swapId]) return;
  delete store[swapId];
  writeStore(store);
}

/** @internal test hook */
export function __setPendingMainLockStorageForTests(
  value: StorageLike | null
): void {
  storageOverride = value;
}

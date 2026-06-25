/**
 * Durable Loop sign/commit recovery metadata (localStorage, multi-intent).
 *
 * Plaintext HTLC secrets live only in `secret-vault` (written before wallet sign).
 * This store holds quote terms, submitUpdateId, and other reconnect hints only.
 */
import type { CantonSwapMvpAssetId } from "./canton-swap-types";

const LS_KEY = "oranjswap.pendingLoopCommit.v2";
/** Legacy single-slot sessionStorage (may still hold plaintext secret — migrate on read). */
const LEGACY_SS_KEY = "oranjswap.pendingLoopCommit";

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

let localStorageOverride: StorageLike | null = null;
let sessionStorageOverride: StorageLike | null = null;

/** @internal test hook */
export function __setPendingLoopCommitStorageForTests(opts: {
  localStorage?: StorageLike | null;
  sessionStorage?: StorageLike | null;
}): void {
  localStorageOverride = opts.localStorage ?? null;
  sessionStorageOverride = opts.sessionStorage ?? null;
}

function localStorage(): StorageLike | null {
  if (localStorageOverride) return localStorageOverride;
  if (typeof window === "undefined") return null;
  return window.localStorage;
}

function sessionStorage(): StorageLike | null {
  if (sessionStorageOverride) return sessionStorageOverride;
  if (typeof window === "undefined") return null;
  return window.sessionStorage;
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

type PendingRecord = PendingLoopCommit & {
  updatedAt: number;
  expiresAt: number;
};

/** Legacy sessionStorage shape — secret stripped on migration. */
type LegacyPendingLoopCommit = PendingLoopCommit & { secret?: string };

function recordKey(pending: Pick<PendingLoopCommit, "flow"> & { orderId?: string; hashLock?: string }): string | null {
  if (pending.flow === "c2c" && typeof pending.orderId === "string") {
    return pending.orderId.trim().toLowerCase();
  }
  if (
    (pending.flow === "reverse-htlc" || pending.flow === "forward-htlc") &&
    typeof pending.hashLock === "string"
  ) {
    return pending.hashLock.trim().toLowerCase();
  }
  return null;
}

function expiresAtFor(pending: PendingLoopCommit): number {
  if (pending.flow === "c2c") {
    return Math.floor(Date.now() / 1000) + 86_400;
  }
  return pending.userTimelock + 3600;
}

function isPendingC2c(value: unknown): value is PendingC2cLoopCommit {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<PendingC2cLoopCommit>;
  return (
    item.flow === "c2c" &&
    typeof item.orderId === "string" &&
    item.orderId.length > 0 &&
    typeof item.createdAt === "number" &&
    Number.isFinite(item.createdAt) &&
    typeof item.fromAsset === "string" &&
    typeof item.toAsset === "string" &&
    typeof item.inAmount === "string" &&
    typeof item.outAmount === "string" &&
    typeof item.userParty === "string"
  );
}

function isPendingReverse(value: unknown): value is PendingReverseLoopCommit {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<PendingReverseLoopCommit>;
  return (
    item.flow === "reverse-htlc" &&
    typeof item.hashLock === "string" &&
    HASH_RE.test(item.hashLock) &&
    typeof item.userEvmAddress === "string" &&
    typeof item.userCantonParty === "string" &&
    typeof item.wbtcAmount === "string" &&
    typeof item.cbtcAmount === "string" &&
    typeof item.userTimelock === "number" &&
    typeof item.solverTimelock === "number"
  );
}

function isPendingForward(value: unknown): value is PendingForwardHtlcCommit {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<PendingForwardHtlcCommit>;
  return (
    item.flow === "forward-htlc" &&
    typeof item.hashLock === "string" &&
    HASH_RE.test(item.hashLock) &&
    typeof item.userEvmAddress === "string" &&
    typeof item.userCantonParty === "string" &&
    typeof item.wbtcAmount === "string" &&
    typeof item.cbtcAmount === "string" &&
    typeof item.userTimelock === "number" &&
    typeof item.solverTimelock === "number" &&
    (item.counterMode === "managed" || item.counterMode === "loop")
  );
}

function stripSecret(pending: LegacyPendingLoopCommit): PendingLoopCommit {
  const { secret: _secret, ...rest } = pending;
  return rest as PendingLoopCommit;
}

function isPendingLoopCommit(value: unknown): value is PendingLoopCommit {
  return isPendingC2c(value) || isPendingReverse(value) || isPendingForward(value);
}

function toRecord(pending: PendingLoopCommit): PendingRecord | null {
  if (!isPendingLoopCommit(pending)) return null;
  const now = Date.now();
  return {
    ...pending,
    updatedAt: now,
    expiresAt: expiresAtFor(pending)
  };
}

function readStore(): Record<string, PendingRecord> {
  const ls = localStorage();
  if (!ls) return {};
  try {
    const parsed = JSON.parse(ls.getItem(LS_KEY) ?? "{}") as Record<string, unknown>;
    const valid: Record<string, PendingRecord> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object") continue;
      if (!isPendingLoopCommit(value)) continue;
      const pending = value as PendingLoopCommit;
      const meta = value as Partial<PendingRecord>;
      const id = recordKey(pending);
      if (!id || id !== key) continue;
      valid[key] = {
        ...pending,
        updatedAt: typeof meta.updatedAt === "number" ? meta.updatedAt : Date.now(),
        expiresAt:
          typeof meta.expiresAt === "number"
            ? meta.expiresAt
            : expiresAtFor(pending)
      };
    }
    return valid;
  } catch {
    return {};
  }
}

function writeStore(store: Record<string, PendingRecord>): void {
  const ls = localStorage();
  if (!ls) return;
  try {
    ls.setItem(LS_KEY, JSON.stringify(store));
  } catch {
    /* quota / disabled */
  }
}

function purgeExpired(store: Record<string, PendingRecord>): boolean {
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

function migrateLegacySessionStorage(store: Record<string, PendingRecord>): boolean {
  const ss = sessionStorage();
  if (!ss) return false;
  const raw = ss.getItem(LEGACY_SS_KEY);
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as LegacyPendingLoopCommit;
    if (!isPendingLoopCommit(parsed)) {
      ss.removeItem(LEGACY_SS_KEY);
      return false;
    }
    const hadSecret =
      typeof parsed.secret === "string" && parsed.secret.length > 0;
    const stripped = stripSecret(parsed);
    const record = toRecord(stripped);
    const key = record ? recordKey(stripped) : null;
    if (record && key) {
      store[key] = record;
    }
    // Keep legacy sessionStorage while a plaintext secret may still be needed for
    // claim migration — cleared only after vault persist succeeds.
    if (!hadSecret) {
      ss.removeItem(LEGACY_SS_KEY);
    }
    return !!key;
  } catch {
    ss.removeItem(LEGACY_SS_KEY);
    return false;
  }
}

function loadStore(): Record<string, PendingRecord> {
  const store = readStore();
  const migrated = migrateLegacySessionStorage(store);
  const expired = purgeExpired(store);
  if (migrated || expired) writeStore(store);
  return store;
}

function upsertRecord(pending: PendingLoopCommit): PendingLoopCommit | null {
  const record = toRecord(pending);
  const key = record ? recordKey(pending) : null;
  if (!record || !key) return null;
  const store = loadStore();
  const prev = store[key];
  store[key] = {
    ...record,
    updatedAt: Date.now(),
    expiresAt: prev?.expiresAt ?? record.expiresAt
  };
  writeStore(store);
  return pending;
}

export function listPendingLoopCommits(): PendingLoopCommit[] {
  const store = loadStore();
  return Object.values(store)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(({ updatedAt: _u, expiresAt: _e, ...pending }) => pending);
}

export function readPendingLoopCommitByKey(key: string): PendingLoopCommit | null {
  const id = key.trim().toLowerCase();
  const store = loadStore();
  const record = store[id];
  if (!record) return null;
  const { updatedAt: _u, expiresAt: _e, ...pending } = record;
  return pending;
}

/** Most recently touched pending intent (single active swap UX). */
export function readPendingLoopCommit(): PendingLoopCommit | null {
  return listPendingLoopCommits()[0] ?? null;
}

export function writePendingLoopCommit(next: PendingLoopCommit): void {
  upsertRecord(next);
}

export function patchPendingLoopCommit(
  patch: Partial<PendingLoopCommit> & Pick<PendingLoopCommit, "flow">
): PendingLoopCommit | null {
  const store = loadStore();
  let key = recordKey(patch as PendingLoopCommit);
  if (!key) {
    const candidates = Object.values(store)
      .filter((item) => item.flow === patch.flow)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    key = candidates[0] ? recordKey(candidates[0]) : null;
  }

  const prev = key ? store[key] : undefined;

  if (!prev || prev.flow !== patch.flow) {
    if (key && ("orderId" in patch || "hashLock" in patch)) {
      const merged = { ...patch } as PendingLoopCommit;
      if (isPendingLoopCommit(merged)) {
        upsertRecord(merged);
        return merged;
      }
    }
    return null;
  }

  const merged = { ...prev, ...patch } as PendingLoopCommit;
  const { updatedAt: _u, expiresAt: _e, ...pending } = prev;
  void _u;
  void _e;
  void pending;
  if (!isPendingLoopCommit(merged)) return null;
  upsertRecord(merged);
  return merged;
}

export function clearPendingLoopCommit(key?: string): void {
  const store = loadStore();
  if (key) {
    delete store[key.trim().toLowerCase()];
    writeStore(store);
    return;
  }
  writeStore({});
}

export function hasPendingLoopIntent(orderId: string): boolean {
  const id = orderId.trim().toLowerCase();
  return readPendingLoopCommitByKey(id) !== null;
}

/** Drop legacy sessionStorage pending commit once the secret is in the vault. */
export function clearLegacyPendingLoopCommitIfMatched(orderId: string): void {
  const ss = sessionStorage();
  if (!ss) return;
  const raw = ss.getItem(LEGACY_SS_KEY);
  if (!raw) return;
  try {
    const pending = JSON.parse(raw) as LegacyPendingLoopCommit;
    const id = orderId.trim().toLowerCase();
    const hashLock =
      pending.flow === "reverse-htlc" || pending.flow === "forward-htlc"
        ? pending.hashLock?.trim().toLowerCase()
        : undefined;
    if (hashLock === id) {
      ss.removeItem(LEGACY_SS_KEY);
    }
  } catch {
    ss.removeItem(LEGACY_SS_KEY);
  }
}

/** Legacy sessionStorage secret fallback (pre-PR2 in-flight swaps only). */
export function recallPendingHtlcSecret(orderId: string): string | null {
  const ss = sessionStorage();
  if (!ss) return null;
  const raw = ss.getItem(LEGACY_SS_KEY);
  if (!raw) return null;
  try {
    const pending = JSON.parse(raw) as LegacyPendingLoopCommit;
    const id = orderId.trim().toLowerCase();
    if (
      (pending.flow === "reverse-htlc" || pending.flow === "forward-htlc") &&
      pending.hashLock?.trim().toLowerCase() === id &&
      typeof pending.secret === "string" &&
      pending.secret.length > 0
    ) {
      return pending.secret;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** @deprecated Prefer hasPendingLoopIntent — secrets are no longer stored here. */
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

export function canReconnectReverseLoopCommit(
  orderId: string,
  order: { direction?: string; counterMode?: string; status?: string }
): boolean {
  if (order.direction !== "canton-to-evm" || order.counterMode !== "loop") {
    return false;
  }
  if (order.status === "main_locked" || order.status === "counter_locked") {
    return false;
  }
  const pending = readPendingLoopCommitByKey(orderId);
  return (
    pending?.flow === "reverse-htlc" &&
    typeof pending.submitUpdateId === "string" &&
    pending.submitUpdateId.length > 0 &&
    typeof pending.createdAt === "number"
  );
}

/**
 * Encrypted per-browser HTLC secret vault (v3).
 *
 * Persists each swap's secret so the user can claim from /orders or after refresh.
 * The secret stays on-device until claim; it is never sent to our server pre-claim.
 *
 * Two unlock anchors (see docs/HTLC-SECRET-VAULT.md):
 *   - managed-session — email / warpx-hosted users (Supabase session + party)
 *   - loop-wallet     — Loop users (AES key from party + public_key; signMessage unlock gate)
 */

export type LoopVaultProvider = {
  party_id: string;
  public_key: string;
  signMessage: (message: string) => Promise<unknown>;
};

export type VaultAnchor = "managed-session" | "loop-wallet";

export type SecretVaultMeta = {
  direction: "evm-to-canton" | "canton-to-evm";
  counterMode: "managed" | "loop";
  userCantonParty: string;
  userEvmAddress: string;
  /** Unix seconds — purge after user timelock (+ buffer). */
  expiresAt: number;
};

export type VaultRecallContext = {
  loopProvider?: LoopVaultProvider | null;
  evmAddress?: string | null;
  sessionUserId?: string | null;
  sessionPartyId?: string | null;
  /** Order metadata for lazy v1 → v3 migration on recall (never bypasses gates). */
  orderMeta?: SecretVaultMeta;
};

/** Build vault metadata from a loaded order row (history / getOrder). */
export function vaultMetaFromOrder(o: {
  direction: SecretVaultMeta["direction"];
  counterMode?: string;
  userCantonParty?: string;
  userEvmAddress?: string;
  userTimelock?: number;
  solverTimelock?: number;
}): SecretVaultMeta | null {
  if (!o.userCantonParty || !o.userEvmAddress || !o.userTimelock) return null;
  if (o.counterMode !== "managed" && o.counterMode !== "loop") return null;
  return {
    direction: o.direction,
    counterMode: o.counterMode,
    userCantonParty: o.userCantonParty,
    userEvmAddress: o.userEvmAddress,
    expiresAt: vaultExpiryFromTimelock(o.userTimelock, {
      direction: o.direction,
      solverTimelock: o.solverTimelock,
    }),
  };
}

type VaultEntryV3 = SecretVaultMeta & {
  v: 3;
  iv: string;
  ct: string;
  anchor: VaultAnchor;
  /** Loop anchor: binds ciphertext to the wallet that created the swap. */
  loopPublicKey?: string;
};

const KEY_V3 = "oranj.htlc.secrets.v3";
const KEY_V2 = "oranj.htlc.secrets.v2";
const KEY_V1 = "oranj.htlc.secrets.v1";
const ACTIVE_SWAP_KEY = "oranj.htlc.active";
const VAULT_DOMAIN = "oranj-htlc-vault-v1";
const EXPIRY_BUFFER_SEC = 3600;
const LOOP_UNLOCK_CACHE_MS = 30 * 60 * 1000;

type VaultStore = Record<string, VaultEntryV3>;

type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

let storageOverride: StorageLike | null = null;
let loopUnlockCache: { partyId: string; until: number } | null = null;
let loopUnlockBypassForTests = false;

/** @internal test hook — bypass Loop signMessage gate without exposing on prod context type. */
export function __setLoopUnlockBypassForTests(enabled: boolean): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("__setLoopUnlockBypassForTests is disabled in production");
  }
  loopUnlockBypassForTests = enabled;
}

/** @internal test hook */
export function __setVaultStorageForTests(store: StorageLike | null): void {
  storageOverride = store;
}

export function pickVaultAnchor(counterMode: "managed" | "loop"): VaultAnchor {
  return counterMode === "managed" ? "managed-session" : "loop-wallet";
}

export function vaultExpiryFromTimelock(
  userTimelock: number,
  opts?: { direction?: SecretVaultMeta["direction"]; solverTimelock?: number },
): number {
  let until = userTimelock;
  // Reverse: user claims on EVM before the shorter solver-side timelock ends.
  if (opts?.direction === "canton-to-evm" && opts.solverTimelock) {
    until = Math.min(userTimelock, opts.solverTimelock);
  }
  return until + EXPIRY_BUFFER_SEC;
}

export function loopVaultUnlockMessage(partyId: string): string {
  return `Oranj HTLC Vault Unlock for ${partyId}`;
}

export function readActiveHtlcSwap(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const id = sessionStorage.getItem(ACTIVE_SWAP_KEY);
    return id && id.startsWith("0x") ? id : null;
  } catch {
    return null;
  }
}

function markActiveHtlcSwap(swapId: string): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(ACTIVE_SWAP_KEY, swapId);
  } catch {
    /* ignore */
  }
}

function clearActiveHtlcSwap(swapId?: string): void {
  if (typeof window === "undefined") return;
  try {
    if (!swapId || sessionStorage.getItem(ACTIVE_SWAP_KEY) === swapId) {
      sessionStorage.removeItem(ACTIVE_SWAP_KEY);
    }
  } catch {
    /* ignore */
  }
}

/** @internal test hook */
export function __readActiveHtlcSwapForTests(): string | null {
  return readActiveHtlcSwap();
}

export function clearLoopVaultSession(): void {
  loopUnlockCache = null;
}

function storage(): StorageLike | null {
  if (storageOverride) return storageOverride;
  if (typeof window === "undefined") return null;
  return localStorage;
}

function readStore(): VaultStore {
  const s = storage();
  if (!s) return {};
  try {
    return JSON.parse(s.getItem(KEY_V3) ?? "{}") as VaultStore;
  } catch {
    return {};
  }
}

function writeStore(v: VaultStore): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(KEY_V3, JSON.stringify(v));
  } catch {
    /* quota / disabled storage */
  }
}

function readLegacyPlaintext(swapId: string): string | null {
  const s = storage();
  if (!s) return null;
  try {
    const legacy = JSON.parse(s.getItem(KEY_V1) ?? "{}") as Record<string, string>;
    const val = legacy[swapId];
    return typeof val === "string" && val.length > 0 ? val : null;
  } catch {
    return null;
  }
}

function removeLegacyEntry(swapId: string): void {
  const s = storage();
  if (!s) return;
  try {
    const legacy = JSON.parse(s.getItem(KEY_V1) ?? "{}") as Record<string, string>;
    if (!legacy[swapId]) return;
    delete legacy[swapId];
    s.setItem(KEY_V1, JSON.stringify(legacy));
  } catch {
    /* ignore */
  }
}

function removeLegacyV2Store(): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(KEY_V2, "{}");
  } catch {
    /* ignore */
  }
}

function b64Encode(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

function b64Decode(str: string): Uint8Array<ArrayBuffer> {
  const bin = atob(str);
  const buf = new ArrayBuffer(bin.length);
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)!;
  return bytes;
}

async function sha256(data: BufferSource): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", data);
}

async function importAesKey(raw: ArrayBuffer): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function deriveManagedVaultKey(userId: string, cantonParty: string): Promise<CryptoKey> {
  const material = new TextEncoder().encode(`${VAULT_DOMAIN}:managed:${userId}:${cantonParty}`);
  return importAesKey(await sha256(material));
}

export async function deriveLoopVaultKey(publicKey: string, partyId: string): Promise<CryptoKey> {
  const material = new TextEncoder().encode(`${VAULT_DOMAIN}:loop:${partyId}:${publicKey}`);
  return importAesKey(await sha256(material));
}

async function encryptWithKey(key: CryptoKey, secret: string): Promise<{ iv: string; ct: string }> {
  const ivBuf = new ArrayBuffer(12);
  const iv = new Uint8Array(ivBuf);
  crypto.getRandomValues(iv);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(secret));
  return { iv: b64Encode(ivBuf), ct: b64Encode(ct) };
}

async function decryptWithKey(key: CryptoKey, iv: string, ct: string): Promise<string | null> {
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64Decode(iv) },
      key,
      b64Decode(ct),
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

export function normalizeEvmAddress(addr: string): string {
  return addr.trim().toLowerCase();
}

function entryExpired(entry: VaultEntryV3): boolean {
  return Math.floor(Date.now() / 1000) > entry.expiresAt;
}

export function evmAddressMatches(
  entry: Pick<SecretVaultMeta, "direction" | "userEvmAddress">,
  evmAddress: string | null | undefined,
): boolean {
  if (entry.direction !== "canton-to-evm") return true;
  if (!evmAddress) return false;
  return normalizeEvmAddress(evmAddress) === normalizeEvmAddress(entry.userEvmAddress);
}

function isVaultEntry(x: unknown): x is VaultEntryV3 {
  return typeof x === "object" && x !== null && (x as VaultEntryV3).v === 3;
}

function parseSignature(sigRaw: unknown): string | null {
  if (typeof sigRaw === "string") return sigRaw;
  const sig = (sigRaw as { signature?: string })?.signature;
  return typeof sig === "string" ? sig : null;
}

async function ensureLoopVaultUnlock(provider: LoopVaultProvider): Promise<boolean> {
  if (loopUnlockBypassForTests) return true;
  if (loopUnlockCache?.partyId === provider.party_id && loopUnlockCache.until > Date.now()) {
    return true;
  }
  try {
    const signature = parseSignature(await provider.signMessage(loopVaultUnlockMessage(provider.party_id)));
    if (!signature) return false;
    loopUnlockCache = { partyId: provider.party_id, until: Date.now() + LOOP_UNLOCK_CACHE_MS };
    return true;
  } catch {
    return false;
  }
}

/** Drop expired entries from storage. */
export function purgeExpiredSecrets(): void {
  if (!storage()) return;
  const store = readStore();
  let changed = false;
  for (const [id, raw] of Object.entries(store)) {
    if (isVaultEntry(raw) && entryExpired(raw)) {
      delete store[id];
      changed = true;
    }
  }
  if (changed) writeStore(store);
}

/** True if a non-expired vault entry exists (sync UI probe — does not decrypt). */
export function hasStoredSecret(swapId: string): boolean {
  if (!storage()) return false;
  purgeExpiredSecrets();
  if (isVaultEntry(readStore()[swapId])) return true;
  return !!readLegacyPlaintext(swapId);
}

/**
 * Store an encrypted secret (call right after generateSecret + createOrder).
 * Returns false if prerequisites are missing (caller must abort or warn).
 */
export async function rememberSecret(
  swapId: string,
  secret: string,
  meta: SecretVaultMeta,
  ctx: VaultRecallContext,
): Promise<boolean> {
  if (!storage()) return false;
  purgeExpiredSecrets();

  const anchor = pickVaultAnchor(meta.counterMode);
  let key: CryptoKey | null = null;
  let loopPublicKey: string | undefined;

  if (anchor === "managed-session") {
    const userId = ctx.sessionUserId;
    if (!userId || !meta.userCantonParty) return false;
    key = await deriveManagedVaultKey(userId, meta.userCantonParty);
  } else {
    const provider = ctx.loopProvider;
    if (!provider?.public_key || !provider.party_id) return false;
    if (provider.party_id !== meta.userCantonParty) return false;
    key = await deriveLoopVaultKey(provider.public_key, provider.party_id);
    loopPublicKey = provider.public_key;
  }
  if (!key) return false;

  const { iv, ct } = await encryptWithKey(key, secret);
  const store = readStore();
  store[swapId] = {
    v: 3,
    iv,
    ct,
    anchor,
    direction: meta.direction,
    counterMode: meta.counterMode,
    userCantonParty: meta.userCantonParty,
    userEvmAddress: normalizeEvmAddress(meta.userEvmAddress),
    expiresAt: meta.expiresAt,
    loopPublicKey,
  };
  writeStore(store);
  removeLegacyEntry(swapId);
  removeLegacyV2Store();
  markActiveHtlcSwap(swapId);
  return true;
}

async function migrateLegacyIfNeeded(
  swapId: string,
  ctx: VaultRecallContext,
): Promise<void> {
  const legacy = readLegacyPlaintext(swapId);
  if (!legacy || !ctx.orderMeta) return;
  const ok = await rememberSecret(swapId, legacy, ctx.orderMeta, ctx);
  if (ok) removeLegacyEntry(swapId);
}

/** Recover a swap's secret, or null if unavailable / unlock failed. */
export async function recallSecret(swapId: string, ctx: VaultRecallContext): Promise<string | null> {
  if (!storage()) return null;
  purgeExpiredSecrets();

  await migrateLegacyIfNeeded(swapId, ctx);
  // v1 plaintext is never returned directly — only migrated v3 entries pass gates below.

  const raw = readStore()[swapId];
  if (!isVaultEntry(raw) || entryExpired(raw)) return null;
  if (!evmAddressMatches(raw, ctx.evmAddress)) return null;

  if (raw.anchor === "managed-session") {
    if (!ctx.sessionUserId || !ctx.sessionPartyId) return null;
    if (ctx.sessionPartyId !== raw.userCantonParty) return null;
    const key = await deriveManagedVaultKey(ctx.sessionUserId, raw.userCantonParty);
    return decryptWithKey(key, raw.iv, raw.ct);
  }

  const provider = ctx.loopProvider;
  if (!provider || provider.party_id !== raw.userCantonParty) return null;
  if (raw.loopPublicKey && provider.public_key !== raw.loopPublicKey) return null;
  const unlocked = await ensureLoopVaultUnlock(provider);
  if (!unlocked) return null;
  const pubKey = raw.loopPublicKey ?? provider.public_key;
  const key = await deriveLoopVaultKey(pubKey, raw.userCantonParty);
  return decryptWithKey(key, raw.iv, raw.ct);
}

/** Drop a swap's secret once settled / refunded / retaken. */
export function forgetSecret(swapId: string): void {
  if (!storage()) return;
  const store = readStore();
  if (store[swapId]) {
    delete store[swapId];
    writeStore(store);
  }
  removeLegacyEntry(swapId);
  clearActiveHtlcSwap(swapId);
}

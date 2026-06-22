import type { CantonSwapOrder } from "./canton-swap-types";

/** Loop swaps get more time than the RFQ quote TTL (sign + daemon fill). */
export const LOOP_SWAP_ORDER_TTL_SECONDS = 900;

/** Counter-leg offer window after solver fill (Splice executeBefore). */
export const LOOP_COUNTER_OFFER_TTL_SECONDS = 24 * 60 * 60;

/** User sell-leg offer TTL when preparing Loop sign (matches Splice 24h convention). */
export const LOOP_USER_LEG_OFFER_TTL_SECONDS = 24 * 60 * 60;

/** Solver auto-accepted user sell via TransferPreapproval — no pending offer CID. */
export const LOOP_USER_LEG_PREAPPROVAL_SETTLED = "transfer-preapproval-settled";

/** Min wait after counter leaves pending ACS before vault may reissue (ledger propagation). */
export const COUNTER_REISSUE_COOLDOWN_SECONDS = 90;

export function counterReissueCooldownElapsed(
  clearedAtUnix: number | undefined,
  nowUnix = Math.floor(Date.now() / 1000)
): boolean {
  if (!clearedAtUnix) return false;
  return nowUnix >= clearedAtUnix + COUNTER_REISSUE_COOLDOWN_SECONDS;
}

export function loopFillCommandId(orderId: string): string {
  return `canton-swap-fill-${orderId}`;
}

export function loopCounterReissueCommandId(orderId: string, attempt: number): string {
  return `canton-swap-counter-${orderId}-${attempt}`;
}

/** Transient fill errors — retry via daemon reconcile, not terminal failed. */
export function isRetriableLoopFillError(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    msg.includes("offer not visible") ||
    msg.includes("pending offer not found") ||
    msg.includes("cannot fill atomically") ||
    msg.includes("Retry shortly") ||
    msg.includes("still in flight") ||
    msg.includes("duplicate command committed but fill transaction not found") ||
    m.includes("transferfactory registry call failed") ||
    m.includes("failed to reach consensus") ||
    m.includes("scan nodes")
  );
}

export function isLoopUserLegPreapprovalSettled(cid: string | undefined | null): boolean {
  return cid === LOOP_USER_LEG_PREAPPROVAL_SETTLED;
}

export const QUOTE_GRACE_SECONDS = 30;

/** Managed open orders: daemon must not kill create→settle (seconds). Abandon after 5 min. */
export const MANAGED_OPEN_TTL_SECONDS = 300;

/** Do not vault-migrate brand-new loop open orders — create→sign needs a few seconds. */
export const VAULT_MIGRATION_GRACE_SECONDS = 30;

function trimParty(party: string | undefined | null): string {
  return (party ?? "").trim();
}

/** True when order legs already target the configured C2C vault. */
export function orderUsesCurrentVault(
  o: CantonSwapOrder,
  vaultParty: string
): boolean {
  const vault = trimParty(vaultParty);
  if (!vault) return true;
  const settlement = trimParty(o.settlementParty);
  if (settlement) return settlement === vault;
  return trimParty(o.solverParty) === vault;
}

/** Expire loop-era orders stuck on a pre-vault party (loop only). */
export function shouldExpireForVaultMigration(
  o: CantonSwapOrder,
  vaultParty: string,
  now = Math.floor(Date.now() / 1000)
): boolean {
  if (o.walletMode !== "loop") return false;
  // Never vault-migrate after the user signed or fill is in flight — even if a
  // remote daemon has a stale CANTON_SWAP_SETTLEMENT_PARTY env.
  if (o.status !== "open") return false;
  if (o.userLegOfferCid || o.userLegSubmitUpdateId) return false;
  if (!trimParty(vaultParty)) return false;
  // Vault-backed orders (all new C2C since settlement_party) — never auto-expire.
  if (trimParty(o.settlementParty)) return false;
  if (orderUsesCurrentVault(o, vaultParty)) return false;
  if (o.createdAt <= 0) return false;
  if (now - o.createdAt < VAULT_MIGRATION_GRACE_SECONDS) {
    return false;
  }
  return true;
}

/** Daemon mis-expired an order that already targets the current vault (e.g. stale env). */
export function isFalseVaultMigrationExpire(
  o: CantonSwapOrder,
  vaultParty: string,
  opts?: { afterUserLeg?: boolean }
): boolean {
  const base =
    o.status === "expired" &&
    (o.failureReason?.includes("settlement vault migration") ?? false) &&
    orderUsesCurrentVault(o, vaultParty);
  if (opts?.afterUserLeg) return base && !!o.userLegOfferCid;
  return base && !o.userLegOfferCid;
}

export function loopOrderDeadline(o: CantonSwapOrder): number {
  return o.createdAt + LOOP_SWAP_ORDER_TTL_SECONDS;
}

export function quoteDeadline(o: CantonSwapOrder): number {
  return o.quoteExpiresAt + QUOTE_GRACE_SECONDS;
}

export function orderDeadline(o: CantonSwapOrder): number {
  if (o.walletMode === "loop") return loopOrderDeadline(o);
  if (o.status === "settling") return Number.MAX_SAFE_INTEGER;
  if (o.status === "open") return o.createdAt + MANAGED_OPEN_TTL_SECONDS;
  return quoteDeadline(o);
}

/** Loop fill submit committed or retry in progress — do not expire/reject user leg. */
export function isLoopFillInFlight(o: CantonSwapOrder): boolean {
  if (o.walletMode !== "loop") return false;
  if (o.status === "filling") return true;
  if (o.status !== "user_locked" || o.settlementUpdateId) return false;
  const msg = o.failureReason ?? "";
  return (
    msg.includes("Fill still processing") ||
    msg.includes("submission in flight") ||
    msg.includes("Retrying after transient fill failure")
  );
}

export function isOrderExpired(o: CantonSwapOrder, now = Math.floor(Date.now() / 1000)): boolean {
  if (isLoopFillInFlight(o)) return false;
  if (
    o.walletMode === "managed" &&
    o.status === "settling"
  ) {
    return false;
  }
  if (
    o.walletMode === "loop" &&
    o.status === "user_locked" &&
    o.settlementUpdateId &&
    o.counterLegOfferCid
  ) {
    // Solver already filled — user must accept counter; do not auto-expire.
    return false;
  }
  return now > orderDeadline(o);
}

/** Loop fill already ran and is waiting on user counter-accept. */
export function isLoopFillPendingCounterAccept(o: CantonSwapOrder): boolean {
  return (
    o.walletMode === "loop" &&
    o.status === "user_locked" &&
    !!o.settlementUpdateId &&
    !!o.counterLegOfferCid
  );
}

/** Managed settle committed; user must accept counter offer. */
export function isManagedPendingCounterAccept(o: CantonSwapOrder): boolean {
  return (
    o.walletMode === "managed" &&
    o.status === "settling" &&
    !!o.settlementUpdateId &&
    !!o.counterLegOfferCid
  );
}

export function isPendingCounterAccept(o: CantonSwapOrder): boolean {
  return isLoopFillPendingCounterAccept(o) || isManagedPendingCounterAccept(o);
}

export function shouldSkipLoopFill(o: CantonSwapOrder): boolean {
  return isLoopFillPendingCounterAccept(o);
}

export function assertOrderNotExpired(o: CantonSwapOrder, now = Math.floor(Date.now() / 1000)): void {
  if (isOrderExpired(o, now)) {
    throw new Error(o.walletMode === "loop" ? "order expired" : "quote expired");
  }
}

/**
 * Decide what createOrder should persist. SECURITY: a re-POST with the same id must
 * NOT overwrite a live order — that would reset status/terms and desync settlement.
 */
export function resolveCreateCantonSwapOrder(
  existing: CantonSwapOrder | undefined,
  incoming: Omit<CantonSwapOrder, "status" | "createdAt">,
  nowSeconds: number
): { order: CantonSwapOrder; isNew: boolean } {
  if (existing) {
    const immutableTermsMatch =
      existing.fromAsset === incoming.fromAsset &&
      existing.toAsset === incoming.toAsset &&
      existing.inAmount === incoming.inAmount &&
      existing.outAmount === incoming.outAmount &&
      existing.minOut === incoming.minOut &&
      existing.quoteExpiresAt === incoming.quoteExpiresAt &&
      existing.userParty === incoming.userParty &&
      existing.solverParty === incoming.solverParty &&
      (existing.settlementParty ?? existing.solverParty) ===
        (incoming.settlementParty ?? incoming.solverParty) &&
      existing.walletMode === incoming.walletMode &&
      existing.networkFeeCc === incoming.networkFeeCc &&
      existing.networkFeeExpiresAt === incoming.networkFeeExpiresAt;
    if (!immutableTermsMatch) {
      throw new Error("order id already exists with different immutable terms");
    }
    return { order: existing, isNew: false };
  }
  return {
    order: { ...incoming, status: "open", createdAt: nowSeconds },
    isNew: true
  };
}

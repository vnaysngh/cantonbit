import { verifySecret } from "./htlc-client";
import {
  recallSecret,
  rememberSecret,
  vaultExpiryFromTimelock,
  type SecretVaultMeta,
  type VaultRecallContext
} from "./secret-vault";
import {
  clearLegacyPendingLoopCommitIfMatched,
  recallPendingHtlcSecret
} from "./swap-pending-loop-commit";

export const HTLC_VAULT_FAIL_MSG =
  "Could not securely save this swap secret on this device. Reconnect your wallet/account and try again.";

/** Persist HTLC secret to the vault and verify readback before any irreversible step. */
export async function ensureHtlcSecretVaulted(
  swapId: string,
  secret: string,
  meta: Omit<SecretVaultMeta, "expiresAt"> & {
    userTimelock: number;
    solverTimelock?: number;
  },
  ctx: VaultRecallContext
): Promise<void> {
  const orderMeta: SecretVaultMeta = {
    ...meta,
    expiresAt: vaultExpiryFromTimelock(meta.userTimelock, {
      direction: meta.direction,
      solverTimelock: meta.solverTimelock
    })
  };
  const ok = await rememberSecret(swapId, secret, orderMeta, ctx);
  if (!ok) throw new Error(HTLC_VAULT_FAIL_MSG);
  const recalled = await recallSecret(swapId, {
    ...ctx,
    orderMeta,
    evmAddress: ctx.evmAddress ?? meta.userEvmAddress
  });
  if (recalled !== secret) throw new Error(HTLC_VAULT_FAIL_MSG);
  clearLegacyPendingLoopCommitIfMatched(swapId);
}

/** Shared claim-time secret resolution for /swap, /orders, and /swap/orders/[id]. */
export async function resolveHtlcClaimSecret(
  orderId: string,
  hashLock: string,
  opts: {
    manualSecret?: string;
    ctx: VaultRecallContext;
    orderMeta?: SecretVaultMeta;
  }
): Promise<string | null> {
  const manual = opts.manualSecret?.trim();
  if (manual) {
    return verifySecret(manual, hashLock) ? manual : null;
  }

  let secret = await recallSecret(orderId, {
    ...opts.ctx,
    orderMeta: opts.orderMeta,
    evmAddress: opts.ctx.evmAddress ?? opts.orderMeta?.userEvmAddress
  });
  if (secret) {
    return verifySecret(secret, hashLock) ? secret : null;
  }

  const pending = recallPendingHtlcSecret(orderId);
  if (!pending || !verifySecret(pending, hashLock)) return null;

  if (opts.orderMeta) {
    await rememberSecret(orderId, pending, opts.orderMeta, {
      ...opts.ctx,
      orderMeta: opts.orderMeta
    });
    secret = await recallSecret(orderId, {
      ...opts.ctx,
      orderMeta: opts.orderMeta,
      evmAddress: opts.ctx.evmAddress ?? opts.orderMeta.userEvmAddress
    });
    if (secret && verifySecret(secret, hashLock)) {
      clearLegacyPendingLoopCommitIfMatched(orderId);
      return secret;
    }
  }
  return pending;
}

/** Recover a secret when resuming a pending HTLC confirm (vault first, legacy session fallback). */
export async function recallHtlcConfirmSecret(
  swapId: string,
  meta: Omit<SecretVaultMeta, "expiresAt"> & {
    userTimelock: number;
    solverTimelock?: number;
  },
  ctx: VaultRecallContext
): Promise<string> {
  const orderMeta: SecretVaultMeta = {
    ...meta,
    expiresAt: vaultExpiryFromTimelock(meta.userTimelock, {
      direction: meta.direction,
      solverTimelock: meta.solverTimelock
    })
  };
  const fromVault = await recallSecret(swapId, {
    ...ctx,
    orderMeta,
    evmAddress: ctx.evmAddress ?? meta.userEvmAddress
  });
  if (fromVault) return fromVault;
  const legacy = recallPendingHtlcSecret(swapId);
  if (legacy) return legacy;
  throw new Error(HTLC_VAULT_FAIL_MSG);
}

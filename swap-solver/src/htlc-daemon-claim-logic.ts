/** Default pre-reveal margin — refuse new locks when unlock is too soon. */
export const EVM_PRE_REVEAL_CLAIM_MARGIN_SECONDS = 10 * 60;

/**
 * Pre-reveal only: defer counter-lock / lock-counter when the WBTC unlock is too
 * close. Post-reveal the preimage is public and the solver must always attempt claim.
 */
export function shouldDeferEvmClaimForPreRevealMargin(params: {
  unlockTimeSec: number;
  nowSec: number;
  marginSec?: number;
}): boolean {
  const margin = params.marginSec ?? EVM_PRE_REVEAL_CLAIM_MARGIN_SECONDS;
  return params.unlockTimeSec - params.nowSec < margin;
}

/** Post-reveal: never skip claim for margin — race the timelock. */
export function shouldAttemptPostRevealEvmClaim(): true {
  return true;
}

# Consolidated Security & Code Audit — Master Findings

_Generated 2026-06-26; re-cut by **live-deployment reachability** per review feedback._

The first version mixed "code exists" with "exploitable on the live deployment." This version
classifies every open finding as **LIVE / CONFIG-DEPENDENT / DORMANT-OIF** and ranks live risk first.

## TL;DR

- **No CRITICAL is live.** The prior `swap-solver/src/api.ts:454` CRITICAL (OIF intake never re-prices)
  is **DORMANT** — that intake has zero callers in the app, `serve.ts` is not in the deploy, and the
  live HTLC engine re-prices via `assertOrderAmounts`. Real code defect, not a live risk.
- **The live top-priority items are funds HIGHs on the deployed engine:** burn double-burn on 409
  retry (`redeem/submit-withdraw`) and forward `lockCounter` double-allocate (`htlc-service-singleton`).
- Live open: **0 CRITICAL · 8 HIGH · 13 MEDIUM.** Plus 4 config-dependent, 5 dormant-OIF.

## Deployed surface (README §11)

Web (`/api/*`, the swap UI) + `htlc-solver-daemon.mts` + `canton-swap-daemon.mts`. The OIF intake
(`swap-solver/src/serve.ts` via `npm run api`) and the `solver:watch` legacy OIF watcher are **NOT
deployed**. The swap UI (`app/swap/page.tsx`) calls `/api/htlc/*` + `/api/canton/swap/*` only.

## Audit passes this session

| Pass | Scope | Outcome |
|---|---|---|
| Swap-stack review | HTLC + C2C double-pay cluster | fed the 06-21 remediation |
| Intent-refactor review | prepare/commit split | fixed |
| Whole-app audit (06-25) | auth, funds, daemons, quotes | 17/20 fixed, H-3 deferred |
| Remediation review | verify the fixes | found+retracted false middleware CRITICAL |
| **Full-app audit (06-26)** | every route/page/fn, WHOLE solver+daemon, contract, migrations; 215 files; 95→82 verified | **Part A** |

**Build:** `npm run build:prod` green; `[assert-next-proxy] proxy compiled as /_middleware` (middleware wired).

---

# Part A — OPEN ISSUES (30), ranked by LIVE-DEPLOYMENT reachability

**Reachability** (added per review feedback — the doc previously mixed code-severity with exploitability):
- **LIVE** — on the deployed WarpX swap engine: `app/api/htlc/*`, `app/api/canton/swap/*`, `app/api/mint|redeem/*`, `lib/htlc-service-singleton.ts`, `lib/canton-swap-*`, the **deployed** daemons (`htlc-solver-daemon.mts`, `canton-swap-daemon.mts`), and the deployed contract.
- **CONFIG-DEPENDENT** — real only under a specific env/misconfig (unset feed, proxy depth, leaked secret).
- **DORMANT-OIF** — the legacy OIF solver intake (`swap-solver/src/{api,serve,delivery,canton}.ts`, `npm run api`). **Verified unreachable:** `submitOrder`/`reportAccepted`/`refundOrder` have ZERO callers in the app; `serve.ts` is NOT in the README §11 deploy (Web + the two daemons only); neither deployed daemon imports the intake. The live HTLC path re-prices via `assertOrderAmounts`.

> **Headline correction:** the prior `swap-solver/src/api.ts:454` "CRITICAL" (intake never re-prices) is **DORMANT** — the code is unsafe but not reachable on your deployment. The true top-priority items are the **LIVE** funds bugs below: burn double-burn and forward lockCounter double-allocate.

**LIVE counts: 0 CRITICAL · 8 HIGH · 13 MEDIUM.** Plus 4 CONFIG-DEPENDENT. The 5 DORMANT-OIF
findings are now **✅ RESOLVED BY DELETION** (the legacy OIF stack was removed from the repo on
2026-06-26 — see the DORMANT-OIF section).

| # | Reach | Sev | Location | Issue |
|---|---|---|---|---|
| 1 | LIVE | HIGH | `app/api/htlc/[id]/claim-as-receiver/route.ts:13` | "TEST ONLY" fund-moving claim endpoint shipped in production route tree with weaker validation  |
| 2 | LIVE | HIGH | `lib/htlc-service-singleton.ts:1470` | Forward lockCounter allocate uses a non-deterministic commandId + per-call settlementId — doubl |
| 3 | LIVE | HIGH | `lib/canton-swap-service.ts:841` | In-flight counter-offer CBTC/CC liability dropped from float reservation accounting (floatReser |
| 4 | LIVE | HIGH | `lib/htlc-service-singleton.ts:608` | Reverse-Loop custody CBTC uncounted in unified float between offer-accept and updateId persist  |
| 5 | LIVE | HIGH | `app/api/redeem/submit-withdraw/route.ts:237` | Burn 409-conflict retry uses a NEW commandId — defeats Canton dedup and can double-burn |
| 6 | LIVE | HIGH | `lib/mint-processor.ts:728` | Mint processor transfers the holding's self-reported amount with no expected-amount cross-check |
| 7 | LIVE | HIGH | `app/api/mint/list-deposit-accounts/route.ts:178` | Ledger-fallback path attributes owner-less deposit accounts to the requesting user and writes c |
| 8 | LIVE | HIGH | `lib/canton-command-recovery.ts:80` | Offer-accept receipt scan is a single unpaginated /v2/updates/trees request — a truncated 200 r |
| 9 | LIVE | MEDIUM | `lib/htlc-service-singleton.ts:2988` | refundCounter relies only on status==counter_locked, lacking the explicit revealed-preimage / E |
| 10 | LIVE | MEDIUM | `swap-solver/src/htlc-solver-daemon.mts:982` | Forward Loop pending-offer accept lets the user consume the EVM claim margin before the solver  |
| 11 | LIVE | MEDIUM | `lib/htlc-service-singleton.ts:1160` | releaseReversePrelockWithoutCustody is user-callable and gates only on DB fields, not on-ledger |
| 12 | LIVE | MEDIUM | `lib/htlc-service-singleton.ts:3163` | Managed reverse order stuck with a bare Allocation (allocationCid set, htlcCid never persisted) |
| 13 | LIVE | MEDIUM | `lib/htlc-loop-custody-logic.ts:25` | isSafeReversePrelockReleaseCause uses broad substring regex that can mark unrelated failures as |
| 14 | LIVE | MEDIUM | `lib/mint-processor.ts:828` | Known-deferred H-3: mint user-resolution falls back to coordinator bitcoin_address when the Dep |
| 15 | LIVE | MEDIUM | `lib/canton-swap-settle.ts:522` | proveCounterDeliveredOnSettlement uses post-reissue attempt memo against the original (attempt- |
| 16 | LIVE | MEDIUM | `lib/canton-swap-service.ts:1042` | C2C counter-leg receipt verification throws on unreadable user ACS, aborting the whole reconcil |
| 17 | LIVE | MEDIUM | `swap-solver/src/htlc-solver-daemon.mts:520` | Reverse-Loop main_locking reconcile only recovers PENDING custody offers, not already-accepted- |
| 18 | LIVE | MEDIUM | `swap-solver/src/htlc-solver-daemon.mts:766` | Reverse solver WBTC retake is never recorded server-side (order lingers non-terminal, redundant |
| 19 | LIVE | MEDIUM | `swap-solver/src/htlc-solver-daemon.mts:616` | Reverse swap: solver locks WBTC with as little as 5 min of user-claim margin (asymmetric to the |
| 20 | LIVE | MEDIUM | `lib/canton-quote-sanity.ts:137` | C2C reference sanity circuit-breaker silently disabled for any non-CBTC/CC pair (USDCX) |
| 21 | LIVE | MEDIUM | `app/api/mint/process-transfers/route.ts:47` | Any authenticated user can trigger the global mint processor, enabling ledger-load amplificatio |
| 22 | CONFIG-DEPENDENT | MEDIUM | `contracts/src/OranjAttestorOracle.sol:98` | Trusted attestor key unilaterally releases locked WBTC (no on-chain Canton-delivery proof) |
| 23 | CONFIG-DEPENDENT | MEDIUM | `app/api/mint/process-transfers/route.ts:37` | Mint cron auth diverges from daemon secret chain (secret-parity fragility) |
| 24 | CONFIG-DEPENDENT | MEDIUM | `contracts/src/OranjAttestorOracle.sol:94` | Attestor-oracle release path is fully trusted (single hot key can release WBTC with no on-chain |
| 25 | CONFIG-DEPENDENT | MEDIUM | `lib/canton-swap-rate-limit.ts:24` | Missing x-forwarded-for collapses all IP-gated callers into one shared rate-limit bucket |
| 26 | DORMANT-OIF | CRITICAL | `swap-solver/src/api.ts:454` | Order intake never re-prices CBTC output vs WBTC input — user signs an arbitrarily over-priced  |
| 27 | DORMANT-OIF | HIGH | `swap-solver/src/delivery.ts:142` | CBTC float check is a read-only snapshot with no reservation — concurrent/duplicate deliveries  |
| 28 | DORMANT-OIF | HIGH | `swap-solver/src/canton.ts:734` | Cross-participant accept detection relies on a fragile template-substring heuristic; a false 'n |
| 29 | DORMANT-OIF | MEDIUM | `swap-solver/src/api.ts:142` | Rate limiter keys on socket remoteAddress only — behind a reverse proxy all clients share one b |
| 30 | DORMANT-OIF | MEDIUM | `swap-solver/src/serve.ts:100` | OIF-escrow solver de-peg circuit breaker fails open (par 1.0 pricing) when DEPEG_FEED is unset  |

---

## LIVE — on the deployed engine (fix these first)

### HIGH (LIVE)

### `app/api/htlc/[id]/claim-as-receiver/route.ts:13` — "TEST ONLY" fund-moving claim endpoint shipped in production route tree with weaker validation than the real path  
_LIVE · HIGH · CONFIRMED_

**Scenario:** This route exercises a real on-ledger HtlcLock.Claim (moves CBTC to order.userCantonParty) but is only gated by requireDaemon (daemon bearer + mainnet block). On devnet/testnet the mainnet guard is a no-op (isWebMainnetAllowed() returns true when NETWORK.name !== 'mainnet'), so anyone holding HTLC_DAEMON_SECRET/CRON_SECRET/API_AUTH_TOKEN can claim any order's counter leg. Unlike the production claimCounterAsBackend it (1) does NOT call preimageMatches before submitting (relies solely on the on-ledger keccak gate), (2) passes NO deterministic commandId to claimAsReceiver, so a retry after a committed-but-lost response can attempt a second claim/allocation consumption rather than dedup, and (3) then calls recordCounterClaimed which for a forward order publishes revealedPreimage. It bypasses the verifyEvmLock solver-robbery guard entirely. A stale/buggy daemon or a leaked secret on a non-mainnet env can settle/reveal orders out of band.

**Fix:** Hard-gate this endpoint behind an explicit test-only env flag (e.g. throw unless process.env.HTLC_ENABLE_TEST_ROUTES === 'true') AND NODE_ENV !== 'production', or delete it from the deployed route tree. If kept, add preimageMatches(preimage, order.hashLock) and a deterministic commandId, and route through the same service method as production so the EVM-lock and idempotency guards apply uniformly.

### `lib/htlc-service-singleton.ts:1470` — Forward lockCounter allocate uses a non-deterministic commandId + per-call settlementId — double-allocation of solver CBTC in the commit-then-timeout window  
_LIVE · HIGH · CONFIRMED_

**Scenario:** In the forward (evm-to-canton) lockCounter, allocate() (line 1470) is called with NO commandId, so submit() falls back to a random commandId (htlc-onledger.ts:158), and settlementId embeds `now` (line 1476) so it is different on every call. The order's allocationCid is only persisted AFTER allocate returns (line 1482). If the Allocation COMMITS on-ledger but the HTTP response is lost (RPC/gateway timeout), the exception propagates, status stays counter_locking, and allocationCid is never saved. The next daemon poll re-enters lockCounter, sees `o.allocationCid` unset, and calls allocate() AGAIN with a fresh random commandId and a fresh settlementId — committing a SECOND Allocation that locks the solver vault's CBTC a second time. Unlike the reverse path (createOrRecoverReverseMainHtlc, line 1336, which uses deterministic commandId htlc-lock-main-${id} + recoverExactHtlcLockFromEvents), the forward path has neither ledger-dedup nor event-recovery, and the changing settlementId defeats even a settlementId-keyed recovery. Result: the vault's CBTC float is silently over-committed/leaked into an orphan allocation; float accounting (sum_vault_cbtc_reserved_sats) still reserves only one order's worth, so subsequent forward/C2C payouts can be drawn against CBTC that is actually double-locked, eventually under-paying or failing real swaps (solver insolvency / fund loss).

**Fix:** Pass a deterministic commandId (e.g. `htlc-lock-alloc-${o.id}`) to the forward allocate() call and a deterministic settlementId (drop the `-${now}` suffix; use `htlc-${o.id.slice(0,18)}`). Wrap the allocate in the same duplicate-command recovery used by createOrRecoverReverseMainHtlc: on 'duplicate command committed', fetchTransactionTreeByCommandId and recoverExactAllocationFromEvents to rebind the existing allocationCid instead of allocating again.

### `lib/canton-swap-service.ts:841` — In-flight counter-offer CBTC/CC liability dropped from float reservation accounting (floatReserved=false on pending-accept) → concurrent order can double-spend reclaimed float  
_LIVE · HIGH · CONFIRMED_

**Scenario:** applyLoopFillResult sets o.floatReserved=false (line 841) even when status becomes user_locked with a still-pending counter offer that has locked real vault CBTC/CC. The reservation SUM in sum_vault_cbtc_reserved_sats (migration 040 lines 52-60) and the CC branch (lines 224-231) only count canton_swap_orders where float_reserved=true AND status in (settling,filling,user_locked). So this order's outstanding counter-offer liability is invisible to the reservation math. While the counter offer's holding stays locked, currentSwapFloatUnits (live spendable holdings via getInstrumentHoldings, which skips locked holdings, canton.ts line 333-341) also excludes it, so the two views stay consistent. But the instant the counter offer expires, the lock's expiresAt passes and getInstrumentHoldings re-counts that holding as SPENDABLE (canton.ts line 335), feeding it into p_float_units, while the order remains user_locked/float_reserved=false and thus contributes 0 to v_reserved_units. A concurrent new order (or the same order's reissue) then reserves and spends that float — even though the original user can still accept the not-yet-withdrawn expired offer (see critical finding). Result: the vault under-reserves and can pay the same inventory twice.

**Fix:** Keep float_reserved=true (and include the order in the reservation SUM) for the entire window a counter offer is outstanding, i.e. until counterReceiptUpdateId proves delivery OR the offer is provably withdrawn. Only clear the reservation after terminal delivery/withdrawal proof, not at fill time when status is still user_locked/pending-accept.

### `lib/htlc-service-singleton.ts:608` — Reverse-Loop custody CBTC uncounted in unified float between offer-accept and updateId persist (insolvency window)  
_LIVE · HIGH · CONFIRMED_

**Scenario:** In commitReverseLoopOrder / confirmLoopSellerLock the vault calls acceptTransfer (line 593 / 2621) which MOVES the user's CBTC into the vault's free holdings, then only afterwards sets o.counterTransferUpdateId and status='main_locked' (lines 607-610 / 2637-2641). If the process crashes (or the putIfStatus write is lost) in that window, the order is stranded at status='main_locking' with counterTransferOfferCid set but counterTransferUpdateId=NULL. migration 040 sum_vault_cbtc_reserved_sats counts reverse-Loop custody ONLY when counter_transfer_update_id IS NOT NULL (040:41), so this CBTC is NOT subtracted as a liability — yet it is physically in getHoldings() and inflates floatSats. confirmLoopSellerLock recovery (singleton:2599) only scans LISTPENDING offers, but this offer was already accepted (no longer pending), and htlcOrderNeedsLoopRecovery (swap-order-visibility.ts:54) requires !counterTransferOfferCid, so neither recovers it. A concurrent forward HTLC accept (acceptWithFloatReservation) or C2C-CBTC reserve then sees that custody CBTC as available float and pays it out → vault double-spends the custodied CBTC and is left short when this reverse order later claims/refunds.

**Fix:** Make the reverse-Loop custody liability independent of counterTransferUpdateId: in migration 040 also count rows with direction='canton-to-evm' AND counter_mode='loop' AND counter_transfer_offer_cid IS NOT NULL AND status='main_locking' (offer bound = custody may already be in vault). Additionally, persist counterTransferUpdateId via a deterministic acceptTransfer commandId and recover an already-accepted custody offer in confirmLoopSellerLock by scanning the accept update tree (not just pending offers).

### `app/api/redeem/submit-withdraw/route.ts:237` — Burn 409-conflict retry uses a NEW commandId — defeats Canton dedup and can double-burn  
_LIVE · HIGH · CONFIRMED_

**Scenario:** The handler builds the burn body with a random commandId (line 170), then on an HTTP 409 from the ledger it regenerates commandId and re-submits the SAME {tokens, holdingCids, amount} (lines 237-250). Canton's command-level deduplication is keyed on commandId, so a fresh commandId bypasses it entirely. A 409 is exactly the signal that an identical command is already in flight/committed; re-submitting with a new id tells the ledger 'this is a brand-new burn.' If the original submit actually sequenced (the common cause of a 409), and the user's holdings are large enough / a second unlocked holding set exists, the party burns CBTC twice for one user intent, and the attestor creates two CBTCWithdrawRequests → two BTC withdrawals to the same destinationBtcAddress. There is no server-side idempotency record for burns (no row written before submit, commandId is ephemeral, holdingCids are not reserved), so a client-side retry (double-click — the page only disables via isProcessing, not a server lock; or a fetch timeout where the body actually committed) has the same effect. submitWithdraw on the client (lib/redeem.ts) and the redeem page provide no idempotency key either.

**Fix:** Do NOT regenerate commandId on 409 — a 409 means 'already accepted/in-flight,' so treat it as success (or re-query the ledger for the just-created WithdrawRequest/burn updateId and return that) rather than re-submitting. Derive a DETERMINISTIC commandId from (partyId, sorted holdingCids, amount, destinationBtcAddress) so any retry of the same burn collapses to one ledger command. Additionally, write a burn-intent row to Supabase keyed on that deterministic id before submitting, and reject a second submit-withdraw whose holdingCids overlap an in-flight/committed burn.

### `lib/mint-processor.ts:728` — Mint processor transfers the holding's self-reported amount with no expected-amount cross-check  
_LIVE · HIGH · CONFIRMED_

**Scenario:** runProcessorLocked reads every active warpx-owned Holding and transfers holding.amount (taken straight from createArgument.amount in getActiveWarpxHoldings, line 183) to the resolved user, with the only amount guard being 'not zero/empty' (line 738). The DB row's `amount` is overwritten from the same holding value (mintRow.amount, line 847) rather than compared to any expected deposit/mint amount. The deposit_accounts/mint flow never records how much BTC the user actually deposited, so the processor has no independent notion of the correct payout. If a holding lands on warpx whose creating txn archived a CBTCDepositAccount but whose amount is wrong (attestor/coordinator bug, a mis-minted holding, or a holding for a different deposit rolled-forward onto the same DA lineage), the processor pays that full amount to whichever user resolves from the DA lineage — there is no reconciliation against deposited sats. Combined with the rolled-forward DA matching (candidateDaIds includes rolledForwardDaOriginalId, line 791), a holding from deposit B can be attributed to the user of deposit A if they share a rolled-forward id.

**Fix:** Record the expected mint amount per deposit (e.g. from the confirmed BTC deposit / attestor ConfirmDeposit event) and refuse to transfer a holding whose amount does not match the expected amount for that specific deposit-account lineage within tolerance. Until that exists, at minimum log+alert and require manual review for any holding whose amount has no corresponding expected-deposit record, rather than auto-transferring an unverified amount.

### `app/api/mint/list-deposit-accounts/route.ts:178` — Ledger-fallback path attributes owner-less deposit accounts to the requesting user and writes canton_party_id under them  
_LIVE · HIGH · CONFIRMED_

**Scenario:** When the Supabase fast-path misses, the route queries the ledger as warpx and filters with `(!a.owner || a.owner === partyId)` (line 178) — accounts whose createArgument has NO owner field pass the filter for EVERY user. It then upserts those contractIds into deposit_accounts with user_id=this user and canton_party_id=this session's party (lines 189-201). Because deposit_account_contract_id is globally UNIQUE (migration 002) and the upsert uses ignoreDuplicates:true, the FIRST user to trigger the fallback for an owner-less DA permanently claims that contractId in Supabase. The mint processor's primary user-resolution (mint-processor.ts:795) keys on exactly deposit_accounts.canton_party_id; so a mis-attributed DA row routes a future mint for that account to the wrong user's Canton party. This is the same wrong-user class as deferred H-3 but reachable via the DB lookup, not just the address fallback.

**Fix:** In the fallback, drop accounts with no owner field instead of treating them as the caller's (require `a.owner === partyId`, not `!a.owner || ...`). Only persist a deposit_accounts row when the on-ledger owner equals the session party. Add a guard in the mint processor that the resolved canton_party_id equals the holding/DA on-ledger owner before transferring.

### `lib/canton-command-recovery.ts:80` — Offer-accept receipt scan is a single unpaginated /v2/updates/trees request — a truncated 200 response can be misread as not-received and trigger a duplicate counter payment (C2C Loop double-pay)  
_LIVE · HIGH · CONFIRMED_

**Scenario:** scanPartyUpdateTrees issues ONE POST /v2/updates/trees with beginExclusive..endInclusive and no limit/pagination, then parses res.json() as a flat array (lines 116-119) and iterates only what was returned. It only fails closed on a non-200 (lines 70-75, 107-114); a SUCCESSFUL but truncated/paged 200 (large offset range because the counter offer was created long before the user accepted it, or a busy party with many updates) silently omits the accept event. fetchOfferAcceptFromOffset then returns null → verifyCounterLegReceiptProof returns 'not_received' (canton-swap-settle.ts:902) instead of 'received'. In reconcileLoopCounterDelivery (canton-swap-service.ts ~1080-1175) that lets the order pass the cooldown + CAS guards and call reissueLoopCounterLeg → the vault delivers the counter asset (CC/CBTC) a SECOND time while the user already accepted the first offer. User is paid twice; vault float is drained. There is no assertion that the returned page covers the full [beginExclusive,endInclusive] range (e.g. last item offset == endInclusive).

**Fix:** Make the offset-anchored scan provably complete: page /v2/updates/trees until the last returned offset reaches endInclusive (or the API signals end-of-stream), and THROW (fail closed) if completeness cannot be established — never return null from a partial page. Equivalently, assert items cover the full range before concluding 'not found'. Until then, treat an empty/short result over a large range as status 'unknown' (which already blocks reissue) rather than 'not_received'.

### MEDIUM (LIVE)

### `lib/htlc-service-singleton.ts:2988` — refundCounter relies only on status==counter_locked, lacking the explicit revealed-preimage / EVM-claim guard that refundMainCanton has  
_LIVE · MEDIUM · CONFIRMED_

**Scenario:** refundMainCanton (line 2690-2692) explicitly rejects refunds once o.revealedPreimage is set and calls assertEvmCounterNotClaimed(o) before returning the user's CBTC, closing the refund-after-claim window. refundCounter (the forward solver-side CBTC refund) has no equivalent: it only checks status !== 'counter_locked' and the solverTimelock. If a forward order's on-ledger HtlcLock.Claim committed (preimage now public on-ledger, solver about to claim WBTC) but the DB never advanced past counter_locked (crash between ledger commit and the putIfStatus to counter_claimed), the auto-refund sweep could call refundCounter on a still-'counter_locked' row. Today the on-ledger allocation is already consumed so refundHtlcLock fails (no double-spend in practice), but the safety depends entirely on Canton contract consumption, not on app logic, and any future change to the claim/allocation lifecycle would expose a refund-after-reveal loss.

**Fix:** Mirror refundMainCanton's defense-in-depth in refundCounter: before issuing refundHtlcLock, reconcile the order's on-ledger claim status (or check whether the HtlcLock contract still exists / whether the EVM main leg shows the preimage), and refuse if the secret is already public. Do not rely solely on the DB status field plus ledger contract-not-found.

### `swap-solver/src/htlc-solver-daemon.mts:982` — Forward Loop pending-offer accept lets the user consume the EVM claim margin before the solver claims WBTC (reveal-margin enforced only at reveal, not at delivery)  
_LIVE · MEDIUM · CONFIRMED_

**Scenario:** verifyEvmLock enforces EVM_CLAIM_MARGIN_SECONDS (10 min) only at the main_locked→counter_claimed reveal transition (htlc-service-singleton.ts:1639). In the Loop forward path with NO CBTC preapproval, claimCounter creates a PENDING offer (delivered=false) and the daemon is correctly blocked from claiming WBTC until counterClaimUpdateId is set by the user's Loop accept (gate htlcForwardLoopDeliveryProven). A user can reveal, receive a pending offer, then deliberately delay accepting until shortly before userTimelock (the EVM unlockTime). When they finally accept, counterClaimUpdateId is set and the daemon's step-7 claim branch (line 938-1004) reads /preimage and calls escrow.write.claim WITHOUT re-checking the remaining EVM margin (unlike the lock branch at line 899). If the user timed the accept so the daemon's claim lands at/after userTimelock, escrow.claim reverts TooLate and the user can retake() their WBTC after userTimelock — collecting BOTH the CBTC (already accepted) and the WBTC. Probability is bounded by the daemon's priority-0 polling and the 10-min reveal margin, but the margin is not re-validated at accept/claim time, so a precise stall narrows it to a real race.

**Fix:** In the daemon step-7 counter_claimed branch (before escrow.write.claim at line 983), re-read the lock and refuse/alert if `Number(lock[0]) - nowSec < CLAIM_MARGIN` (mirror the lock-branch guard at line 899). Server-side, also re-run an EVM-margin check in claimCounter at the point the pending-offer accept is reconciled (reconcileLoopForwardCounterDelivery), and prefer/forcing direct preapproved delivery for forward Loop so the reveal→delivery gap cannot be user-controlled.

### `lib/htlc-service-singleton.ts:1160` — releaseReversePrelockWithoutCustody is user-callable and gates only on DB fields, not on-ledger custody (Loop reverse seller)  
_LIVE · MEDIUM · CONFIRMED_

**Scenario:** Reverse Loop flow: prepareReverseLoopLockIntent reserves WBTC, sets status=main_locking, and returns a CBTC->vault transfer command. The user signs it in Loop, so a *pending transfer offer is now live on-ledger*, but commitReverseLoopOrder has not yet run, so counterTransferOfferCid/counterTransferUpdateId/allocationCid/htlcCid are all still NULL in the DB. In that window the order owner POSTs /api/htlc/{id}/release-prelock (requireOrderOwner). releaseReversePrelockWithoutCustody sees no evidence linked (line 1163-1172), sets status=failed and evmFloatReserved=false, freeing the WBTC reservation. The check is purely DB-state; it never queries the solver ACS for a pending offer carrying this order's memo. The user's signed CBTC offer remains live on-ledger with no order tracking it. (In current code commitReverseLoopOrder persists the offer CID at line 582 *before* acceptTransfer, so a racing commit aborts safely and the orphaned offer merely expires — i.e. no direct double-pay today — but the guard relies on that incidental ordering rather than an on-ledger custody check, and the freed WBTC float is now available to other reverse orders while a user-signed CBTC offer for this one is still outstanding.)

**Fix:** Before releasing, scan the solver ACS for a pending transfer offer matching this order's reverseLoopCustodyMemo (the same predicate confirmLoopSellerLock uses); if one exists, refuse to release (keep the reservation / treat as custody-in-flight). Only release after confirming no order-scoped offer is live on-ledger.

### `lib/htlc-service-singleton.ts:3163` — Managed reverse order stuck with a bare Allocation (allocationCid set, htlcCid never persisted) is in no auto-refund bucket  
_LIVE · MEDIUM · CONFIRMED_

**Scenario:** In lockMainCanton the user's CBTC is allocated first (allocate() at line 2218, allocationCid persisted at 2268), then createOrRecoverReverseMainHtlc wraps it in an HtlcLock. If the HtlcLock create keeps failing (e.g. persistent ledger/package error) the order stays main_locking with allocationCid set but htlcCid unset — the user's CBTC is locked in a bare Splice Allocation. Every refund bucket in refundBuckets() (reverseMain line 3163, staleLoopSeller 3177, loopCustodyStalled 3191) filters on `!!o.htlcCid` or counterMode==='loop', so this row is selected by NONE of them. Recovery depends solely on reconcileReverseMainLocking (line 3202) re-invoking lockMainCanton to recover the allocation and create the HtlcLock; if that path also can't complete, the user's CBTC sits in the allocation until settleBefore (= userTimelock) lets Allocation_Withdraw return it — a multi-hour strand with no proactive sweep, and no DB-driven cleanup of the bare allocation.

**Fix:** Add a recovery bucket for canton-to-evm main_locking orders that have allocationCid && !htlcCid past a TTL: either finish the HtlcLock create or call withdrawAllocation (sender=user, backend CanActAs) on the bare allocation and mark the order failed/refunded. Do not gate reverse refund/cleanup solely on htlcCid.

### `lib/htlc-loop-custody-logic.ts:25` — isSafeReversePrelockReleaseCause uses broad substring regex that can mark unrelated failures as 'safe to release'  
_LIVE · MEDIUM · CONFIRMED_

**Scenario:** releaseStaleReversePrelockReservation (htlc-service-singleton.ts:3286) only frees a reverse WBTC reservation (status->failed, evmFloatReserved=false) when isSafeReversePrelockReleaseCause(cause) is true. That predicate matches any error message containing 'insufficient', 'not found', 'missing', 'expired', 'ambiguous', etc. Several of those substrings can appear in incidental error text from an RPC/ledger layer that is NOT actually a clean no-custody failure (e.g. a transient 'resource ... missing' or 'insufficient ... ' from infrastructure). Because the function reaches this branch only after the deterministic htlc-lock-alloc-${id} tree scan returns no allocation, a false 'safe' classification combined with a tree scan that transiently fails to surface a just-committed allocation could release the WBTC reservation while the user's CBTC allocation is actually live. The preceding fail-closed guards (no-evidence DB check at 3242-3251, scan-throw keeps reservation at 3261-3267) mitigate this, but the release decision still hinges on a fragile substring whitelist.

**Fix:** Replace the substring regex with an explicit allowlist of typed/coded causes (e.g. an error class or code emitted only by the genuine 'no offer / no holdings / expired offer' paths), and require positive proof of no on-ledger allocation (successful tree scan returning empty) rather than inferring safety from free-text.

### `lib/mint-processor.ts:828` — Known-deferred H-3: mint user-resolution falls back to coordinator bitcoin_address when the DepositAccount lineage is not in Supabase  
_LIVE · MEDIUM · CONFIRMED_

**Scenario:** When the archived/ rolled-forward DepositAccount cid is not found in deposit_accounts (or the lineage is ambiguous, >1 row), the processor cannot resolve user_id/canton_party_id from DA lineage and falls back to getBitcoinAddress(depositAccountContractId). The code already refuses to CREDIT by address (userId/cantonPartyId stay null and the address is used only for the mint_transfers metadata row), so this is not an active mis-credit, but the address-based resolution remains the documented H-3 deferral: deposit addresses can be reused/rolled-forward, so any future change that credits on bitcoin_address could deliver a mint to the wrong user. Flagging per instructions without re-litigating.

**Fix:** Keep resolution strictly DA-cid-lineage-based (as today). Before lifting H-3, add an explicit address->single-owner invariant check and a unique constraint so an address can never map to two users, and never use bitcoin_address as a credit key.

### `lib/canton-swap-settle.ts:522` — proveCounterDeliveredOnSettlement uses post-reissue attempt memo against the original (attempt-0) settlement tx → false negative blocks completion and drives unnecessary reissue  
_LIVE · MEDIUM · CONFIRMED_

**Scenario:** proveCounterDeliveredOnSettlement reads the ORIGINAL settlement tx (order.settlementUpdateId) but builds expectedMemo with cantonSwapCounterLegMemo(order, order.counterReissueAttempt ?? 0) (line 522-525). After any reissue, counterReissueAttempt is incremented (e.g. 1), so it searches the original fill tree for an attempt=1 counter memo. The original fill carried an attempt=0 memo. Because isOrderBoundSwapMemo() is true for the canton-swap prefix, transferMemoMatches() returns false (no legacy fallback), so counterLegDeliveredToUserInEvents fails to match a delivery that actually happened on the original direct fill. This makes tryCompleteFromSettlementDelivery return 'continue' instead of 'filled', and reconcileFilledLoopCounterProof / reconcileLoopCounters can proceed toward an unnecessary reissue — compounding the double-pay exposure in the critical finding rather than completing the order.

**Fix:** When proving delivery on the original settlement update id, match against attempt 0 (the attempt that the settlement tx actually used), independent of the order's current counterReissueAttempt. Track the attempt that produced each settlementUpdateId, or accept any attempt's order-bound memo for the same order id when scanning the original fill tree.

### `lib/canton-swap-service.ts:1042` — C2C counter-leg receipt verification throws on unreadable user ACS, aborting the whole reconcile sweep  
_LIVE · MEDIUM · CONFIRMED_

**Scenario:** reconcileLoopCounters calls verifyCounterLegReceiptProof (canton-swap-settle.ts:865) which uses listPendingOffersStrict(o.userParty) — that THROWS ('cannot verify pending transfers — party ACS unreadable') on a 403 from a Loop external party. The call at canton-swap-service.ts:1042 is not wrapped in try/catch, so a single order whose user ACS is transiently unreadable throws out of the per-order loop and aborts reconcileLoopCounters for ALL subsequent user_locked orders in that tick. This is fail-safe for double-pay (no reissue happens) but creates a liveness DoS: one stuck/unreadable order can indefinitely block counter-offer reissue and 'filled' finalization for every other Loop C2C order, stranding user funds in pending counter offers.

**Fix:** Wrap the per-order body of reconcileLoopCounters in try/catch (like reissue at line 1186) so one unreadable order is logged and skipped without aborting the sweep for the rest.

### `swap-solver/src/htlc-solver-daemon.mts:520` — Reverse-Loop main_locking reconcile only recovers PENDING custody offers, not already-accepted-but-unpersisted custody  
_LIVE · MEDIUM · CONFIRMED_

**Scenario:** The daemon's reverse main_locking branch (htlc-solver-daemon.mts:520) calls confirm-lock-loop which (confirmLoopSellerLock, singleton:2599) matches only offers still visible via listPendingOffers. For the crash window in finding 1 (offer already accepted by the vault, CBTC in custody, updateId unpersisted), confirm-lock-loop finds no pending offer and throws 'not visible on-ledger yet' forever, so the daemon logs 'waiting for Loop CBTC custody visibility' indefinitely (line 538) and the order is permanently stuck at main_locking. Combined with finding 1 the custodied CBTC is both stuck and uncounted; even absent the solvency angle this strands the user's CBTC with no automatic resolution.

**Fix:** In confirmLoopSellerLock, after the pending-offer scan fails, also scan the accept-update history (by the deterministic accept commandId or by the order memo on the vault's transaction stream) and, if an order-bound custody accept is found, persist counterTransferUpdateId and advance to main_locked.

### `swap-solver/src/htlc-solver-daemon.mts:766` — Reverse solver WBTC retake is never recorded server-side (order lingers non-terminal, redundant scans)  
_LIVE · MEDIUM · CONFIRMED_

**Scenario:** REVERSE (canton-to-evm) swap: user locks CBTC, solver locks WBTC (counter_locked), but the user never claims WBTC on EVM. After solverTimelock+30s the daemon calls escrow.write.retake([hashLock]) (line 766) and adds the order to the per-poll in-memory claimedMain set (line 771). It NEVER POSTs to any server endpoint — there is no /retake-counter or solver-retake route (only /retake-main exists, which is for the user's FORWARD retake and is requireOrderOwner-gated, not daemon-callable). The DB row stays counter_locked/counter_claimed. Because claimedMain is rebuilt empty every poll (lines 498-499), the next tick re-enters this branch; escrow.read.locks now returns empty (retake deleted it), so it falls into the 'lock gone -> user claimed -> find Claimed event' path (lines 775-842), scans the whole escrow history for a Claimed event that does not exist, logs 'lock gone but no Claimed event found yet' (line 838), and repeats this full-history RPC scan every POLL_MS until userTimelock passes. Funds are ultimately safe (refundMainCanton returns the user's CBTC after userTimelock, guarded by !revealedPreimage), but for the entire solverTimelock->userTimelock gap (the leg-gap window, ~20m+) the order is operationally stuck in a non-terminal status with no record that the WBTC was already retaken, and burns redundant getContractEvents scans on every poll for every such order.

**Fix:** Add a daemon-authorized server endpoint (e.g. POST /api/htlc/{id}/record-counter-retake) and an htlcService method that CAS-transitions counter_locked/counter_claimed -> a terminal 'retaken'/'failed' state recording the retake tx, guarded by !revealedPreimage and an on-chain check that the lock is gone and no Claimed event exists. Call it right after waitForTransactionReceipt in the daemon. This both prevents the per-poll re-scan loop and gives operators a durable record that the reverse leg unwound by retake rather than claim.

### `swap-solver/src/htlc-solver-daemon.mts:616` — Reverse swap: solver locks WBTC with as little as 5 min of user-claim margin (asymmetric to the 10-min solver guard)  
_LIVE · MEDIUM · CONFIRMED_

**Scenario:** In canton-to-evm, the daemon locks WBTC for the user with unlock = o.solverTimelock (the SHORT leg) and only refuses when solverTimelock <= now+300 (5 minutes). The forward direction protects the SOLVER with EVM_CLAIM_MARGIN_SECONDS = 10*60 (lib/htlc-evm-lock-guard.ts:8, daemon:898) and verifyEvmLock binds unlockTime to userTimelock, but the reverse direction has NO symmetric guard ensuring the USER has enough time to claim before the solver retakes. If a reverse order lingers in main_locked (e.g. slow Loop CBTC custody visibility, daemon backlog, RPC lag) so that by the time the daemon reaches R-STEP 3 the solverTimelock is only ~5-6 min out, the daemon still locks WBTC. The user must then approve + submit + mine an EVM claim within that window or the solver retakes (daemon:759-771) and the user's CBTC is refunded — atomic-safe (no double-loss) but the user is griefed into a failed swap with wasted gas, and a malicious/slow solver could deliberately delay to this window.

**Fix:** Add a reverse-direction user-claim margin guard mirroring EVM_CLAIM_MARGIN_SECONDS: before locking WBTC require solverTimelock - now >= USER_CLAIM_MARGIN (e.g. 10 min), and if the margin is insufficient, abort-counter-lock and let the order expire/refund cleanly on Canton rather than locking WBTC the user cannot realistically claim. Raise the 300s floor at daemon:616 to match the forward margin.

### `lib/canton-quote-sanity.ts:137` — C2C reference sanity circuit-breaker silently disabled for any non-CBTC/CC pair (USDCX)  
_LIVE · MEDIUM · CONFIRMED_

**Scenario:** assertCantonQuoteSanity returns early (no reference cross-check) whenever either asset is not CBTC or CC. quoteCantonToCanton accepts the wider CantonSwapAssetId (incl. USDCX, enabled via CANTON_USDCX_ADMIN), and is exported. For a CBTC<->USDCX quote the Tradecraft AMM price is used with NO independent amuletPrice x BTC/USD circuit breaker at all — a manipulated/illiquid USDCX pool would price-through with zero guard. The order/settlement path is currently restricted to CBTC/CC (CantonSwapMvpAssetId) so it is not yet drainable through settlement, but the moment USDCX is wired into the swap-order flow the float-drain breaker is absent by construction (the guard is keyed to an asset whitelist instead of failing closed on unknown assets). Fix is also defense-in-depth against an operator enabling USDCX orders without re-reading this file.

**Fix:** Invert the guard to fail-closed: instead of `return` when assets are not CBTC/CC, throw CantonQuoteSanityError for any pair this function cannot independently reference-price. Add an explicit USDCX reference (USDCX is $1 by config, BTC/USD already fetched) so CBTC<->USDCX gets a real band, or hard-block USDCX in quoteCantonToCanton until a reference exists.

### `app/api/mint/process-transfers/route.ts:47` — Any authenticated user can trigger the global mint processor, enabling ledger-load amplification  
_LIVE · MEDIUM · CONFIRMED_

**Scenario:** isAuthorized returns true for ANY logged-in Supabase user (lines 47-54), not just the owner of pending mints or a cron principal. The processor scans ALL active warpx holdings and drives transfers for EVERY user's mints (runProcessorLocked is global, not scoped to the caller). The lease lock (LEASE_SECONDS=300) serializes runs but does not limit who can start one, and the per-party rate limit is keyed on the caller's user id (line 77 passes partyKey=user.id with limit 20), so N users can each fire ~20 invocations to keep the global processor and its many ledger ACS/updates/commands calls running continuously. This is a self-inflicted DoS / ledger-quota-exhaustion and cost vector against the shared warpx node.

**Fix:** Scope user-triggered runs to the caller's own pending mints (pass the session party into the processor and have it only consider holdings whose DA lineage resolves to that user), or restrict the full global sweep to the cron principal. Apply a global (not per-user) rate limit / minimum interval on processor invocations so the shared sweep cannot be driven on demand by arbitrary authenticated users.

## CONFIG-DEPENDENT — real only under specific env/misconfig

### `contracts/src/OranjAttestorOracle.sol:98` — Trusted attestor key unilaterally releases locked WBTC (no on-chain Canton-delivery proof)  
_CONFIG-DEPENDENT · MEDIUM · CONFIRMED_

**Scenario:** attest(remoteChainId, remoteOracle, application, dataHash) writes _attestations[...] = true for any tuple the caller supplies. Anyone holding the attestor key can mark an arbitrary fill 'proven' and make InputSettlerEscrow.finalise() release the locked WBTC with NO real CBTC delivery on Canton — there is zero on-chain check that CBTC moved. If the hot attestor key leaks (it is a server-side hot key per the doc), the entire WBTC escrow balance for the legacy OIF settlement path can be drained. The contract even documents this as 'TREASURY-GRADE'. Scope-limiting fact: the live HTLC swap path (htlc-settle.ts) is a real keccak HTLC and does NOT use this oracle (htlc-settle.ts:3-23 'replaces the OLD oracle path'), so this risk only applies to the legacy InputSettlerEscrow/settle.ts flow that is still deployable from this repo.

**Fix:** This is an explicitly accepted single-solver-custodial v1 property, so document it as a deployment gate rather than ship it silently: (a) do not deploy/wire OranjAttestorOracle on any network where the HTLC path is the intended swap mechanism; (b) if the legacy path must remain, move the attestor key to an HSM/threshold signer and add a per-order replay/expiry binding plus a circuit-breaker (pause) on the owner. The attest dataHash already binds solver+orderId+timestamp+output (settle.ts:198), which is good — the residual risk is purely the unconditional trust in the key.

### `app/api/mint/process-transfers/route.ts:37` — Mint cron auth diverges from daemon secret chain (secret-parity fragility)  
_CONFIG-DEPENDENT · MEDIUM · CONFIRMED_

**Scenario:** `isAuthorized` only checks `process.env.CRON_SECRET` for the bearer path (line 37), while every other automated trigger — `daemonSecret()` in lib/htlc-auth.ts:20-27 and both daemons (htlc-solver-daemon.mts:44-49, canton-swap-daemon.mts:14-19) — accepts `HTLC_DAEMON_SECRET || CRON_SECRET || API_AUTH_TOKEN`. An operator who provisions the swap daemons with `HTLC_DAEMON_SECRET` (the name the README/daemons foreground) and never sets `CRON_SECRET` leaves the mint-transfer cron with `cronSecret === undefined`; the bearer branch is skipped entirely and the ONLY way to trigger mint settlement is an interactive Supabase session. A scheduled/headless mint cron then silently 401s forever and minted CBTC sits unswept on the warpx party with no alert (unlike the daemons, which fail-fast on a missing secret). This is an availability/operational-correctness gap, not a direct theft, but stuck mints are user-funds-affecting.

**Fix:** Replace the local `process.env.CRON_SECRET` check with the shared `daemonSecret()`/`isBearerAuthorized` helper from lib/htlc-auth.ts so the cron path honors the same secret fallback chain as the daemons, and fail-fast/alert if no secret is configured outside development.

### `contracts/src/OranjAttestorOracle.sol:94` — Attestor-oracle release path is fully trusted (single hot key can release WBTC with no on-chain proof of Canton delivery)  
_CONFIG-DEPENDENT · MEDIUM · CONFIRMED_

**Scenario:** attest()/attestBatch() let the attestor key write _attestations[...] = true, which causes InputSettlerEscrow.finalise() to release locked WBTC with NO on-chain check that CBTC actually moved on Canton. If the attestor hot key is compromised or the off-chain agent has a reconciliation bug, an attacker/operator can mark arbitrary fills proven and drain all WBTC escrowed via the OIF route. This is documented as an accepted v1 custodial property, and the production HTLC path uses HTLCEscrow.sol (lock/claim/retake, trustless) rather than this oracle, but the OIF route (solver:watch / InputSettler) remains deployable and treasury-grade.

**Fix:** Confirm the OIF/attestor route is fully decommissioned for production (no funded InputSettler escrow points at this oracle); if retained, isolate the attestor key to a dedicated HSM/signer, add per-fill caps and a timelock/2-of-N on attest, and emit/monitor OutputProven against an independent Canton-delivery watcher. Document clearly that only HTLCEscrow.sol is in the supported swap path.

### `lib/canton-swap-rate-limit.ts:24` — Missing x-forwarded-for collapses all IP-gated callers into one shared rate-limit bucket  
_CONFIG-DEPENDENT · MEDIUM · PLAUSIBLE_

**Scenario:** clientIpFromRequest() returns the literal string "unknown" whenever the x-forwarded-for header is absent (or empty). Every route whose only abuse control is an IP bucket — mint/account-contract-rules (GET, IP-only), mint/bitcoin-address (pre-auth IP pre-check at route.ts:23), canton/network-fee/estimate (key=clientIpFromRequest), canton/swap/quote (scope c2c-quote-ip) — then keys all such requests under "mint-redeem-ip:unknown" / "network-fee-estimate:unknown" / "c2c-quote-ip:unknown". On any deployment/path where the platform does not inject x-forwarded-for (direct ingress, internal hop, a misconfigured proxy, or a platform that uses a different header), one attacker exhausts the shared bucket and denies the coordinator-rules / quote / fee-estimate endpoints for ALL anonymous users at once (and inflates the shared bucket so legitimate users are throttled). Conversely an attacker who CAN reach the origin directly bypasses per-client limiting entirely by sending no XFF (everyone is 'unknown', so their share of the global limit is large per source). Not a funds-loss bug, but a global self-DoS / abuse-amplification on the public read endpoints.

**Fix:** When x-forwarded-for is absent, fail closed for anonymous IP-only routes (reject with 400/429) or fall back to a connection-level remote address the platform guarantees, rather than bucketing everyone under a single constant. At minimum, document/require the trusted-proxy header in deployment and have IP-only routes additionally require an authenticated session so 'unknown' can never be the sole gate.

## DORMANT-OIF — ✅ RESOLVED BY DELETION (2026-06-26)

_The entire legacy OIF stack (`swap-solver/src/{api,serve,delivery,canton,watcher}.ts`, `app/api/solver/`,
`lib/solver-proxy-allowlist.ts`, `contracts/src/OranjAttestorOracle.sol`, the `solver:api`/`solver:watch`
scripts, and the OIF helpers in `lib/swap-api.ts`) has been **deleted from the repo**. Verified: the listed
files no longer exist, no live source imports any removed module, web + solver typechecks are clean, and
281/281 web tests pass. These findings are therefore **closed** — kept below as historical record only.
None were ever reachable on the live deployment._

### `swap-solver/src/api.ts:454` — Order intake never re-prices CBTC output vs WBTC input — user signs an arbitrarily over-priced order and drains the float  
_DORMANT-OIF · CRITICAL · CONFIRMED_

**Scenario:** The /quote handler computes cbtcAmount = wbtcAmount × price × (1−feeBps) (api.ts:309-310), but the client builds and signs the StandardOrder itself and submits it to POST /orders. handleCreateOrder calls validateOrderIntake (api.ts:454) which only checks token identity, banned-user, and uint256 range (api.ts:204-241) — it NEVER recomputes or bounds out0.amount (the CBTC the solver must deliver) against the WBTC input at the live price/fee. GATE D (api.ts:464-491) only proves the user signed THEIR OWN order; it does not constrain the amounts. Attack: request a quote for 1 sat WBTC, then sign+submit an order with inputs=[WBTC,1] but outputs[0].amount = entire solver float (e.g. 1 BTC of CBTC). openFor locks 1 sat WBTC; delivery.ts:102 delivers formatUnits(out.amount) = the full CBTC to the user's verified party; settle.ts finalise() collects only the 1 sat WBTC input. Net: user receives ~1 BTC CBTC for ~1 sat WBTC. The float guards (delivery.ts:142-202) cap the loss at the float / optional in-flight caps but do not prevent grossly mispriced delivery; MAX_INFLIGHT_SATS and PER_USER_INFLIGHT_SATS are undefined by default (index.ts:186-193), so a single order can drain the whole float.

**Fix:** In handleCreateOrder, recompute the expected CBTC out from the order's WBTC input using the SAME price feed + feeBps used by /quote (read depegGuard.check again at intake), and reject if out0.amount exceeds expected (allow a small tolerance band, never more). Equivalently bind the order to a server-issued quoteId/signature so the client cannot alter amounts after quoting. Also make the in-flight caps mandatory (fail closed) so any residual mispricing has a bounded blast radius.

### `swap-solver/src/delivery.ts:142` — CBTC float check is a read-only snapshot with no reservation — concurrent/duplicate deliveries can over-spend; only same-tick serialization saves it  
_DORMANT-OIF · HIGH · CONFIRMED_

**Scenario:** GUARD 2 (delivery.ts:142-158) reads canton.getFloatSats() and proceeds if floatSats >= needSats, but never reserves/decrements the float. There is no float-reservation RPC in the standalone solver path (reservation only exists in the separate lib/htlc-service-singleton.ts, a different code path). Safety today rests entirely on a single daemon process running deliverSeenOrders serially within one tick (index.ts:180) plus Canton CONTRACT_NOT_ACTIVE on holding reuse. If the solver is ever scaled to two daemon instances (or the API process is also wired to deliver, as serve.ts contemplates running legs separately), two workers each read the same float for two different orders, both pass the check, both selectHoldings against the live ACS, and both submit — over-delivering CBTC the float cannot actually cover, or both consuming overlapping holdings. The per-order claimStatus CAS (delivery.ts:227) only prevents the SAME order being delivered twice; it does not serialize the shared float across DIFFERENT orders.

**Fix:** Add a serialized, atomic float-reservation step (DB CAS that decrements an available-float counter keyed to specific holding cids, or a single global advisory lock around delivery) BEFORE createOffer, mirroring the lib/ HTLC service's reserve* RPCs. Release the reservation on failure/refund. Document and enforce single-writer delivery if reservation is not added.

### `swap-solver/src/canton.ts:734` — Cross-participant accept detection relies on a fragile template-substring heuristic; a false 'not pending' marks delivered+cbtcAccepted and finalises the WBTC without the user holding CBTC  
_DORMANT-OIF · HIGH · PLAUSIBLE_

**Scenario:** resolveDelivery's cross-participant branch (accept-watch.ts:83-113) calls isDeliveryAccepted(cids) → floatHasPendingTransfer (canton.ts:734-789), which decides 'pending' by substring-matching templateId.includes('TransferInstruction') or a locked Holding owned by the solver. createOffer's autoAccepted decision (canton.ts:430-436) uses the same signal. If the registry ever renders the pending instruction under a different template name/path, or the change-output holding does not carry a recognized lock field, floatHasPendingTransfer returns pending=false even though the user has NOT accepted. That yields accepted=true → the order is marked delivered + cbtcAccepted (accept-watch.ts:102-107) or autoAccepted at creation (delivery.ts:266-275), and the settle loop then attests+finalises and pulls the user's WBTC while the user never received CBTC. The conservative pending=true on HTTP failure (canton.ts:770) only covers transport errors, not a template-shape mismatch.

**Fix:** Make the accept signal positive and explicit: detect the accept by the receiver Holding creation in the same update (as resolveOffer does on the readable path) or by a registry/ledger query that affirmatively confirms the TransferInstruction was archived-by-accept, rather than inferring acceptance from the ABSENCE of a substring-matched contract. Pin exact template FQNs instead of includes(). Until then, do not set cbtcAccepted/delivered from the cross-participant heuristic alone for finalise-bearing transitions.

### `swap-solver/src/api.ts:142` — Rate limiter keys on socket remoteAddress only — behind a reverse proxy all clients share one bucket (and direct callers can rotate source IPs)  
_DORMANT-OIF · MEDIUM · CONFIRMED_

**Scenario:** clientIp (api.ts:142-143) uses req.socket.remoteAddress. serve.ts binds loopback by default but the documented production deployment fronts the API with a reverse proxy (serve.ts:25-28, README Railway). Behind a proxy, every request arrives from the proxy's IP, so the per-IP token bucket (api.ts:120-141) becomes a single global bucket: one abusive client consumes the shared RATE_BURST and rate-limits all legitimate users (DoS), while a distributed attacker hitting the proxy still shares one bucket. Conversely, a directly-reachable instance lets an attacker rotate source IPs to defeat the limit entirely. /quote is unauthenticated and does a depeg feed read + order build per call.

**Fix:** When fronted by a trusted proxy, derive the client key from a validated X-Forwarded-For/X-Real-IP set only by that proxy (and reject the header otherwise). Add a global ceiling in addition to per-key, and keep /quote cheap. Document that API_BIND_HOST must stay loopback unless an authenticated gateway enforces identity.

### `swap-solver/src/serve.ts:100` — OIF-escrow solver de-peg circuit breaker fails open (par 1.0 pricing) when DEPEG_FEED is unset — even on mainnet  
_DORMANT-OIF · MEDIUM · CONFIRMED_

**Scenario:** In serve.ts the DepegGuard is constructed ONLY if process.env.DEPEG_FEED is set (line 60, 100-107); when unset, `depegGuard` is `undefined` and the solver logs 'de-peg guard: DISABLED' but starts normally. In api.ts handleQuote (lines 281-290), with no depegGuard the price defaults to a flat par `priceRaw = 100_000_000n` (1.0) with NO circuit breaker. Unlike the CBTC float pre-flight (index.ts:104-118) which calls process.exit(1) on mainnet, there is NO mainnet enforcement that a depeg feed exists. Concrete loss: an operator deploys the OIF forward path to mainnet, forgets DEPEG_FEED; WBTC depegs to e.g. 0.97 BTC during a market event; every /quote keeps pricing WBTC->CBTC at flat 1:1, so the solver hands out full-value (1.0 BTC) CBTC for 0.97-BTC WBTC, ~3% solver loss per swap, with no automatic pause. The /api/solver proxy (app/api/solver/[...path]) exposes /quote and /orders to the browser, so this path is reachable even though the primary UI submission uses the more-robust /api/htlc engine.

**Fix:** On mainnet, require DEPEG_FEED (or pass a mandatory depegGuard) and process.exit(1) if absent — mirror the float pre-flight's mainnet hard-fail. Alternatively, make api.ts handleQuote refuse to quote (503) when depegGuard is undefined instead of silently falling back to par 1.0. The HTLC engine (lib/htlc-quote.ts) already does this correctly (refuses to quote with <2 sources / >2% depeg / >90s stale); bring the OIF path to parity.


---

## Recommended fix order (LIVE first)

1. **LIVE HIGH funds** — burn double-burn on 409 retry (`redeem/submit-withdraw:237`); forward
   `lockCounter` double-allocate (`htlc-service-singleton:1470`); mint self-reported amount
   (`mint-processor:728`); owner-less deposit-account attribution (`list-deposit-accounts:178`);
   C2C unpaginated receipt scan (`canton-command-recovery:80`).
2. **LIVE HIGH** — `claim-as-receiver` test route in prod tree; pending-counter & reverse-custody
   float liabilities.
3. **LIVE MEDIUM** — refundCounter guard; timelock-margin asymmetry; mint-processor abuse; the rest.
4. **CONFIG-DEPENDENT** — set `DEPEG_FEED` (mainnet), proxy hops, secret parity, attestor-key hygiene.
5. **DORMANT-OIF** — only if the OIF `/orders` intake is ever revived (re-add `assertOrderAmounts`-style
   re-pricing + mandatory in-flight caps before deploying it).
# Part B — RESOLVED (2026-06-25 whole-app audit, remediated in code)

These were found in the 2026-06-25 audit and **fixed** in the remediation pass (see
`docs/SECURITY-AUDIT-2026-06-25.md` for full detail). Kept here for a single source of truth.
Note: several were independently **re-confirmed still-fixed** by the 06-26 full-app run; a few have
**deeper residuals** now tracked in Part A (e.g. the unified-float accounting → reverse-custody &
pending-counter liability HIGHs).

| ID | Issue | Fix | Status |
|---|---|---|---|
| Debug routes | Unauthenticated `canton/packages/*` exposing privileged ledger JWT | `requireDaemon` + `encodeURIComponent` | ✅ fixed |
| H-1 | Cross-family vault CBTC double-reservation → insolvency | migration 040 unified `sum_vault_cbtc_reserved_sats` + shared lock; **reverse-custody term added** | ✅ fixed (residual nuances in Part A) |
| H-2 | IP rate-limit fully bypassable | rightmost trusted XFF hop; `x-real-ip` dropped | ✅ fixed |
| M-1 | Refund re-picks live holdings (double-pay window) | ledger-truth check before re-send | ✅ fixed |
| M-2 | C2C float TOCTOU | retry + fresh read; H-1 unified lock | ✅ fixed (partial) |
| M-3 | Stale `amuletPrice` (first vs latest round) | select highest `round.number` | ✅ fixed |
| M-4 | No web mainnet guard | `mainnet-guard.ts` + middleware + route backstops | ✅ fixed (middleware verified wired) |
| M-5 | Server vault IDs fell back to `NEXT_PUBLIC_*` | server env only | ✅ fixed |
| M-6 | No mint/redeem rate limits | `mint-redeem-guard.ts` on all routes | ✅ fixed |
| M-7 | EVM `unlockTime` not bound to `userTimelock` | `expectedUserTimelock` ±120s in `verifyEvmLock` | ✅ fixed |
| M-8 | EVM finality default too low | prod default 12 confs | ✅ fixed |
| M-9 | network-fee estimate trusts client `vaultParty` | server settlement party (C2C branch) | ✅ fixed (htlc branch residual in Part A) |
| M-10 | OAuth origin spoofing | `PUBLIC_SITE_ORIGIN(S)` allowlist; **then softened to fall-back-+-warn so a missing env can't 500 sign-in** | ✅ fixed |
| M-11 | Wide CSP `connect-src` | explicit allowlist from network/Supabase/Loop | ✅ fixed |
| L-1 | `x-real-ip` spoofing | folded into H-2 | ✅ fixed |
| L-2 | Loop quote party unverified | session-party match | ✅ fixed |
| L-3 | auto-refund comment mismatch | comment corrected | ✅ fixed |
| L-4 | Solver proxy GET orders w/o ownership | daemon + party-ownership + solver-side `verifyCantonParty` | ✅ fixed |
| L-5 | Fail-open pending check in receipt proof | `listPendingOffersStrict` | ✅ fixed |
| L-6 | Auto-refund failures ignored by `/ready` | separate `refundOk()` heartbeat | ✅ fixed |
| H-3 | **Mint can pay the WRONG user** (resolve by non-unique `bitcoin_address`) | resolve by `depositAccountContractId` only | ⏭ **DEFERRED** (product decision; also surfaces in Part A) |

---

# Part C — RETRACTED

### `proxy.ts` — "middleware never loads, app ships with no CSP / mainnet guard" — ❌ WITHDRAWN

Reported as CRITICAL during the remediation review, based on an empty **legacy**
`.next/server/middleware-manifest.json`. **Disproven by a real build:** `npm run build:prod` emits
`functions-config-manifest.json` with a `/_middleware` entry and prints
`[assert-next-proxy] proxy compiled as /_middleware`. Next.js 16 records middleware there, not in the
legacy manifest. **The CSP, security headers, and mainnet guard ARE active.** No action needed.


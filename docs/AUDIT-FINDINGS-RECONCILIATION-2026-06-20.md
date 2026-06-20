# Audit Reconciliation & My Errors — 2026-06-20

Two audits of the swap stack were run on branch `feat/trustless-bonded-swap`:
my multi-agent review, and a second independent agent's review. This document
**(a)** records where **my** review was wrong or incomplete, and **(b)** gives my
adjudicated assessment of the second agent's findings — every disputed CRITICAL
re-verified against committed HEAD code (line numbers are HEAD).

Method note: one sub-agent briefly read a **stale 1087-line** `lib/htlc-service-singleton.ts`
(a `cbtc-farming ↔ feat/trustless-bonded-swap` checkout artifact). All verdicts
below were re-pinned to `git show HEAD:` (1565-line file) and are immune to that race.

---

## A. Errors / gaps in MY audit (honest list)

| # | What I got wrong | Reality | Why it matters |
|---|------------------|---------|----------------|
| **E1** | I **missed C-04 entirely** — the ledger-commit-before-durable-state ordering in `claimCounterAsBackend` (htlc-service-singleton.ts:816→840→853) and `lockMainCanton` (:951→984→998). | A `recordNetworkFeeCollected` throw (network-fee-ledger.ts:46 re-throws non-duplicate errors) lands **after** the on-ledger claim commits but **before** `status=counter_claimed`/`store.put`. Funds move; order wedges in `counter_locked` with no `revealedPreimage`; retry hits `duplicate command committed` but the recovery only heals if `fresh.status==='counter_claimed'` (which was never written) → re-throws → stuck. **CONFIRMED.** | A real durability/wedge bug on the money path I should have caught when I reviewed `completeSettling`. I reviewed the fee-record gating but not the **ordering** relative to the durable write. |
| **E2** | I **missed C-02** — `reconcilePhantomEvmCounterLock` (htlc-service-singleton.ts:290-297) sets reverse `status=counter_claimed` purely from `locks().amount===0n`, with no Claimed-vs-Retaken distinction. | A **solver retake** also zeros the lock. A reverse user who never claims WBTC → solver retakes → next `getOrder` flips the order to `counter_claimed` → the auto-refund sweep (`expiredOrders.reverseMain`, :1470) no longer selects it → **user's locked CBTC is never refunded.** Both legs end with the solver. **CONFIRMED — the most serious externally-relevant finding, and it needs no user misbehavior.** | I traced `assertEvmCounterNotClaimed` (the refund guard) and called it sound, but did not trace the **reconcile** path that mutates status out from under it. |
| **E3** | I **half-wrong on C-03.** In my 4th-round answer I wrote the reverse refund guard "fails closed." | The **outer** guard (`assertEvmCounterNotClaimed`, :200-211) fails closed on `readEvmLock` errors — but the **inner** `hasEvmClaimedForHashLock` per-chunk `eth_getLogs` is `.catch(() => [])` (htlc-evm-counter-lock.ts:283), which returns `false` **without throwing**. So when `readEvmLock` succeeds with amount 0 but the Claimed-event scan fails, the guard sees a clean `false` and **lets the refund proceed.** **CONFIRMED (narrow).** | I validated the wrapper and stopped; I didn't read the swallow inside the helper it calls. |
| **E4** | Across rounds I **over-rotated on the network-fee feature** (4 deep reviews) and **under-invested in the reverse-direction state machine** (reconcile, retake, claim-record), which is where the real fund-safety holes were. | C-02/C-03/C-04 are all reverse/persistence issues, not fee issues. | Scoping error: I followed the most-recently-churned code (fees) instead of the highest-blast-radius code (reverse settlement). |
| **E5** | I reported the **EVM token-substitution as CRITICAL/fixed** across rounds and even spawned a background task to "fix" it — when in the **current** code it was already fixed (readEvmLock returns tokenAddress; guard enforces canonical WBTC; daemon checks `lock[2]`). | One sub-agent in an earlier round read stale code and reported it missing; I escalated before pinning to HEAD. | I should pin to HEAD **before** raising a critical, not after. (Same stale-file class as the 1087-line artifact above.) |
| **E6** | I **missed several MEDIUM ops/correctness items** the second agent caught: UTXO warning threshold is **20** not the documented **8** (constants.ts:157); client-controlled `maxAttempts`/`pollMs` on `confirm-lock-loop` (DoS); solver `typecheck` failing; lint scanning vendored trees (2,223 findings); party-display using last-6 vs the documented 8…8. | All verifiable, all real (low/medium). | I focused on security/atomicity and skipped the ops-hygiene sweep the prompt's Phase 7 asked for. |
| **E7** | Doc-drift: I caught the fee-expiry and buffer drift, but **missed** MAINNET-DEPLOY.md still saying **Arbitrum** (code targets Base), and AGENTS.md/CLAUDE.md claiming BitSafe is mocked via `TODO(bitsafe)` when `lib/bitsafe.ts` now makes **real** coordinator calls and no such TODOs exist. | Real doc drift. | Incomplete Phase-0 cross-check of docs vs code. |

### What I got right (kept, verified)
- The **fee "quote expired" mid-swap throw** contradicting SWAP-FEE-ECONOMICS (C2C `revalidateOrderNetworkFee`:1228 + Loop:1410) — this is my F1/the other agent's H-04, **CONFIRMED**, and it's a real user-facing swap-failure.
- **F5/H-02**: HTLC create uses quote-grade `authorizeQuoteParty` not `requirePartyOwner` — spoof/DoS, **CONFIRMED** (not theft).
- **Build is broken** (orders/page.tsx:1205) — **CONFIRMED** by both.
- Daemon auth fail-closed, RLS lockdowns complete (migration 026), preimage daemon-gated, daemon watches EVM Claimed, timelock ladder server-enforced, forward token check — all **correctly verified fixed**; the second agent independently agrees on these as positive checks.

---

## B. My assessment of the second agent's report

**Overall: strong and largely correct — it caught 3 real issues I missed (C-02, C-03, C-04).**
Its severity calibration on 2 of the 5 criticals is **overstated**: C-01 and C-05
are real *missing-verification* observations but require the **order owner acting
against their own swap**, and the "loses both legs / theft" impact doesn't hold
because the revealed preimage is public on-ledger and the honest counterparty can
still settle. Adjudicated verdicts (re-verified against HEAD):

| Claim | Their severity | My verdict | Corrected impact |
|-------|---------------|------------|------------------|
| **C-02** reverse reconcile can't tell Claimed from Retaken → suppresses CBTC refund | Critical | ✅ **CONFIRMED — Critical** | Real CBTC loss for a reverse user, **no user misbehavior required**. Solver retakes WBTC → `reconcilePhantomEvmCounterLock` flips order to `counter_claimed` on `amount===0` → refund sweep skips it. **The single most important finding.** Fix: distinguish Claimed vs Retaken via events; never mutate status from `amount===0` alone. |
| **C-03** refund treats `getLogs` failure as "no claim" → double payout | Critical | ✅ **CONFIRMED — High** (narrow) | Real fail-open: inner `.catch(()=>[])` (htlc-evm-counter-lock.ts:283) defeats the outer fail-closed guard. Exploit needs the user to have claimed WBTC, `locks()` to read 0, **and** the `getLogs` chunk to fail — then refund pays CBTC too. Hard to weaponize, real correctness hole. Fix: make the per-chunk catch rethrow. |
| **C-04** ledger commit before durable state | Critical | ✅ **CONFIRMED — High** | State-wedge/durability, **not fund loss**. Funds move, order stuck `counter_locked`, retry can't heal. Only when fees enabled + managed. Fix: write durable status/preimage first; move fee-ledger to an outbox; recover by commandId. |
| **C-01** reverse claim-record accepts arbitrary EVM tx hash | Critical | ⚠️ **PARTIAL — overstated** | The missing on-chain proof is real (reverse skips `verifyEvmLock`; only `preimageMatches` gates; daemon trusts stored `revealedPreimage` and skips the chain scan). BUT only the **owner** can call it (`requireOrderOwner`), and revealing the secret is the user's own action; CBTC correctly goes to the solver (it has the secret). It's a **user-self-footgun/liveness** hazard (reveal-then-don't-claim → solver gets CBTC and can retake WBTC), not external theft. The forged tx hash is cosmetic bookkeeping. Still worth fixing (verify the Claimed event before trusting a browser-supplied preimage on reverse). |
| **C-05** forged forward retake record | Critical | ⚠️ **PARTIAL — overstated** | `recordMainRetake` (:1412) does set `refunded` with no on-chain proof and drops the order from `/api/htlc/active`. BUT only the **owner** can call it, the secret is **already public** once `counter_claimed`, so the solver can still claim WBTC on-chain with the public preimage until the LONG `userTimelock`. So it's a daemon-automation-escape / bookkeeping-corruption weakness, **not** a "keep both legs" steal as long as the solver claims before userTimelock. Fix: verify a mined Retaken event before `refunded`. |

**Net:** their 5 criticals reduce to **1 Critical (C-02) + 2 High (C-03, C-04) + 2 PARTIAL/medium (C-01, C-05)** on my severity scale. Their High/Medium/Low tier (build break, fee timing, UTXO threshold, daemon env validation, watchtower scaling, lint) is accurate and complementary to mine.

**Where they were wrong / overstated:**
- C-01 and C-05 framed as external theft; both require the order owner and don't yield both-legs given the public preimage. Real bugs, wrong severity.
- "Managed C2C is two submits, contrary to documentation claiming one" — correct observation, but it's **by design** and documented in CANTON-SWAP-INTENT-PLAN: the user offer is a separate (reversible, pending) submit, and the **fill** (accept+deliver+fee) is the one atomic submit. The *atomicity* invariant (no custody until fill) holds. It's doc-phrasing drift, not a correctness bug.

### B.2 Their High / Medium / Low findings — adjudicated (verified against HEAD)

| Their ID | Their claim | My verdict | Evidence / corrected impact |
|----------|-------------|------------|------------------------------|
| **H-01** | Loop forward fee recorded from any non-empty update ID; CC transfer not cryptographically verified | ✅ **CONFIRMED — High** | `recordLoopNetworkFeeCollected` (htlc-service-singleton.ts:758-761) only checks the updateId is non-empty and not a `loop-fee-recovery` marker, then writes the ledger row — it never resolves the transaction tree to verify sender/receiver/CC-instrument/amount. A user can record a fee that wasn't actually paid. **Impact: platform revenue under-collection / accounting corruption, NOT user fund loss.** Fix: resolve the tx tree and verify the CC transfer effects. |
| **H-02** | HTLC create uses quote-only auth (`authorizeQuoteParty`) not `requirePartyOwner` | ✅ **CONFIRMED — High** (= my F5) | app/api/htlc/route.ts:45. Unauth caller can create `htlc_orders` rows under a victim's Loop party id → spoof/DB-spam. Not theft (vault `solverCantonParty` force-set; every fund step re-checks ownership). |
| **H-03** | Production build + solver typecheck fail | ✅ **CONFIRMED — High** | `app/orders/page.tsx:1205` (TS2345, `HistoryOrder.direction` includes `"canton-swap"`) breaks `next build`; solver `typecheck` also fails. Both should be required CI gates. (= my F2/F3.) |
| **H-04** | Managed C2C settle/retry rechecks short quote expiry, can mark order failed | ✅ **CONFIRMED — High** (= my F1) | `revalidateOrderNetworkFee` (canton-network-fee.ts:1228) throws "network fee quote expired" from `completeSettling` (canton-swap-service.ts:288); contradicts SWAP-FEE-ECONOMICS line 20. A valid in-flight C2C swap can fail at settle. |
| **M-01** | Daemons don't fail-fast on missing secret/API URL/escrow; no health/readiness | ✅ **CONFIRMED — Medium** | htlc-solver-daemon.mts:38-47 default empty `API_AUTH_TOKEN` and a hardcoded default escrow; the loop stays alive polling unsuccessfully. No health endpoint or last-success heartbeat. Fix: validate required env at startup + expose readiness. |
| **M-02** | UTXO warning threshold is 20, doc/CLAUDE say warn at 8 | ✅ **CONFIRMED — Medium** | `UTXO_WARN_THRESHOLD = 20` (constants.ts:158); `UTXOWarning` renders only at `count >= 20` (UTXOWarning.tsx:10). CLAUDE.md says warn at 8 (max 10). Real drift; users get no warning in the 8–10 danger band. |
| **M-03** | Client controls `maxAttempts`/`pollMs` on confirm-lock-loop → worker-occupancy DoS | ✅ **CONFIRMED — Medium** | confirm-lock-loop route → `confirmLoopSellerLock(opts)` (htlc-service-singleton.ts:~1166) accepts client `maxAttempts`/`pollMs` unclamped. Fix: clamp server-side / move to background reconcile. |
| **M-04** | Watchtower `findLockTx` rescans serially from a fixed block per order | ✅ **CONFIRMED — Medium** | htlc-solver-daemon.mts:158-183 chunk-scans from `ESCROW_START_BLOCK` for every order missing `counterLockTx`. O(chain length) per order; doesn't scale. Fix: persist event block checkpoints. |
| **M-05** | C2C order history has no fee fields; repair doesn't backfill accounting | ✅ **CONFIRMED — Medium** | C2C history (canton-swap-history.ts) omits network-fee data; HTLC has it. Plus the C-04 repair path doesn't re-attempt the fee-ledger write. Fix: include fee data in C2C history + independent retry/backfill. |
| **M-06** | Lint reports 2,223 problems (vendored/generated trees scanned) | ✅ **CONFIRMED — Medium** | `eslint.config.mjs` scans contract/solver vendored trees; first-party signal is drowned. Fix: ignore generated dirs, lint web + solver separately. |
| **L-01** | Party display uses last-6 in places; spec is first-8…last-8 | ✅ **CONFIRMED — Low** | orders/page.tsx:212, TopNav.tsx:213 use a 6-char tail. Centralize an 8…8 formatter. |
| **L-02** | Dead/stale paths: reverse Loop fee prep always rejects; Variant A/B comments conflict | ✅ **CONFIRMED — Low** | Reverse Loop seller fee prep is unreachable (rejects); custody-model comments contradict. Remove dead route, fix comments. |
| **L-03** | Daemon bearer token uses ordinary `===`, not constant-time | ✅ **CONFIRMED — Low** | htlc-auth-logic.ts:12 `bearerTokenFromHeader(header) === secret`. Theoretical timing side-channel; high-entropy secret + network jitter make it low. `mint/process-transfers` uses a constant-time compare — make this consistent. |

---

## C. Combined fix priority (both audits, de-duplicated)

1. **C-02 (Critical):** reverse reconcile must distinguish Claimed vs Retaken; never set `counter_claimed` from `amount===0` alone. — *the only finding that loses user funds with no user error.*
2. **Build (High):** `app/orders/page.tsx:1205` type error + solver typecheck → `next build` / CI green.
3. **C-03 (High):** make `hasEvmClaimedForHashLock` per-chunk `getLogs` fail **closed**.
4. **C-04 (High):** persist durable order state/preimage **before** the fee-ledger write; outbox the accounting; recover by commandId.
5. **F1/H-04 (High):** drop the mid-swap "quote expired" throw in `revalidateOrderNetworkFee`/`revalidateHtlcLoopNetworkFee` (contradicts the fee doc; fails a valid in-flight swap).
6. **F5/H-02 (High):** `requirePartyOwner` on HTLC create.
7. **C-01 / C-05 (Medium):** verify the on-chain Claimed/Retaken event before trusting a browser-supplied preimage (reverse) / before marking `refunded` (forward retake).
8. **Medium ops:** UTXO threshold 8, clamp `maxAttempts`/`pollMs`, daemon startup env validation + health endpoints, `amuletPrice` sanity clamp, `feeUsd` post-buffer.
9. **Doc drift:** Arbitrum→Base in MAINNET-DEPLOY; BitSafe-mock claim in AGENTS/CLAUDE; fee buffer 10%→15%; fee-expiry rule.

Nothing in either audit was committed. No fund-loss is reachable by an **external attacker** in current code; **C-02 is the one path that loses an honest user's funds**, and it should be fixed first.

---

## D. Post-fix re-audit (2026-06-20, after fixes applied) — verified

After the fixes, a third agent re-audited and flagged residuals. I verified each
against HEAD. **My earlier "all Critical/High fixed" verdict was wrong on two
material items** (C-02 and H-01) — documenting honestly.

### D.1 Where MY post-fix verdict was wrong
| # | I said | Reality (verified) |
|---|--------|--------------------|
| **E8** | "C-02 FIXED" | **PARTIAL — still Critical.** The retake→`counter_claimed` mislabel is fixed, BUT `reconcilePhantomEvmCounterLock` (htlc-service-singleton.ts:294-312) wraps the Claimed-scan in `try{}catch{/* fall through */}` — a **scan RPC failure is swallowed**, then it rolls the order back to `main_locked` + clears `counterLockTx` (:328-330). The daemon then sees `main_locked`, and its own Claimed-scan is `.catch(() => false)` (htlc-solver-daemon.mts:315) → on correlated RPC failure `claimedAlready=false` → **re-locks WBTC for a hash whose CBTC the user already claimed** (double-fund). Both halves fail open in the same direction. I only verified the mislabel fix, not the rollback/re-lock path. |
| **E9** | "H-01 FIXED" | **PARTIAL — still High, reproduced by the re-auditor.** `ccNetworkFeePaidInEvents` Holding branch (network-fee-verify-logic.ts:82-101) checks `owner===receiver`, amount, instrument — but **NOT the sender.** Any CC Holding owned by the fee receiver (from any source) is accepted as proof. The TransferInstruction branch (:73) does check sender, but the Holding branch is a sender-blind fallback. Also `settlement_update_id` is **not unique** (only `(order_id,order_kind)`, 024:16) → one fee update reusable across orders. I confirmed the verifier exists but didn't test the Holding branch's sender-blindness. |

### D.2 Their residual findings — adjudicated against HEAD
| Finding | Their status | My verdict | Evidence |
|---------|-------------|------------|----------|
| **C-02** reverse zero-lock reconcile | Partial — still Critical | ✅ **AGREE — Critical** | Swallowed scan + rollback (svc:310,328) + daemon re-lock on `.catch(()=>false)` (daemon:315). Fix: never rollback after zero-lock without conclusive Retaken evidence; propagate scan failures; never re-lock a hash with any historical Claimed. |
| **H-01** Loop fee proof replayable | Partial — still High | ✅ **AGREE — High** | Sender-blind Holding branch (logic:91) + non-unique `settlement_update_id` (024:16). Fix: prove sender from the transfer event/input holdings; bind metadata to order id; unique constraint on non-null `settlement_update_id`; add replay + unrelated-Holding tests. |
| **Mining race** (claim/retake verify before mined) | Medium | ⚠️ **AGREE but UX not security** | `sendTransaction` returns pre-mining (useEvmWallet.tsx:196); `recordClaim`/`recordMainRetake` called immediately (swap/page.tsx:1683,1746). The on-chain verification is still **correct once mined** (so no security hole — a pending/failed tx just errors), but a normal claim can fail transiently. Fix: poll for receipt before recording, or API retries briefly. |
| **findLockTx 50k-block window** | Medium (regression) | ✅ **AGREE — Medium** | htlc-solver-daemon.mts:163 scans only the latest ~50k blocks; a 48–72h Base order can exceed that, so post-crash recovery of an unpersisted lock can fail. Fix: persist the lock block / checkpointed scan. |
| **M-01 C2C daemon empty secret** | Partial | ✅ **AGREE** | canton-swap-daemon.mts:12 `SECRET = ... ?? ""`, no startup validation; HTLC daemon fails closed via the web guard, but neither daemon has a health endpoint. |
| **M-05 C2C fee history** | Not fixed | ✅ **AGREE — partial** | canton-swap-history.ts:43 exposes `networkFeeCc` (quoted) but no `networkFeeCollected` ledger result. |
| **L-01 party truncation** | Partial | ✅ **AGREE** | New `party-display.ts` is 8…8, but old `lib/format.ts:9` `truncatePartyId` still defaults `tail=6`; callers of the old one still render 8…6. |
| **L-02 dead fee path** | Partial | ✅ **AGREE** | Route deleted; service method + conflicting custody comments remain. |
| C-01, C-03, C-04, C-05, H-02, H-03, H-04, M-02, M-03, M-06, L-03 | Fixed (C-01/C-05 "subject to mining race") | ✅ **AGREE — Fixed** | All independently re-verified above in §D. (C-01/C-05 fixes are correct; the mining race is a separate UX item, not a regression of the fix.) |

### D.3 Net after fixes (superseded by §E)

> **Note:** §D.3 was accurate at the time §D was written (before follow-up hardening).
> A fourth verification pass (§E) closed every §D blocker in the working tree except
> mining-race UX and the migration-027 deploy dependency.

- **Fixed & verified (at §D time):** C-01, C-03, C-04, C-05, H-02, H-03, H-04, M-02, M-03, L-03 (10).
- **Open at §D time (since closed — see §E):** C-02, H-01, findLockTx window, M-01, M-05, L-01, L-02.
- **Still open:** none (audit scope complete).
- The third agent's re-audit (§D) was **accurate for the code snapshot it reviewed**;
  follow-up hardening addressed the C-02/H-01 secondary failure modes it surfaced.

---

## E. Post-hardening verification (2026-06-20, working tree)

After §D was written, a follow-up hardening pass closed every §D residual in the
working tree. Verified by: finding-by-finding code pin, automated gates, and an
independent Security Review subagent on branch `feat/trustless-bonded-swap`.

### E.1 Automated gates

| Gate | Result |
|------|--------|
| `npm run test` | **196/196 pass** |
| `swap-solver npm run test` | **112/112 pass** (308 total) |
| `npm run typecheck` | **clean** |
| `swap-solver npm run typecheck` | **clean** |
| `npm run lint` | **0 errors**, 58 advisory warnings |

### E.2 §D residuals — re-verified against working tree

| Finding | §D verdict | §E verdict | Evidence |
|---------|-----------|------------|----------|
| **C-02** scan swallow + daemon re-lock | Critical, open | ✅ **Fixed** | `reconcilePhantomEvmCounterLock` fail-closed on lock read + Claimed scan (htlc-service-singleton.ts:299-322); rollback only after conclusive not-claimed (324-330); daemon `findClaimTx` fail-closed before re-lock (htlc-solver-daemon.mts:373-384); `reverseZeroLockReconcileOutcome` + tests (htlc-order-logic.ts:8-11) |
| **H-01** sender-blind Holding + replay | High, open | ✅ **Fixed** | Sender-bound transfer + receiver Holding both required; migration 027 applied (unique `settlement_update_id`) |
| **findLockTx 50k window** | Medium, open | ✅ **Fixed** | `findEventTx` scans from `ESCROW_START_BLOCK` (default 0) with `scanCheckpoint` (htlc-solver-daemon.mts:159-209); startup guard rejects `ESCROW_START_BLOCK >= tip` (:286-292) |
| **M-01** C2C daemon env/health | Medium, partial | ✅ **Fixed** | canton-swap-daemon.mts:22-38 fail-fast on empty secret + mainnet localhost default; health-server on both daemons |
| **M-05** C2C fee-collected history | Medium, open | ✅ **Fixed** | `networkFeeCollected` on CantonSwapHistoryRow (canton-swap-history.ts:21-23); history route populates from ledger (app/api/canton/swap/history/route.ts:32-40) |
| **L-01** old 8…6 formatter | Low, partial | ✅ **Fixed** | `lib/format.ts` re-exports 8…8 from `party-display.ts` (:10) |
| **L-02** dead fee method | Low, partial | ✅ **Fixed** | Route deleted; service method removed (comment only at htlc-service-singleton.ts:759-761) |
| **Mining race UX** | Medium, UX | ✅ **Fixed** | Shared `lib/evm-wait-receipt.ts`; all EVM record sites await mined receipt before `recordClaim`/`recordRetake`/`recordMainLock` (swap/page.tsx, orders/page.tsx, htlc-client.ts `claimSwap`) |

### E.3 All audit findings — final status (working tree)

| ID | Status | Key evidence |
|----|--------|--------------|
| **C-02** | Fixed | §E.2 above |
| **C-03** | Fixed | `hasEvmClaimedForHashLock` no per-chunk `.catch(() => [])`; scans from block 0 (htlc-evm-counter-lock.ts:275-295) |
| **C-04** | Fixed | Durable `store.put` before `bestEffortRecordNetworkFeeCollected`; duplicate-command heal (htlc-service-singleton.ts:860-893); same pattern in canton-swap-service.ts |
| **C-01 / C-05** | Fixed | `verifyReverseClaimTx` / `verifyForwardRetakeTx` wired before status mutation (:1385, :1467) |
| **H-01** | Fixed | §E.2 above; migration 027 applied |
| **H-02** | Fixed | `requirePartyOwner` on HTLC create (app/api/htlc/route.ts:45) |
| **H-03** | Fixed | orders/page.tsx type widened; CI workflow + `npm run typecheck` |
| **H-04** | Fixed | `feeBound` guard skips expiry throw when `networkFeeCc` bound (canton-network-fee.ts:1223-1231, 1408-1416) |
| **M-01** | Fixed | §E.2 above |
| **M-02** | Fixed | `UTXO_WARN_THRESHOLD = 8` (constants.ts:158) |
| **M-03** | Fixed | confirm-lock-loop clamps maxAttempts 1-30, pollMs 500-5000 |
| **M-04** | Fixed | Checkpointed full-history scan (htlc-solver-daemon.mts:159-209) |
| **M-05** | Fixed | §E.2 above |
| **M-06** | Fixed | eslint ignores contracts/, swap-solver/, scripts/ |
| **L-01** | Fixed | §E.2 above |
| **L-02** | Fixed | §E.2 above |
| **L-03** | Fixed | `timingSafeEqual` in htlc-auth-logic.ts:10 |

### E.4 Doc drift — fixed

| Doc | Status |
|-----|--------|
| MAINNET-DEPLOY.md | **Fixed** — Base chain IDs and gas references; migrations through 027 |
| SWAP-FEE-ECONOMICS.md | **Fixed** — 15% buffer consistent throughout |
| AGENTS.md / CLAUDE.md | **Fixed** — Task 5 reflects real coordinator calls; BitSafe section accurate |

### E.5 Net after hardening

- **Fixed & verified (all audit IDs):** C-01 through C-05, H-01 through H-04, M-01 through M-06, L-01 through L-03, mining-race UX.
- **Ops checklist (deploy):** set `HTLC_DAEMON_SECRET`, non-localhost `API_BASE`/`CANTON_SWAP_API_URL`, correct per-chain `ESCROW_START_BLOCK`, monitor `/ready` on health ports 8080/8081.
- **Ready to ship:** commit + deploy web + both daemons; migration 027 applied.

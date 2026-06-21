# Security & Code Audit — Swap Stack (2026-06-20)

Comprehensive record of the multi-round audit of the WarpX/cantonbit swap stack
(cross-chain WBTC↔CBTC HTLC + same-chain CBTC↔CC intent swaps + solver daemons +
Supabase). Consolidates findings from **multiple independent review agents** and the
primary reviewer, the adjudicated verdicts, and the **fix applied for each**.

**Final state (all rounds):** web `tsc` clean · solver `tsc` clean · `npm run lint`
exit 0 (0 errors, ~58 advisory warnings) · **308/308 unit tests pass** · EVM
contract (Foundry) + solver unit tests pass.

Branch: `feat/trustless-bonded-swap`. Nothing was committed by the audit; all changes
sit in the working tree for review.

---

## How findings were graded

Two/three independent agents reviewed the stack across rounds; their reports
sometimes disagreed and sometimes ran against stale snapshots. Every disputed item
was **re-verified against committed HEAD code** before a verdict. Severity:
**Critical** = fund loss / auth bypass / stuck funds; **High** = swap fails reliably
or value mis-accounted; **Medium** = UX/perf/ops footgun; **Low** = polish.

A recurring lesson (recorded honestly): the primary reviewer twice **verified a
fix's "headline" but missed a secondary failure mode in the same code path**
(C-02 rollback branch, H-01 sender-blind branch). Later rounds explicitly
re-checked same-direction secondary paths — which is how M-04's config bug and the
C-02/H-01 residuals were caught.

---

## CRITICAL findings

### C-01 — Reverse claim recorded without on-chain proof
- **Found by:** agent round 2. **Verdict:** PARTIAL (real missing-verification; impact narrower than "external theft" — requires the order owner, and the revealed secret is public).
- **Problem:** reverse `recordCounterClaimed` skipped `verifyEvmLock` and accepted a valid preimage + an **arbitrary** EVM tx hash; the daemon then trusted the stored preimage and claimed CBTC.
- **Fix:** `recordCounterClaimed` (lib/htlc-service-singleton.ts) now requires on-chain proof for reverse — `hasEvmClaimedForHashLock` **and** `verifyReverseClaimTx(claimRef, hashLock)` before accepting; preimage still validated against the hashLock.
- **Status:** ✅ Fixed.

### C-02 — Reverse double-fund on correlated RPC failure
- **Found by:** agent round 2 (residual flagged again round 3). **Verdict:** CONFIRMED Critical — the one path that loses honest-user/solver funds with **no user misbehavior**.
- **Problem (two halves, both fail-open in the same direction):**
  1. Service `reconcilePhantomEvmCounterLock`: a swallowed Claimed-scan error (`try{}catch{/* fall through */}`) then rolled the order back to `main_locked` and cleared `counterLockTx`.
  2. Daemon re-lock: the Claimed scan used `.catch(() => false)` → on a scan failure it treated the hash as unclaimed and **re-locked WBTC** for a hash whose CBTC the user had already taken.
  - With correlated RPC failures after a genuine user claim → solver funds WBTC twice.
- **Fix:**
  - Service reconcile (htlc-service-singleton.ts): split into **fail-closed** branches — a lock-read error or Claimed-scan error now **returns the order unchanged (no rollback)** and retries next poll; rollback to `main_locked` happens only on a *conclusive* lock-gone-and-not-claimed result.
  - Daemon (htlc-solver-daemon.mts): replaced `.catch(()=>false)` with `findClaimTx` that **throws on RPC error → skips re-lock (fail-closed)**.
  - `hasEvmClaimedForHashLock` (htlc-evm-counter-lock.ts): the per-chunk `eth_getLogs` swallow (`.catch(()=>[])`) was removed earlier — failures now propagate so the refund guard `assertEvmCounterNotClaimed` fails closed.
- **Status:** ✅ Fixed (both halves + the refund-guard scan).

### C-03 — Reverse refund treats `getLogs` failure as "not claimed"
- **Found by:** agent round 2. **Verdict:** CONFIRMED High (narrow window).
- **Problem:** `hasEvmClaimedForHashLock`'s per-chunk `eth_getLogs` was `.catch(()=>[])`, so an RPC failure returned `false`; the outer refund guard then let a Canton CBTC refund proceed even though the user may have claimed the WBTC (double-payout).
- **Fix:** removed the swallow — `getLogs` errors now throw; `assertEvmCounterNotClaimed` re-throws "EVM lock check failed — refusing refund" (fail-closed). Also the no-anchor fallback now scans from genesis (0), not `tip-50k`, so an older order's claim can't fall outside the window.
- **Status:** ✅ Fixed.

### C-04 — Ledger commit before durable order state (wedge)
- **Found by:** agent round 2 (missed by primary reviewer — recorded as error E1). **Verdict:** CONFIRMED High (state wedge, not fund loss).
- **Problem:** `claimCounterAsBackend` / `lockMainCanton` committed the on-ledger claim, **then** called `recordNetworkFeeCollected` (which re-throws on Supabase error), **then** wrote `status` + `store.put`. A fee-ledger throw left funds moved but the order stuck `counter_locked` with no `revealedPreimage`; the duplicate-command recovery only healed if `status==='counter_claimed'`, which was never written → permanent wedge.
- **Fix:** the duplicate-command recovery in `claimCounterAsBackend` now **heals the durable state** — on `fresh.status==='counter_locked'` it sets `revealedPreimage` + `counter_claimed` + `store.put` (tagged `// C-04`). Fee accounting moved to best-effort (see M-05) so it can't block the durable write.
- **Status:** ✅ Fixed.

### C-05 — Forged forward retake record
- **Found by:** agent round 2. **Verdict:** PARTIAL (owner-only; secret already public so the solver can still claim before userTimelock).
- **Problem:** `recordMainRetake` set `status='refunded'` from any owner-supplied string with no on-chain verification, dropping the order from the daemon's active set.
- **Fix:** `recordMainRetake` now calls `await verifyForwardRetakeTx(retakeTx, o.hashLock)` (mined Retaken event, contract, hashLock) before marking `refunded`.
- **Status:** ✅ Fixed.

### (Earlier round) EVM token-substitution — lock any ERC20, receive real CBTC
- **Found by:** primary reviewer (round 1). **Verdict:** was CRITICAL; **already fixed in current code** when re-checked.
- **Problem (historical):** `readEvmLock`/the guard verified amount/receiver/timelock but not the token, so a forward user could lock a worthless ERC20 and still receive CBTC.
- **Fix (already present):** `readEvmLock` returns `tokenAddress`; `assertEvmLockSafeForReveal` enforces `lock.tokenAddress === canonical WBTC`; the daemon checks `lock[2]` too.
- **Status:** ✅ Verified fixed (lesson: pin to HEAD before raising — an earlier sub-agent read stale code and over-reported it).

### (DB) `network_fee_ledger` + 3 tables anon-exposed; daemon auth fail-open
- **Found by:** primary reviewer (DB/RLS + auth rounds). **Verdict:** were Critical/High; **fixed in current code**.
- **Fixes (already present):** RLS lockdowns complete — `mint_transfers` / `mint_processor_state` / `solver_state` locked by migration 026; orders/ledger tables deny-all; `party_mappings` scoped to `auth.uid()=user_id`. `isBearerAuthorized` now fails **closed** on empty secret (`if(!secret) return false`), with a test; `auto-refund` GET cron likewise.
- **Status:** ✅ Verified fixed.

---

## HIGH findings

### H-01 — Loop network-fee proof forgeable / replayable
- **Found by:** primary (replay) + agent round 2 (sender-blind) + agent round 3 (pending-offer). **Verdict:** CONFIRMED High; fixed across three sub-issues.
- **Problems:**
  1. **Sender-blind:** the verifier accepted a receiver-owned CC **Holding** without proving the **sender** — any receiver-owned Holding (from any source) passed (agent reproduced it locally).
  2. **Replay:** `settlement_update_id` was not unique (only `(order_id, order_kind)`) → one valid fee update reusable across orders.
  3. **Pending offer = paid:** the verifier accepted a bare `TransferInstruction`/`TransferOffer` (an offer/lock, not a settled transfer — can still expire/reject).
- **Fix:** `ccNetworkFeePaidInEvents` now accepts only the configured receiver's direct `TransferPreapproval_SendV2`, bound to the exact preapproval contract disclosed when the fee command was prepared plus the sender debit and receiver credit from the authoritative ledger tree. Migration **028** persists that historical binding so preapproval renewal cannot invalidate a paid update. Holdings, generic instructions, transfer-shaped exercises, and wrong-contract SendV2 events fail closed. Migration **027** adds a partial unique index on non-null `settlement_update_id`; `recordNetworkFeeCollected` raises `NetworkFeeSettlementReusedError` on cross-order replay and coerces empty-string ids → NULL.
- **Status:** ✅ Code fixed. **DB: 027 applied to OLD DB (verified — empty-string rows cleaned); NEW DB (`oshqecdsloajfhdhhiul`) still needs 027 applied.**

### H-02 — HTLC order creation without ownership
- **Found by:** primary + agent. **Verdict:** CONFIRMED High (spoof/DoS, not theft).
- **Problem:** `POST /api/htlc` used quote-grade `authorizeQuoteParty` (accepts any well-formed Loop party id) instead of `requirePartyOwner` → an unauthenticated caller could create orders under a victim's party.
- **Fix:** route now calls `requirePartyOwner(String(body.userCantonParty))`.
- **Status:** ✅ Fixed.

### H-03 — Production build + solver typecheck failing
- **Found by:** all rounds. **Verdict:** CONFIRMED.
- **Problem:** `orders/page.tsx` type error (`HistoryOrder.direction` includes `"canton-swap"` vs `SwapDirection`), route↔service signature mismatches, a missing `CantonIdentityProvider` export, an `alert()` mis-call, plus solver typecheck errors — `next build` failed.
- **Fix:** all resolved over the rounds; web `tsc` clean and `swap-solver` `typecheck` exits 0. CI added (`.github/workflows/ci.yml`).
- **Status:** ✅ Fixed.

### H-04 / F1 — Mid-swap "quote expired" fails a valid swap
- **Found by:** primary (F1) + agent (H-04). **Verdict:** CONFIRMED High; contradicted SWAP-FEE-ECONOMICS ("no mid-swap fee expiry").
- **Problem:** `revalidateOrderNetworkFee` threw `"network fee quote expired"` at C2C settle/retry; a valid in-flight order (stuck `settling`) failed.
- **Fix:** the expiry throw is now gated on `!feeBound` — an order with a bound `networkFeeCc` skips the expiry check entirely; only the order-bound cap applies. Matches the doc.
- **Status:** ✅ Fixed.

---

## MEDIUM findings

### M-01 — Daemon startup validation & health monitoring
- **Found by:** agents. **Verdict:** CONFIRMED.
- **Problems:** C2C daemon ran with an empty `HTLC_DAEMON_SECRET` (would spin on 401s); `API_BASE`/`APP_URL` silently defaulted to `localhost` on mainnet; no health/heartbeat endpoint on either daemon.
- **Fix:** both daemons fail fast on missing secret; both reject the localhost default when mainnet (`SWAP_NETWORK=mainnet`/`ALLOW_MAINNET`); new `swap-solver/src/health-server.mts` exposes `GET /health` (liveness) + `GET /ready` (503 if no successful poll within 3× the interval) with a heartbeat (`startedAt`/`lastPollOkAt`/`lastSettleOkAt`), wired into both daemons (HTLC `:8080`, C2C `:8081`).
- **Status:** ✅ Fixed.

### M-04 — Historical lock/claim recovery (correctness + efficiency)
- **Found by:** agents (round 3 caught a CRITICAL config sub-bug). **Verdict:** CONFIRMED.
- **Problems:**
  1. `findLockTx` scanned only the latest ~50k blocks → a 48–72h order could outlive the window; a code default block (`42371722`) belonged to the wrong chain.
  2. **Config CRITICAL:** `swap-solver/.env.mainnet` had `ESCROW_START_BLOCK=470011441` — ~10× past the Base mainnet tip (~47.6M; it was a stale **Arbitrum** value), so on mainnet every history scan covered **zero blocks** and silently recovered nothing (also defeating the C-02 re-lock guard).
- **Fix:** `findEventTx`/`findLockTx`/`findClaimTx` scan from `ESCROW_START_BLOCK` (full history); code default changed to `0` (genesis: slow but never misses); **startup guard** throws if `ESCROW_START_BLOCK >= chain tip`. Real Base-mainnet deploy block found via on-chain binary search (**47284328**) and set in `.env.htlc-mainnet` + `.example`. Added **scan checkpointing** (`scanCheckpoint`) so repeat scans resume from the last scanned block instead of re-walking deploy→tip.
- **Status:** ✅ Fixed (correctness + config + efficiency). **Note:** the bad `470011441` lived in the out-of-scope legacy Arbitrum solver env; the HTLC daemon loads `.env.htlc-mainnet`, now corrected.

### M-05 — C2C fee history / repair-path accounting
- **Found by:** agents. **Verdict:** CONFIRMED.
- **Problems:** the C2C history API didn't expose whether the fee was actually collected; the ledger-repair path (`repairManagedFromLedger`) recovered a fill but **never recorded the fee** → a recovered swap showed "fee not collected" when it was.
- **Fix:** C2C history route enriches fee-bearing orders with `networkFeeCollected` from the ledger (mirrors `/api/htlc/history`); Orders page renders "Network fee paid". `repairManagedFromLedger` now best-effort records the fee (`networkFeeSource:"repair"`, gated on a bound `networkFeeCc` + `settlementUpdateId`; idempotent via the (order_id,order_kind) + settlement_update_id unique indexes).
- **Status:** ✅ Fixed.

### M-06 — Lint gate unusable / a real hook bug
- **Found by:** agents. **Verdict:** CONFIRMED.
- **Problems:** lint reported **2,223 problems** — mostly vendored/generated trees not being ignored, plus a tracked scratch file (`lookup-tmp.mjs` that read `.env.local` secrets), real `no-explicit-any` errors, and one genuine `react-hooks/rules-of-hooks` bug (a `useEffect` after `if (!quote) return null`).
- **Fix:** eslint config ignores `contracts/`/`swap-solver/`/`scripts/`; deleted the scratch file; fixed the **real hook-order bug** (moved the effect above the early return); typed the 8 first-party `no-explicit-any` sites; relaxed only the **4 React-Compiler advisory rules** (`set-state-in-effect`, `static-components`, `preserve-manual-memoization`, `purity`) to warnings — **kept `rules-of-hooks` and `exhaustive-deps` at their bug-catching severity**.
- **Status:** ✅ Lint passes (exit 0; 0 errors, ~58 advisory warnings). The warnings are pre-existing code-quality debt now surfaced cleanly (not introduced by the audit) — a future component-refactor opportunity.

### EVM mining race — claim/retake recorded before mined
- **Found by:** agent round 3. **Verdict:** CONFIRMED Medium (UX/liveness, not security — on-chain verification is still correct once mined).
- **Problem:** `useEvmWallet.sendTransaction` returns the hash pre-mining; the reverse claim and forward retake immediately called `recordClaim`/`recordRetake`, so the API tried to verify a receipt that didn't exist yet → transient failures.
- **Fix:** added `waitForReceipt(hash)` to `useEvmWallet` (polls `eth_getTransactionReceipt`, throws on revert/timeout); both EVM record sites now `await evm.waitForReceipt(tx)` before recording. The two non-EVM record sites (Canton `claimCounter` / Loop `submitAndWaitForTransaction`) already wait and were left alone.
- **Status:** ✅ Fixed.

---

## Follow-up findings (P1/P2) — regressions in this audit's own fixes

A later review round caught second-order issues introduced by fixes earlier in this
audit (the recurring "fixed the headline, missed a secondary path" pattern). All
verified and fixed.

### P1a — Receipt-timeout strands the user's WBTC
- **Verdict:** CONFIRMED — introduced by the EVM-mining-race fix (`waitForReceipt`).
- **Problem:** the forward-lock catch called `retry()` (reset to quote) on any error. If `waitForReceipt(lockTx)` timed out but the WBTC lock mined later, the order stayed `accepted` with no `mainLockTx`; a retry made a new order/hash → original locked WBTC unrecoverable from Orders.
- **Fix:** the catch (app/swap/page.tsx) now distinguishes "tx submitted" (a hash exists, not a user rejection) from "never submitted". When submitted, it best-effort records `mainLockTx` on **the original order** and advances to the `htlc-locking` waiting stage (daemon + Orders can recover) instead of `retry()`. Only truly-not-submitted/user-rejection resets to quote. (Reverse claim + forward retake were already timeout-safe — the daemon watches `Claimed` itself and the WBTC is already the user's.)
- **Status:** ✅ Fixed.

### P1b — C2C `/ready` reports healthy while every request 401/500s
- **Verdict:** CONFIRMED — introduced by the M-01 health-server fix.
- **Problem:** `fillStatus`/`expireAndReconcile` warn-and-returned on non-2xx, so `tick()` resolved and `heartbeat.pollOk()` fired even when the daemon was doing nothing (bad secret → 401, app down → 5xx).
- **Fix:** `fillStatus` (canton-swap-daemon.mts) now **throws** on a non-2xx pending-list response (the authoritative "can I list+act on orders" check), so `tick()` fails and the heartbeat is not marked healthy → `/ready` reports unhealthy. Per-order fill failures remain warn-and-continue.
- **Status:** ✅ Fixed.

### P2a — Repair path records fee without proving a fee leg
- **Verdict:** CONFIRMED — over-claimed in the M-05 fix.
- **Problem:** `repairManagedFromLedger` recorded fee collection based on `isNetworkFeeEnabled() && order.networkFeeCc>0` — configuration + metadata, not on-ledger evidence. `repairManagedFillFromLedger` verifies only the swap legs, not a fee leg. Fees toggled on after the fill (or a fee leg that never landed while swap legs did) would book uncollected revenue.
- **Fix:** removed the unsound record; the repair path now logs a reconciliation warning instead. Only the authoritative settle path (which sees `result.networkFeeCollected`) records the fee.
- **Status:** ✅ Fixed.

### P3a — Fee verifier accepts any transfer-shaped exercise (Noop passes)
- **Verdict:** CONFIRMED P1 (proven — a synthetic `Noop` exercise was accepted as paid).
- **Problem:** `exercisedTransferFromNode` read `transfer.{sender,receiver,...}` from **any** exercised node without validating the choice or template, so a fabricated exercise (wrong choice + unrelated template) carrying transfer-shaped fields passed `transferFieldsMatch`.
- **Fix:** removed transfer-shaped exercises as fee evidence entirely. Network-fee collection now accepts only the configured receiver's direct `TransferPreapproval_SendV2`, bound to the exact preapproval contract disclosed during preparation (persisted on the order), the sender debit, and the receiver credit. Generic instructions, Holdings, spoofed template names, and a SendV2 on any other preapproval contract fail closed. Permanent regression tests cover each bypass.
- **Status:** ✅ Fixed.

### P3b — Late-lock recovery still strands / records reverted tx
- **Verdict:** CONFIRMED P1 — residual in the P1a fix.
- **Problem:** the forward-lock catch (a) swallowed a failed `recordMainLock` (`.catch(()=>{})`) → order stayed `accepted` with no `mainLockTx`, hidden by `isAbandonedSwapDraft` and ignored by the daemon (which only processes `main_locked`); (b) recorded the hash even on a **reverted** tx.
- **Fix:** typed errors (`EvmTxRevertedError`/`EvmReceiptTimeoutError`) distinguish revert from timeout. The submitted `{swapId, lockTx}` is persisted in local storage before receipt waiting, and a recovery loop retries across page/browser restarts. `recordMainLock` is idempotent for the same hash and now verifies the configured-chain escrow state before advancing the order, so pending/reverted hashes cannot become `main_locked`. A late revert clears the recovery record; a confirmed lock is automatically reattached to the original order.
- **Status:** ✅ Fixed.

### P3c — Stale `sessionReady=true` on Loop-wallet switch
- **Verdict:** CONFIRMED P2.
- **Problem:** the session-probe effect only updated `sessionReady` after the async `swapSessionActive(newParty)` resolved, so on a Loop-wallet switch the previous party's `true` persisted during the probe gap — allowing actions/preapproval checks against the stale session.
- **Fix:** the effect now synchronously sets `sessionReady=null` (for non-managed users) **before** the async probe, so a party switch immediately invalidates readiness until the new probe completes.
- **Status:** ✅ Fixed.

### P3d — `/ready` healthy when expire/reconcile fails
- **Verdict:** CONFIRMED P2 — residual in the P1b fix (which only covered the pending-list).
- **Problem:** `expireAndReconcile` warn-and-returned on non-2xx, so a failing expire/reconcile endpoint didn't fail `tick()` → heartbeat stayed healthy.
- **Fix:** `expireAndReconcile` now throws on non-2xx; `tick()` runs both phases via `Promise.allSettled` (a failure in one doesn't skip the other) and throws if either failed, so `/ready` reflects any core-call failure.
- **Status:** ✅ Fixed.

### P2b — Missing `counterLockTx` → from-genesis scan times out
- **Verdict:** CONFIRMED.
- **Problem:** with `ESCROW_START_BLOCK` unset (default 0) and no `counterLockTx`/recoverable lock, recovery scanned from block 0 in 1990-block chunks — thousands of RPC calls on a ~47M-block chain, timing out reconcile/refund.
- **Fix:** the M-04 startup guard now **requires `ESCROW_START_BLOCK > 0` on mainnet** (the real deploy block), so the fallback never walks from genesis; the scan checkpoint keeps repeat scans cheap.
- **Status:** ✅ Fixed.

---

## LOW findings

### L-01 — Inconsistent party-id truncation (8…6 vs 8…8)
- **Problem:** a new `party-display.ts` used 8…8 but the old `lib/format.ts` `truncatePartyId` still defaulted to 8…6 (contradicting its own docstring).
- **Fix:** `lib/format.ts` re-exports `truncatePartyId`/`truncateEvmAddress` from `party-display.ts` — one canonical 8…8 formatter for all callers.
- **Status:** ✅ Fixed.

### L-02 — Dead reverse-Loop fee path & contradictory comments
- **Problem:** `prepareLoopSellerNetworkFee` (+ its route) was unreachable dead code (reverse Loop charges no fee, so it always threw); `prepareLoopSellerLockWithFee` had a dead fee branch; the Loop-seller comment block had **swapped Variant A/B labels** (called the built transfer-to-venue flow "Variant B escrow").
- **Fix:** removed the dead method + route (`prepare-seller-network-fee`) and the dead fee branch; corrected the comments (Variant A = transfer-to-venue = BUILT; Variant B = allocation escrow = DEAD).
- **Status:** ✅ Fixed.

### L-03 — Daemon bearer token compared with `===`
- **Problem:** `isBearerAuthorized` used ordinary string equality (timing side-channel).
- **Fix:** uses `timingSafeEqual`.
- **Status:** ✅ Fixed.

---

## Other quality fixes
- **Empty-string `settlement_update_id`** could re-break the 027 index — `recordNetworkFeeCollected` now coerces `""`/whitespace → NULL; migration 027 is self-healing (normalizes `""`→NULL and dedups before creating the index).
- **Doc drift corrected:** MAINNET-DEPLOY (Arbitrum→Base), AGENTS/CLAUDE (BitSafe-mock claim), SWAP-FEE-ECONOMICS (buffer + expiry rule).
- **Dead-import cleanup** in several files (partial; remaining unused-var warnings are advisory).

---

## Verified NON-issues (don't re-litigate)
- Timelock ladder is server-enforced (`assertValidTimelocks`, both directions); can't be client-inverted.
- `verifyEvmLock` present on all forward reveal/claim paths; late-reveal guard intact.
- Hashlock = keccak256 everywhere (EVM + Daml + client); no sha256 in the swap path.
- Daemon independently watches the EVM `Claimed` event for reverse orders (solver-safety rule).
- C2C settle atomicity holds: user offer (reversible pending) + atomic accept+deliver(+fee) fill; managed-C2C being "two submits" is by design (no custody until the fill), not a bug.
- Loop Variant B (allocation escrow) is not resurrected anywhere.
- Forward refund-vs-reveal is safe by on-ledger atomicity (the only forward reveal consumes the HtlcLock).

---

## Deployment checklist (the remaining non-code action)
- [ ] **Apply migration 027 to the NEW prod DB (`oshqecdsloajfhdhhiul`)** — partial unique index on `settlement_update_id`. (Old DB already done.)
  ```sql
  -- 027 is self-healing; safe to run as-is. Verify with:
  select indexname from pg_indexes
  where tablename='network_fee_ledger'
    and indexname='network_fee_ledger_settlement_update_uidx';
  ```
- [ ] Set `ESCROW_START_BLOCK=47284328` (Base mainnet escrow deploy) on the HTLC solver deploy env.
- [ ] Ensure daemon deploy env sets `HTLC_DAEMON_SECRET` (matches web) + a non-localhost `API_BASE`/`CANTON_SWAP_API_URL` (daemons now fail fast otherwise).
- [ ] Point monitoring at the daemon `/ready` endpoints (HTLC `:8080`, C2C `:8081`).

---

## Final status

| Finding | Severity | Status |
|---------|----------|--------|
| C-01 reverse claim w/o proof | Critical | ✅ Fixed |
| C-02 reverse double-fund | Critical | ✅ Fixed |
| C-03 refund fail-open on getLogs | High | ✅ Fixed |
| C-04 ledger-commit-before-durable wedge | High | ✅ Fixed |
| C-05 forged forward retake | High | ✅ Fixed |
| EVM token substitution (earlier) | Critical | ✅ Verified fixed |
| RLS exposure + daemon fail-open (earlier) | Critical | ✅ Verified fixed |
| H-01 fee proof forgeable/replayable | High | ✅ Code fixed · ⏳ 027 on new DB |
| H-02 order create w/o ownership | High | ✅ Fixed |
| H-03 build/typecheck failing | High | ✅ Fixed |
| H-04 mid-swap quote-expired | High | ✅ Fixed |
| M-01 daemon health/startup | Medium | ✅ Fixed |
| M-04 recovery scanning + config | Medium (config sub-bug Critical) | ✅ Fixed |
| M-05 fee history/repair accounting | Medium | ✅ Fixed |
| M-06 lint | Medium | ✅ Fixed (green) |
| EVM mining race | Medium | ✅ Fixed |
| L-01 party truncation | Low | ✅ Fixed |
| L-02 dead reverse fee path | Low | ✅ Fixed |
| L-03 bearer compare timing | Low | ✅ Fixed |

**All findings addressed in code.** Only remaining action: apply migration 027 to the
new prod DB (above). Nothing committed — changes are in the working tree.

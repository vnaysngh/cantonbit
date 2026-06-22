# Security & Code Audit — Swap Stack (2026-06-21)

Full-app review (`/code-review` xhigh): core swap design, fee design, cross-chain
HTLC + same-chain C2C, API-failure error handling, price/quote handling, security,
readability/quality. This round ran 10 finder angles + adversarial verify + a gap
sweep over the core source (the branch is 86 commits past `main`, so the review
targeted the live swap-stack files, not a 65k-line diff). Builds on the
[2026-06-20 audit](SECURITY-AUDIT-2026-06-20.md); these are **new** findings on top
of the prior rounds' fixes.

**Final state:** web `tsc` clean · solver `tsc` clean · `npm run lint` exit 0 ·
**326/326 unit tests pass.** Nothing committed by the audit — changes are in the
working tree.

**Root-cause theme:** the C2C service (`canton-swap-service.ts`) is well-hardened
with `putIfStatus` CAS + `sumReservedOut` float reservations, but the **HTLC service
(`htlc-service-singleton.ts`) used plain `store.put` with no CAS** — the source of
findings #2, #3, #9 (and the deferred #5). This round added `putIfStatus` to the
HTLC store and gated the irreversible paths on it.

---

## CRITICAL / HIGH — fund-safety & auth

### F1 — IDOR: deposit BTC address readable without ownership check
- **Severity:** High (PII / fund-adjacent disclosure). **Verdict:** CONFIRMED.
- **File:** `app/api/mint/bitcoin-address/route.ts`.
- **Problem:** the route called `getBitcoinAddress(depositAccountContractId)` and returned the address with **no auth before the read** — `getUser()` only gated the optional cache write (and the update wasn't scoped to the user). Any caller who knew a deposit-account contract id could read another user's funding BTC address.
- **Fix:** require the authenticated user to **own** the deposit account (Supabase lookup `user_id = auth.uid()` + `deposit_account_contract_id`) before the coordinator read; 401 if unauthenticated, 404 if not owned. Cache update now scoped to the user's row.

### F2 — Loop-seller refund double-spend + crash window
- **Severity:** Critical (double payout / unpaid-stuck). **Verdict:** CONFIRMED.
- **File:** `lib/htlc-service-singleton.ts` — `refundMainCanton` (loop branch) + `earlyRefundLoopCustody`; `lib/htlc-order-store.ts`; `lib/htlc-types.ts`.
- **Problem:** both refund the Loop seller by issuing a fresh `createTransfer` from the solver's float, with no CAS. The auto-refund sweep runs from two triggers (daemon POST + cron GET); two concurrent firings both passed the gate → user paid **twice**. (The managed `refundHtlcLock` branch is idempotent via on-ledger archival; the loop branch transfers from general float and is fully repeatable.)
- **Fix (two iterations):**
  1. Added `putIfStatus` (CAS) to the HTLC `SwapStore`.
  2. **Re-audit residual (crash window):** the first fix jumped straight to a terminal `refunded` before the transfer — a crash between the CAS and the transfer left the order terminal-but-unpaid, suppressing retries. Final fix uses a **durable transient `refunding` status**: CAS-claim `refunding` → transfer with a **deterministic commandId** (`htlc-refund-main-${id}`, shared by both refund entry points so they're mutually idempotent at the ledger) → mark `refunded`. A crash between the transfer and the `refunded` write leaves the order `refunding` (NOT terminal); `refundMainCanton`/`earlyRefundLoopCustody` accept `refunding` for re-entry, and `expiredOrders()` now scans `refunding` so the sweep re-runs the idempotent transfer and advances to `refunded`. A duplicate-command on retry is treated as "already paid → mark refunded."

### F3 — Forward retake strands the solver's CBTC
- **Severity:** High (solver float stranded). **Verdict:** CONFIRMED.
- **File:** `lib/htlc-service-singleton.ts` — `recordMainRetake`.
- **Problem:** when a forward order was still `counter_locked` (solver's CBTC locked on-ledger), `recordMainRetake` flipped it straight to `refunded`. That removed it from `refundableOrders()` (which scans `counter_locked`), so the auto-refund sweep never ran `refundCounter` to release the solver's CBTC — float stranded, recoverable only by the separate cleanup-allocations cron.
- **Fix:** if the order is `counter_locked` with an on-ledger HtlcLock, `recordMainRetake` now **refunds the solver's CBTC (`refundHtlcLock`) before** marking `refunded` (the user retaking WBTC means `userTimelock` passed, and the ladder guarantees `solverTimelock < userTimelock`, so the counter-refund window is open). If the on-ledger refund fails, the order stays `counter_locked` so the sweep retries — never marked refunded with float stranded.

### F4 — Anti-manipulation guard fed float-corrupted amount
- **Severity:** High (corrupts the ratio guard; currently latent). **Verdict:** CONFIRMED.
- **File:** `app/api/htlc/route.ts:75`.
- **Problem:** `cbtcUnits = BigInt(Math.round(parseFloat(body.cbtcAmount) * 1e8))` feeds `assertOrderAmounts`. The live client sends `cbtcAmount` as a decimal-BTC string, so this is correct today — but it reintroduces float rounding into the one check meant to stop a manipulated ratio, and would be 1e8× off if a caller ever passed an already-base-unit string (the quote route emits integers).
- **Fix:** use the integer-exact `toBaseUnits(body.cbtcAmount, 8)` (validates shape, rejects junk/>8dp) instead of `parseFloat*1e8`; 400 on invalid input.

---

## MEDIUM

### F5 — HTLC solver float unreserved across concurrent orders
- **Severity:** Medium. **Verdict:** CONFIRMED. **Status:** ✅ Fixed.
- **File:** `lib/htlc-service-singleton.ts` — `accept` solvency gate; `lib/htlc-order-store.ts`.
- **Problem:** the forward solvency gate checked total holdings against a single order's need with **no cross-order reservation** (the C2C path uses `sumReservedOut`). Two forward orders for the same solver party could both pass `accept()` seeing the full float, collectively exceeding inventory; the second leg later over-commits/fails, stranding a user `main_locked`.
- **Fix:** added `sumReservedCbtcSats(solverParty, excludeOrderId)` to the HTLC store — sums CBTC already committed by in-flight forward orders (`accepted`/`main_locked`/`counter_locked`). `accept()` now gates on `floatSats − reservedSats >= needSats` (integer base-units via `toBaseUnits`), so concurrent accepts can't over-commit. The alert/error now reports have/reserved/available.

### F6 — markCounterAccepted reaches `filled` without recording the fee
- **Severity:** Medium (revenue under-recorded). **Verdict:** CONFIRMED.
- **File:** `lib/canton-swap-service.ts` — `markCounterAccepted`.
- **Problem:** a managed C2C settle that pended on counter-accept already collected the CC fee in the same atomic fill submit, but `completeSettling` only records the fee on the direct-fill branch — so confirming the counter-accept flips the order to terminal `filled` with no fee-ledger row.
- **Fix (two iterations):** `markCounterAccepted` records the fee from the order's bound `networkFeeCc` + `settlementUpdateId`. **Re-audit residual:** the first fix recorded *after* the terminal `filled` transition, so a crash in between permanently under-recorded (future calls short-circuit on `filled`). Final fix records the fee **before** the `filled` transition — a crash after the fee write but before `filled` leaves the order re-entrant (`settling`/`user_locked` → `markCounterAccepted` retries, idempotent via the unique indexes); a crash after `filled` means the fee was already recorded. Best-effort so a Supabase blip never blocks the terminal transition.

### F7 — Counter CBTC transfer persist-after-commit window
- **Severity:** Medium (double-pay on retry). **Verdict:** PLAUSIBLE→fixed.
- **File:** `lib/htlc-service-singleton.ts` — `claimCounter` Loop-deliver; `lib/transfer.ts` — `createTransfer`.
- **Problem:** the counter `createTransfer` persisted `counterTransferUpdateId` after the on-ledger commit with **no deterministic commandId**, so a crash between commit and persist let a retry re-enter and send a second transfer (no ledger dedup backstop).
- **Fix (two iterations):** `createTransfer` accepts a deterministic `commandId` (`htlc-counter-deliver-${id}`) so a retry hits the ledger's `duplicate command committed` dedup. **Re-audit residual:** the first recovery only returned success when `counterTransferUpdateId` was already stored — exactly what's missing after a commit/crash. Final fix: on the duplicate-command catch with nothing stored, the transfer is known committed (the deterministic id dedup'd it), so persist a **recovery marker** (`htlc-counter-deliver-${id}`) to unblock the order and prevent any second send; the reconcile/confirm path (`userReceivedCounterLeg`) verifies actual on-ledger receipt by amount. (A full lookup-by-commandId from ledger completions would be stronger; the marker + amount-verified confirm is the pragmatic close.)

### F8 — Missing fetch timeouts (worker-exhaustion DoS)
- **Severity:** Medium. **Verdict:** CONFIRMED.
- **Files:** `lib/canton.ts` (`ledgerFetch`), `app/api/solver/[...path]/route.ts`.
- **Problem:** the core ledger helper and the solver proxy issued `fetch` with no `AbortSignal.timeout`; a stalled-but-connected upstream hangs the request worker forever → under load all workers pin.
- **Fix:** `ledgerFetch` now uses `AbortSignal.timeout` (default 60s, overridable via `init.timeoutMs`) and maps a timeout to a clear error; the solver proxy bounds the forward at 20s. (Many `lib/transfer.ts` registry fetches route through shared helpers; the highest-leverage low-level path is covered — remaining per-call timeouts tracked as a hardening follow-up.)

### F9 — Solver proxy leaked internal host:port + opaque success parse
- **Severity:** Medium (info leak) + Low (triage). **Verdict:** CONFIRMED.
- **Files:** `app/api/solver/[...path]/route.ts`; `lib/canton.ts`.
- **Problem:** the proxy catch interpolated the raw exception (containing `SOLVER_INTERNAL_URL` host:port) into the client response; and `ledgerFetch`'s success-path `res.json()` threw an opaque `SyntaxError` on a 200-with-HTML/empty body.
- **Fix:** proxy now logs the raw error server-side and returns a generic "solver unreachable/timed out" (504); `ledgerFetch` parses via `text()` + guarded `JSON.parse`, surfacing a clear "returned non-JSON" error.

### F10 — auto-refund GET used a non-constant-time secret compare
- **Severity:** Medium (timing side-channel on a daemon-grade secret). **Verdict:** CONFIRMED.
- **File:** `app/api/htlc/auto-refund/route.ts`.
- **Problem:** the cron auth used `header === \`Bearer ${secret}\`` (plain `===`), not the project's timing-safe `isBearerAuthorized`. `CRON_SECRET` also backs `daemonSecret()`, so it gates the whole daemon surface.
- **Fix:** `cronAuthorized` now delegates to `isBearerAuthorized` (constant-time compare, fail-closed on empty secret).

### F11 — redeem burn amount unvalidated
- **Severity:** Medium (input validation). **Verdict:** CONFIRMED.
- **File:** `app/api/redeem/submit-withdraw/route.ts`.
- **Problem:** the burn `amount` was forwarded into the Withdraw choice with only a truthiness check — no numeric/negative/zero/NaN/bounds validation (transfers/create uses `parseBtc` + `<=0n`). Bounded by ledger-side enforcement (runs `actAs` the session party, can't spend others' holdings), so not cross-party theft — but unvalidated amounts should never reach the choice.
- **Fix:** validate with `parseBtc` (well-formed positive BTC decimal); 400 on invalid or `<= 0`.

### F12 — swallowed claim-record on the auto-deliver path
- **Severity:** Medium. **Verdict:** CONFIRMED.
- **File:** `lib/htlc-client.ts`.
- **Problem:** on the forward-Loop auto-deliver path the `recordClaim` (persisting the revealed preimage for the solver's WBTC claim) was wrapped in `.catch(()=>{})` and returned success regardless — a dropped record was invisible.
- **Fix:** retry `recordClaim` with backoff; on persistent failure log a clear error (the solver also recovers the preimage from the on-ledger `revealedPreimage`, so this is defense-in-depth, but no longer silent).

---

## LOW / cleanup

### F13 — Dead unreachable tail in `revalidateHtlcNetworkFee`
- **File:** `lib/canton-network-fee.ts`.
- **Problem:** both `action` cases (`htlc-claim`/`htlc-lock`) returned early, so the trailing ~22-line estimate+cap+gate block was unreachable — a maintainer could edit dead code thinking it ran.
- **Fix:** removed the dead tail; replaced with an exhaustiveness `throw` for an unexpected action.

### Quality notes (not separately fixed — tracked)
- 4× copy-pasted ACS-scan block in `htlc-onledger.ts` (inconsistent `!r.ok` handling) — candidate for a shared helper.
- Triple-defined `ALLOCATION_INTERFACE` literal (one shadowing) in `htlc-onledger.ts`.
- `void ccHoldingCids` unused param + an unreachable `htlc-loop-lock` fee branch.
- Ad-hoc `1e-9` float amount comparisons vs the base-unit integer convention used elsewhere.
- `"already-claimed"` sentinel overloaded into the `mainClaimTx` field.

---

## Verified NON-issues (don't re-litigate)
keccak256 usage; timelock ladder bounds (`assertValidTimelocks`, ≤7d); `verifyEvmLock` margins; `recordCounterClaimed` forward-managed rejection + reverse on-chain-Claimed proof; depeg/stale-price breakers; RLS coverage (all tables incl. `network_fee_ledger`); network-fee replay/sender proof (027/028); preimage daemon-gated + not logged; `auth.ts` logs only token TTLs; mint/process-transfers Path-2 is DoS-only (idempotent + lease-locked, can't redirect funds).

---

## Final status

| ID | Severity | Area | Status |
|----|----------|------|--------|
| F1 | High | IDOR — deposit BTC address (+ log truncation) | ✅ Fixed |
| F2 | Critical | Loop-seller refund double-spend + crash window | ✅ Fixed (durable `refunding`) |
| F3 | High | Forward retake strands solver CBTC | ✅ Fixed |
| F4 | High | Anti-manipulation guard float corruption | ✅ Fixed |
| F5 | Medium | HTLC float unreserved across orders | ✅ Fixed (`sumReservedCbtcSats`) |
| F6 | Medium | markCounterAccepted fee not recorded + crash window | ✅ Fixed (record before terminal) |
| F7 | Medium | Counter-transfer persist-after-commit + recovery | ✅ Fixed (deterministic id + recovery marker) |
| F8 | Medium | Missing fetch timeouts | ✅ Fixed (core paths) |
| F9 | Medium | Solver-proxy info leak + opaque parse | ✅ Fixed |
| F10 | Medium | auto-refund non-constant-time compare | ✅ Fixed |
| F11 | Medium | redeem burn amount unvalidated | ✅ Fixed |
| F12 | Medium | swallowed claim-record | ✅ Fixed |
| F13 | Low | dead tail in revalidateHtlcNetworkFee | ✅ Fixed |

**All 13 findings fixed** (this audit defined F1–F13; an earlier draft mis-stated "15"). Includes the re-audit residuals on F1 (log leak), F2 / F6 / F7 (commit-then-persist crash windows) and F5 (now fully implemented, not deferred).

## Re-audit residuals (caught after the first pass — all fixed)
A follow-up review found that several first-pass fixes had a shared weakness: the
irreversible action (transfer / on-ledger settle) ran, then a status/ledger write
that could crash in between, with recovery that couldn't heal. Root-caused and fixed
via a **durable `refunding` transient status + deterministic command ids + record-
before-terminal ordering + sweep recovery of in-flight states**:
- **F1 residual:** full BTC address logged → truncated.
- **F2 residual:** terminal-before-transfer → durable `refunding` + sweep recovery.
- **F6 residual:** fee recorded after terminal `filled` → recorded before.
- **F7 residual:** duplicate-command recovery only worked when already persisted →
  persist a recovery marker on the duplicate path.
- **F5:** implemented (was deferred).

## Second re-audit (verification pass on the residual fixes) — all fixed
An adversarial pass on the F2/F5/F6/F7 fixes themselves found that some were
incomplete:
- **F5 was only sequential, not concurrent.** `sumReservedCbtcSats` excluded `"open"`
  — but every order is `"open"` during `accept()` (it flips to `"accepted"` only after
  the gate), so two concurrent accepts each missed the other and still over-committed.
  Fixed: include `"open"` in the reserved set (matching C2C `sumReservedOut`) +
  `toBaseUnitsFloor` for consistency. (Residual: read-check-write without a DB
  constraint still has a theoretical exact-simultaneity window — now equal to, not
  weaker than, the C2C path; a fully atomic guard is a larger follow-up.)
- **F2 rollback clobber.** The transfer-failure rollback used an unconditional
  `store.put`, which could revert a concurrent sweep's `refunded` → `refunding`. Fixed:
  `putIfStatus(rollback, "refunding")` (CAS) in both refund paths.
- **F2 early-refund stuck.** A crashed early refund (`refunding`, before
  `userTimelock`) matched no sweep bucket. Fixed: `loopCustodyStalled` now includes
  `refunding`.
- **F7 false-failure + wrong comment.** `delivered:false` on recovery could make the
  client throw "offer not found" on an already-delivered direct transfer; the comment
  cited a non-existent HTLC `userReceivedCounterLeg`. Fixed: recovery disambiguates
  offer-vs-direct via the user's pending offers (pending → accept; none → delivered);
  comment corrected.

Verified sound (no change): `putIfStatus` CAS atomicity (single row-locked UPDATE →
one winner); deterministic refund commandId dedup (Canton keys on
applicationId+commandId+actAs, not input holdings) → shared id is mutually idempotent,
no double-pay; F6 record-before-terminal re-entrancy; the sweep route actually calls
the refund functions for the `refunding` buckets.

## Remaining deploy action (carried from 2026-06-20)
- [ ] Apply migrations **027** (`settlement_update_id` unique) **and 028** (network-fee
  preapproval CID binding) to the new prod DB (`oshqecdsloajfhdhhiul`) if not already
  applied. Old DB has 027; confirm 028 has reached production.

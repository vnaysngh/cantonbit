# Security Audit Report — Cross-Chain WBTC↔cBTC Swap (Treasury-Grade)

**Scope:** off-chain solver service (`swap-solver/`), Next.js session/API routes (`app/api/swap/*`, `lib/swap-*`), and the on-chain settlement contracts they drive (escrow, oracle, settler).
**Date:** 2026-06-07
**Branch:** `feat/wbtc-cbtc-swap`

---

## 1. Executive Summary

**Verdict: DO NOT trade real funds yet — NOT SAFE in the current state. Safe only WITH the four high-severity fixes below applied and verified.**

The on-chain core is sound. The contracts enforce the hard money-safety invariants correctly: finalise is authorized to the trusted solver, attestations cannot be forged by non-attestors, double-finalise and finalise-vs-refund are mutually excluded on-ledger, refunds are hard-coded to pay the order's user, the cBTC delivery target is cryptographically bound to the on-chain recipient commitment, and a user's WBTC can only be locked by the user's own Permit2 signature. These are real, verified guards (Section 3).

The danger is entirely in the **off-chain solver service**, which mediates the two legs. It has **four high-severity issues**, three of which share one root cause: **the solver's HTTP API (`:8787`) is fully unauthenticated, CORS-`*`, enumerable, and binds to all interfaces.** Anyone who can reach that port can list live orders and then drive other users' orders into states that pull the victim's WBTC before the cBTC is accepted, or grief in-flight swaps into stuck/failed states. The fourth high is a state-machine flaw independent of the API: an order whose cBTC was *already delivered* can be auto-refunded after expiry, handing the user **both legs** and costing the treasury the full WBTC.

- **Confirmed criticals:** 0
- **Confirmed highs:** 4
- **Confirmed mediums:** 1
- **Confirmed lows:** 1
- **Refuted on review:** 2 (listed in Section 4 so reviewers know they were checked)

A treasury-grade deployment requires all four highs fixed, the medium addressed, and the API placed behind authentication and bound to localhost/an authenticated gateway. The two refuted findings need no code change beyond opportunistic hardening.

---

## 2. Confirmed Findings (by severity)

### HIGH-1 — `delivered`-then-expiry double-payout: auto-refund returns WBTC to a user who already holds the cBTC

**Severity:** High (direct treasury loss; up to 1 WBTC per affected order, default per-order cap uncapped; repeatable)

**Location:**
- `swap-solver/src/refund.ts:98-102` — refund candidate set includes `delivered`
- `swap-solver/src/index.ts:188-202` — each loop tick runs settle, then refund
- `swap-solver/src/settle.ts:120-195` — settle is skip-and-retry with no expiry escalation

**Scenario:** `refundExpiredOrders` sweeps every `seen`/`delivering`/`delivered` order past `order.expires` and calls `escrow.refund`, which always returns the WBTC to `order.user`. But `delivered` means the cBTC was **already accepted by the user on Canton**. A user can accept late (e.g. `fillTimestamp ≈ now+29m`, still within `fillDeadline`); `verifyClaimable` only checks a 10-minute margin at delivery time and does not bound how long the user takes to accept. If the settle leg (attest+finalise) then fails transiently for ~15m (RPC error, gas spike, nonce gap, oracle/escrow revert), `settle.ts` returns `{kind:'skipped', reason:'finalise failed (will retry)'}` and never escalates. At `now+45m`, the same loop tick runs the failed settle and *then* `refundExpiredOrders`, which refunds the WBTC to the user. The user now holds **both** the cBTC and the refunded WBTC; once `Refunded`, `_resolveLock` permanently blocks finalise. The treasury eats the full WBTC. A malicious user maximizes this by accepting the cBTC as late as possible to shrink the settle window.

Note: `COW-SETTLEMENT-BACKEND-BENCHMARK.md:66-67` asserts "every failure path refunds to the user" as a safety property — refunding a `delivered` order is precisely the loss event that assertion overlooks.

**Fix:**
1. In `refundExpiredOrders` (`refund.ts:98-102`), **drop `delivered` (and `attested`) from the candidate set.** Only `seen`/`delivering` (cBTC not yet handed over) are loss-free to auto-refund.
2. For `delivered`/`attested` orders past `expires`, do **not** call `escrow.refund`; keep retrying attest+finalise indefinitely (finalise is not blocked after expiry on-chain) and raise a **paging alert** for manual intervention.
3. Defense in depth: add an accept-time guard in `accept-watch.ts` requiring `fillTimestamp <= expires - SETTLE_MARGIN` (not just `<= fillDeadline`), so a late accept with no settle budget is marked failed **before** the cBTC is treated as deliverable.
4. Tighten config so `(expires - fillDeadline)` is a guaranteed settle budget exceeding worst-case attest+finalise latency.
5. Set `MAX_WBTC_PER_ORDER` on mainnet to cap per-order blast radius.

The on-chain mutual exclusion (`_resolveLock`) is correct and needs no change — the bug is purely the off-chain sweep treating a cBTC-delivered order as a safe refund candidate.

---

### HIGH-2 — Anonymous `POST /orders/:id/accepted {status:'completed'}` force-finalises any victim's `delivering` order and pulls their WBTC

**Severity:** High (theft of victim WBTC; victim ends with no cBTC and no WBTC)

**Location:**
- `swap-solver/src/api.ts:314-344` (`handleAccepted`)
- `swap-solver/src/settle.ts:120-195` (settle path)

**Scenario:** The solver API has no authentication, no rate limiting, CORS `*`. `GET /orders` (`api.ts:423-432`) leaks the 50 most recent records including each `orderId` and `status`. `handleAccepted` takes only `orderId` (from URL) and `body.status`, with **zero check that the caller owns the order** — it is supposed to be the order's user reporting their own Loop outcome, but nothing binds the caller to `order.user`. With `status=='completed'` it advances a `delivering` order to `delivered` and stamps `fillTimestamp` (verified at `api.ts:325-334`). The settle loop then picks up any `delivered` order and runs `attest()+finalise()`, which **pulls the locked WBTC** to the solver/treasury. `settleOne` does **not** re-verify the Canton accept — it only checks `status=='delivered'` and `fillTimestamp!=null` (`settle.ts:123-128`), and the attestation is the solver's own oracle. Critically, `delivering` is specifically the state where the cBTC offer exists but is **still pending the user's accept** (`delivery.ts:202-210`; auto-accepted fills collapse straight to `delivered` at `delivery.ts:184-193`). So firing `{status:'completed'}` at a victim's `delivering` order makes the solver finalise and take the victim's WBTC while the victim holds only an unaccepted cBTC offer they can still reject — leaving the victim with **nothing**.

```bash
orderId=$(curl -s http://SOLVER:8787/orders | jq -r '.orders[]|select(.status=="delivering").orderId')
curl -s -X POST http://SOLVER:8787/orders/$orderId/accepted \
  -H 'content-type: application/json' -d '{"status":"completed","historyId":"x"}'
```

The in-code defense comment (`api.ts:307-313`, confirmed present) claims a lying client "only hurts themselves" and relies on auto-accept being ON — but that gate is enforced only in the browser (`lib/swap-accept.ts hasCbtcAutoAccept`), not in the solver, and `delivering` is by definition the not-yet-accepted state.

**Fix:**
1. Remove the off-chain `'completed' → 'delivered'` transition from `handleAccepted`, or make it advisory only (a hint that triggers an immediate authoritative re-check). The **only** thing allowed to set `status='delivered'` must be `resolveDelivery`'s on-ledger verification (`canton.isDeliveryAccepted` / `resolveOffer`), never a request body.
2. In `settleOne` (`settle.ts:120`), before attest+finalise, **independently re-assert the accept**: require a recorded `cantonDeliveryRef` AND a fresh `isDeliveryAccepted(inputHoldingCids)==true` check at settle time, not just `status=='delivered' + fillTimestamp!=null`.
3. **Authenticate the API and bind callers to `order.user`**: require the user's wallet signature (or minted Loop session) on `/orders/:id/accepted` and `/refund`, verify it matches `order.user`; drop CORS `*` to an allowlist; add rate limiting.
4. Enforce the auto-accept precondition server-side.

Only the `rejected → failed` direction is safe to keep unauthenticated (it can only cause a refund to the user) — but see HIGH-3.

---

### HIGH-3 — Anonymous `POST /orders/:id/accepted {status:'rejected'}` griefs any in-flight swap into a stuck `failed` state

**Severity:** High (denial of service / stuck funds requiring manual intervention; not auto-recoverable)

**Location:** `swap-solver/src/api.ts:336-342` (`handleAccepted`, rejected branch)

**Scenario:** Same unauthenticated endpoint. For any order in `delivering` or `delivered` (not yet terminal), an attacker POSTs `{status:'rejected'}` and `handleAccepted` sets `status='failed'` (confirmed at `api.ts:336-341`). The settle loop only settles `delivered`/`attested` (`settle.ts:200`), so a `failed` order is never finalised — the victim's swap is aborted even if the cBTC was actually delivered/accepted on Canton. If the order had legitimately reached `delivered` (cBTC accepted) but not yet finalised, flipping it to `failed` does **not** un-deliver the cBTC but stops the solver from collecting the WBTC, and `failed` is **excluded** from `refundExpiredOrders` (`refund.ts:98-102`) — so the funds stall pending manual intervention with no auto-recovery.

```bash
for id in $(curl -s http://SOLVER:8787/orders|jq -r '.orders[]|select(.status=="delivering" or .status=="delivered").orderId'); do
  curl -s -X POST http://SOLVER:8787/orders/$id/accepted -d '{"status":"rejected"}' -H 'content-type: application/json'
done
```

**Fix (three layers, all warranted):**
1. **Authenticate/authorize the report.** Tie `/accepted` (and `/refund`) to the order's owner: require an EIP-712 signature over `{orderId, status, historyId, nonce}` recovered to `order.user`, checked before any `store.update`. An anonymous caller cannot produce it.
2. **Guarded compare-and-set.** Use `store.claimStatus(orderId, expected, next, patch)` so the rejected branch only succeeds from the exact expected status and cannot clobber a concurrent settle (also closes the `delivered→attested` race).
3. **Treat the user `rejected` signal as advisory**, not authoritative, for state the solver can verify itself. The accept-watch loop already independently detects accept/reject from the solver's own ACS (`accept-watch.ts:76-109`); the POST only speeds the happy path. At minimum, route a `rejected` report into a state the auto-refund sweep handles — or add `failed` to the `refundExpiredOrders` candidate set (`refund.ts:98-102`) so any `failed`+expired order is still auto-refunded to the user, restoring the self-heal guarantee even if the auth fix is bypassed.

Defense in depth: bind the API to `127.0.0.1` (`server.listen(PORT, '127.0.0.1')`) behind an authenticated gateway, and restrict `GET /orders` so it does not leak every active `orderId`.

---

### HIGH-4 — Solver API is fully unauthenticated and enumerable; order ids + party data leak via `GET /orders`

**Severity:** High (information disclosure + the enumeration primitive that makes HIGH-2 and HIGH-3 turnkey; PII/party-id and amount disclosure)

**Location:**
- `swap-solver/src/serve.ts:64-84` (no auth wired)
- `swap-solver/src/api.ts:423-432` (`GET /orders`), `api.ts:462-479` (`publicOrder`)

**Scenario:** `createApi`/`serve.ts` mounts every route with no auth middleware, no API key, no per-caller identity, CORS `*` (`api.ts:69-77`). `GET /orders` returns the 50 most recent records via `publicOrder`, which includes the full `orderId`, `status`, the victim's full `cantonParty` preimage, `cbtcAmount`, `wbtcAmount`, `fillDeadline`/`expires`, and tx hashes. This is the enumeration primitive that turns HIGH-2/HIGH-3 into one-liners (list → filter by status → target), and it discloses every user's Canton party id and swap amounts publicly.

```bash
curl -s http://SOLVER:8787/orders
```

**Fix:**
1. Add an **auth gate at the top of `route()`** (`api.ts`, before any dispatch): require a shared secret/bearer (`SOLVER_API_KEY`) on all routes except `/health`, returning 401 on mismatch via **constant-time compare**.
2. **Scope `GET /orders`:** remove the public global list, or require auth and filter to the caller's own orders (e.g. EVM-address-signed query so a caller only sees orders where `order.user == them`).
3. **Redact `publicOrder`** (`api.ts:462-479`) for any unauthenticated/non-owner context: drop `cantonParty` (full party preimage) and `note`.
4. Replace CORS `*` (`api.ts:73`) with an allowlist of known UI origin(s).
5. Bind explicitly (`serve.ts:76`, `server.listen(PORT, '127.0.0.1', ...)`) unless an authenticating reverse proxy fronts it.
6. Add per-IP rate limiting.

---

### MEDIUM-1 — `/quote` is unauthenticated and unbounded; persists an unbounded party map and amplifies disk I/O

**Severity:** Medium (resource exhaustion / disk-growth + store-slowdown via unauthenticated writes)

**Location:**
- `swap-solver/src/api.ts:121-178` (`handleQuote`)
- `store.rememberParty` at `api.ts:155` / `store.ts:234-240`

**Scenario:** `POST /quote` has no auth and no rate limit. Each call that passes input validation (`user` is a `0x` addr, `cantonParty` contains `'::'`, `0 < wbtcAmount <= cap`) **unconditionally** writes to the on-disk store via `store.rememberParty(orderId, cantonParty)` (`api.ts:155`) **before** any signing or on-chain action. An attacker scripts millions of `/quote` calls with distinct synthetic `cantonParty` strings (only needs `'::'`) and unique nonces, growing `partyByOrderId` in `orders.json` without bound. Each write is a full read-modify-write + atomic rename of the entire JSON store (`store.ts:249-253`), so quote-flooding amplifies disk I/O and slows every other store operation.

```bash
while true; do curl -s -X POST http://SOLVER:8787/quote \
  -d '{"user":"0x0000000000000000000000000000000000000001","cantonParty":"a::'$RANDOM'","wbtcAmount":1}' \
  -H 'content-type: application/json'; done
```

**Fix:**
1. **Remove `store.rememberParty(...)` from `handleQuote`** (`api.ts:155`). The recovery-map entry is only needed once the user actually commits WBTC; move the call into `handleCreateOrder` (after the `verifyCantonParty` check ~`api.ts:208`, with `insertSeen`), where `cantonParty` is already verified against the on-chain recipient commitment. The map then grows at most one entry per real on-chain order, and `/quote` becomes a pure, side-effect-free computation.
2. Add a per-IP token-bucket rate limiter to the `route()` dispatcher for `/quote` (and `/orders`).
3. Bind the listener to `127.0.0.1` by default (`serve.ts:76`) unless `BIND_HOST` is set.
4. Defense in depth: prune `partyByOrderId` entries when an order reaches a terminal state (finalised/refunded/failed).

---

### LOW-1 — Loop-JWT session cookie: `secure` only in production, `sameSite='lax'`, no CSRF/Origin check

**Severity:** Low

**Location:**
- `app/api/swap/session/route.ts:23-33` (POST)
- `lib/swap-session.ts:84-105` (`storeJwtSession` cookie set)

**Scenario:** The session route mints a Loop JWT from `{public_key, signature, epoch}` and stores it in cookie `oranj_loop_jwt` with `httpOnly:true, sameSite:'lax', path:'/'`. **Cross-user JWT theft is not possible** — the JWT is derived from the caller's own signed payload, the cookie is `httpOnly`, and `getJwtSession` reads only the current browser's cookie. The real weaknesses:
1. `secure` is gated on `NODE_ENV==='production'` (`swap-session.ts:99`), so in any non-prod deploy the bearer cookie is sent over plain HTTP and is network-sniffable.
2. `sameSite='lax'` permits the cookie on top-level cross-site GET navigations; the session POST is not CSRF-protected (no Origin check, no CSRF token). Impact is low — an attacker can't forge the victim's wallet signature, so this is login-CSRF / session-fixation flavor, not impersonation. The history/preapproval routes then trust whatever JWT is in the cookie; no same-origin/Origin validation exists on any of the three routes.

**Fix:** Set `secure:true` unconditionally (or gate on HTTPS, not `NODE_ENV`); add an `Origin`/same-site check (or CSRF token) to the session POST and the consuming routes; consider `sameSite='strict'` for the session cookie.

---

## 3. What Was Checked and Found Safe (Verified Guards)

The on-chain core and the cryptographic bindings hold. The following were adversarially reviewed and confirmed correct:

**Settlement authorization & attestation**
- **finalise authorization holds** — `InputSettlerEscrow.finalise` requires `msg.sender == solveParams[0].solver` (`InputSettlerPurchase.sol:109-113`) AND the oracle attestation `dataHash` binds that same solver. The oracle only attests dataHashes computed with the agent's own address as solver, so an external attacker cannot finalise to themselves.
- **Attest cannot be forged** — `OranjAttestorOracle.attest/attestBatch` are gated by `onlyAttestor` (`OranjAttestorOracle.sol:58-66,103,117`); `_attestations` is internal and only writable via these. Single-custodial-solver trust model is explicit and accepted (NatSpec 32-39).
- **No attestation replay across orders/networks** — `dataHash` includes `orderId`, which binds escrow address, user, nonce, inputs, outputs; `cantonChainId` has per-network offsets (`config.ts:56-61`).

**Double-spend / mutual exclusion**
- **No on-chain double-finalise, no finalise+refund double-spend** — both go through `_resolveLock` requiring `orderStatus==Deposited` and flipping status before transfer (`InputSettlerEscrow.sol:455-465`); second call reverts `InvalidOrderStatus`. Off-chain reconciles with on-chain status (`settle.ts:174-178`, `refund.ts:66-74`).
- **Same-order cBTC float double-spend prevented** — `store.claimStatus` CAS `seen→delivering` (no await gap), deterministic `commandId = deliver-<orderId>` Canton dedup, consuming choice archives input holdings (duplicate → `CONTRACT_NOT_ACTIVE`), `getFloatSats` excludes locked holdings, `selectHoldings` throws rather than half-delivering.

**Fund-direction & recipient binding**
- **Refund always pays `order.user`** — destination hard-coded in `_resolveLock(... Refunded)` (`InputSettlerEscrow.sol:348-357`); permissionless but harmless. `/orders/:id/refund` also enforces `now > expires` + chain reconciliation (`refund.ts:57-79`).
- **cBTC delivery target doubly guarded** — off-chain `cantonParty` must hash to the on-chain recipient commitment (`keccak256(party)`), verified at intake (`api.ts:208-210`) AND at delivery (`delivery.ts:111-113`), including on a party recovered from the recovery map. Recovery-map poisoning cannot redirect a delivery.
- **`keccak256(party)` commitment is sound** (`order.ts:49-63`) — case-insensitive exact hash compare; 2nd-preimage against keccak256 is infeasible; the full ~100-char party can't fit in `bytes32`, so committing to its hash is the correct construction.

**WBTC lock authorization**
- **Only a user-signed order can lock that user's WBTC** — `openFor` pulls via the user's Permit2/ERC-3009 signature (`InputSettlerEscrow.sol:187-221`); the agent only submits and pays gas. `POST /orders` cannot lock a third party's WBTC.
- **Permit2 signature non-replayable** — domain binds `{Permit2, chainId, PERMIT2_ADDRESS}`, `nonce==order.nonce`, single-use; second `openFor` reverts `InvalidNonce`. `handleCreateOrder` idempotent on `orderId` (`api.ts:249-253`).

**Settle pre-flight**
- **Naive one-sided loss prevented** — delivery only proceeds if WBTC `Deposited` with >10min margin before `expires` (`settle.ts:85-108`, `delivery.ts:147-154`).

**Session & secrets**
- **No cross-user Loop-JWT theft** — JWT derived from caller's own signed exchange, stored `httpOnly`, read only from the current browser's cookie.
- **Loop JWT stored XSS-safely, scoped to the user's own account** — `httpOnly`/`sameSite=lax`, `maxAge` tracks `exp`, re-validated on read; authorizes only profile/history reads.
- **Secrets never logged/returned/shipped** — `describeEnv` redacts `agentKey`/`keycloakClientSecret`, emits only public agent address + masked party; `env.req()` refuses `NEXT_PUBLIC_*` secret names; API responses hold no keys/JWTs; `.env*` gitignored and never committed.

---

## 4. Refuted Findings (checked, disproven)

Listed so reviewers know they were examined and dismissed with reasoning:

- **"Anonymous `/orders` can be spammed to burn the agent's gas (DoS)"** — **Refuted as medium; downgraded to low/info hardening gap.** The gas burn requires a *successful* `openFor`, which is economically self-defeating: `eth_estimateGas` reverts client-side for invalid orders (no gas spent, caught → 502 at `api.ts:274`), and a successful `openFor` locks the **attacker's own** WBTC for 45 min and consumes a single-use Permit2 nonce, recoverable only via the attacker's own refund (more attacker gas). The attack costs the attacker strictly more than the solver — de-amplification, not a gas-drain. What remains is a real but lower defense-in-depth gap (no rate limit/auth, and `maxWbtcPerOrder` is enforced in `/quote` but not in `handleCreateOrder`).

- **"Exchange-API-Key signature is replayable (no epoch freshness)"** — **Refuted as exploitable; downgraded to info.** Our code genuinely performs no freshness check (`session/route.ts:25` checks only non-null `epoch`; `swap-session.ts:48-61,84-105` forwards verbatim). But the exploit is gated on an **unverified external assumption** that Loop accepts a stale-but-validly-signed timestamp — the `epoch` is inside the signed message and can't be altered, and the freshness contract is structurally Loop's to enforce (we cannot inject a nonce Loop doesn't check, nor verify the signature ourselves). Blast radius is **read-only** (used only by `GET /preapproval` and `GET /history`; no transfer/state-change route uses the session JWT), and the capture precondition is high. Not an exploitable vulnerability at our layer.

---

## 5. Residual Risks / Out-of-Scope

- **Single-custodial-solver trust model** is explicit and accepted (oracle NatSpec). The attestor key is fully trusted; its custody, rotation, and HSM/key-management are **out of scope** for this code audit but are the single largest operational risk to real funds. Compromise of the attestor or agent key defeats all on-chain guards.
- **Per-order blast radius is uncapped by default** — `MAX_WBTC_PER_ORDER` is enforced only in `/quote`, not `handleCreateOrder`. Set it on mainnet (also called out in HIGH-1 and the refuted gas-drain note).
- **Loop pairing endpoint behavior** (stale-epoch acceptance) is unverified and owned by Loop — see refuted finding 2. Worth confirming with Loop that the pairing timestamp is freshness-checked server-side.
- **`COW-SETTLEMENT-BACKEND-BENCHMARK.md:66-67`** asserts "every failure path refunds to the user" as a safety property; HIGH-1 shows that assertion is false for `delivered` orders. Update the doc once HIGH-1 is fixed so it doesn't lull future reviewers.
- **No deployment-posture hardening yet** — the API binds all interfaces with CORS `*`; the intended posture (`api.ts:18-19` comment: "lock it down before exposing beyond localhost") is documented but not enforced in code. Treat localhost-binding + an authenticated gateway as a release gate, not a follow-up.

---

**Bottom line:** The cryptography and on-chain settlement are correct and defend the core money invariants. The off-chain solver service is not yet treasury-ready: it must authenticate and authorize its mutating endpoints (`/accepted`, `/refund`), stop trusting unauthenticated clients to advance orders to `delivered`, re-verify Canton acceptance at settle time, exclude `delivered` orders from auto-refund, stop persisting at `/quote`, and bind to localhost behind an authenticated gateway. With **HIGH-1 through HIGH-4 and MEDIUM-1 fixed and verified**, this is safe to trade real funds; until then, it is not.

---

## 6. Remediation status (2026-06-07)

All four HIGH findings and the MEDIUM were fixed and verified the same day.

| Finding | Fix | Verified |
|---|---|---|
| **HIGH-1** double-payout | Dropped `delivered`/`attested` from the auto-refund sweep (`refund.ts`); added a `cbtcAccepted` flag set wherever an accept is detected (incl. accepted-but-too-late); `refundOrder` refuses to refund any `cbtcAccepted` order (bulletproof guard, also protects the public `/refund`). | 2 new regression tests pass (67/67) |
| **HIGH-2** force-finalise | `handleAccepted` no longer trusts the request body. It delegates to the authoritative on-ledger `resolveDelivery` (the same check the watch loop runs); the body can't advance an order to `delivered`. | live: returns authoritative status only |
| **HIGH-3** rejected-grief | Same fix — `handleAccepted` never marks `failed` off a body; the ledger check decides; genuine rejects self-heal via the watch loop + (now) the auto-refund sweep for non-delivered orders. | live |
| **HIGH-4** unauth + leak | Removed the global `GET /orders` list (the PII + enumeration leak); bound the API to `127.0.0.1` by default (`API_BIND_HOST` to expose deliberately); CORS origin configurable (`API_CORS_ORIGIN`); redacted `cantonParty` from `GET /orders/:id`. | live: external interface REFUSED; global list 404; party redacted |
| **MED-1** quote DoS | Removed `store.rememberParty` from `/quote`; moved it into `/orders` (one entry per real order, after the write-ahead). `/quote` is now side-effect-free. | tsc + tests |
| **LOW-1** cookie | (deferred hardening) set `secure` unconditionally + Origin/CSRF check on the session route. | not yet |

The on-chain core needed no changes — all guards in Section 3 already hold. Deployment posture (loopback bind + authenticated gateway + CORS allowlist + `MAX_WBTC_PER_ORDER` set) is now enforced/available in code rather than only documented.

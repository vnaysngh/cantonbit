# CoW security-control benchmark — control by control

For EVERY security control CoW Protocol has (read from its real code in
`cow-contracts` + `cow-services`), this maps our equivalent and classifies it
**MATCH** / **WEAKER** / **GAP** / **N/A**. This is a *security* benchmark — the
guards that stop theft/replay/abuse — not an architecture comparison.

**Our substrate:** the on-chain side reuses the audited OIF `InputSettlerEscrow`
(not custom); the only custom Solidity is `OranjAttestorOracle.sol`. The solver
is a single-process Node service. By explicit design this is a **single-solver
custodial, two-legged (non-atomic)** settlement — that drives the N/A rows.

## On-chain controls

| CoW control | CoW mechanism | Ours | Class |
|---|---|---|---|
| 1.1 onlySolver | only allow-listed solvers settle | `onlyAttestor` on attest + finalise gated by order-owner/claimant + `efficientRequireProven` | ✅ MATCH (attestor key = the allow-list) |
| 1.5 onlyInteraction | only self wipes replay storage | no user interaction surface touches replay state | N/A (CoW-specific) |
| 1.6 onlyCreator (relayer) | only settlement pulls approved funds | Permit2 per-order signed pull, `spender = escrow` | ✅ MATCH (stronger — no standing allowance) |
| 1.7 invalidateOrder owner-only | only owner cancels | `refund()` permissionless but ALWAYS pays `order.user` | ✅ MATCH (different model, owner can't be cheated) |
| 1.8/2.7 setPreSignature | owner-only presign + marker | no presign scheme (Permit2/3009/self) | N/A |
| 2.2–2.4 filledAmount over-fill/replay | settles ≤ amount, once | escrow `orderStatus` None→Deposited→Claimed/Refunded, CEI `_resolveLock` reverts on wrong status | ✅ MATCH (double-finalise / finalise-after-refund both blocked) |
| 2.6 order-UID binds digest+owner+validTo | cross-order/chain replay | `orderId` hashes chainId+escrow+user+nonce+windows+outputs; recipient=keccak(party), `verifyCantonParty` ×2 | ✅ MATCH |
| 3.1–3.7 signature security | scheme dispatch, ecdsa zero-addr, domain (chainId+contract), EIP-1271, lengths | Permit2 domain (chainId+verifyingContract); escrow AllowOpen via OZ `SignatureChecker` (ECDSA+1271); dirty-bit checks | ✅ MATCH |
| 4.1 nonReentrant | mutex on settle | CEI status-flag guard + `ReentrancyDetected` | ✅ MATCH (functionally equivalent) |
| 5.1 receiver bound to signed order | no proceeds misdirection | cBTC recipient committed in signed output; `verifyCantonParty` before delivery + at intake | ✅ MATCH |
| 5.2–5.4 limit-price | executed price respects signed limit | user signs exact cBTC out; proof binds the output amount → can't under-deliver & finalise | ✅ MATCH (fixed-rate) |
| 5.5 balance-check-by-revert | solver under-delivery fails | `verifyClaimable` requires on-chain `Deposited`; finalise can't succeed without real deposit; short cBTC → proof mismatch → `NotProven` | ✅ MATCH |
| 5.6 safeTransfer | reverts on silent-fail tokens | OZ `SafeERC20` + token-code check | ✅ MATCH |
| 5.7 expiry | validTo enforced | `fillDeadline` + `expires` on-chain at open & finalise; `FilledTooLate`; off-chain intake window | ✅ MATCH |
| 6.1/6.2 SafeMath/SafeCast | overflow safety | Solidity ^0.8.26 checked math; uint32 timestamps | ✅ MATCH |
| 7.1 relayer interaction blacklist | block allowance drain via interaction | we execute NO arbitrary interactions | N/A (no surface) |

**On-chain verdict: MATCH on every applicable control.** The escrow is audited OIF;
the guards CoW enforces in custom Solidity, OIF enforces equivalently. The N/A rows
are CoW-specific surfaces our design doesn't have.

## Off-chain controls

| CoW control | CoW mechanism | Ours | Class |
|---|---|---|---|
| AUTH (owner-bound state changes) | unauth transport, but every state change carries an EIP-712 sig recovered to `order.owner`; cancel/replace → `WrongOwner` | `POST /orders` IS owner-bound (Permit2 sig). `/refund` + `/accepted` are NOT owner-bound — but safe-by-consequence (refund only pays `order.user`; `/accepted` is advisory, ignores body, re-checks ledger) | 🟡 WEAKER |
| INTAKE VALIDATION | app-data → owner → zero-amt → banned tokens → validTo window → **balance/allowance simulation** → gas cap → per-user limit | amount + per-order cap + validTo window + recipient binding. Missing: balance/allowance pre-flight (relies on openFor revert), banned-token list, per-user limit | 🟡 WEAKER |
| DoS protections | 16KiB body, 8KiB app-data, batch cap, 2s sim timeout, **rate-limiter**, request-sharing dedup | 1MB body cap (loose), loopback bind, idempotent /orders, removed enumeration. **No rate-limiter** | 🔴 GAP |
| SETTLEMENT AUTH defense-in-depth | driver settles only its own cached solution + removes; observer rejects non-winning settlement | `claimStatus` CAS (seen→delivering), deterministic `commandId` ledger dedup, settle idempotent vs on-chain status | ✅ MATCH |
| REPLAY / DUP | Postgres unique on uid → DuplicatedOrder | store first-write-wins + escrow `orderStatus!=None` revert + Canton commandId/consuming-choice | ✅ MATCH (3 layers, chain-enforced) |
| REORG / finality | reorg-aware indexing w/ rollback | watcher cursor follows head, **no confirmation depth / rollback** — but safe because `verifyClaimable` live-reads `Deposited` before any cBTC leaves | 🟡 WEAKER (safe-by-downstream-guard) |
| SECRET handling | key redaction | `describeEnv` masks keys/secrets; NEXT_PUBLIC guard; no secrets in responses; JWT httpOnly server-side | ✅ MATCH |

## The actionable delta vs CoW (every WEAKER + GAP)

1. **🔴 GAP — no rate-limiter** on the solver API. `/quote` + `/orders` have zero throttling. Mitigated today only by loopback-default bind; any real exposure (`API_BIND_HOST=0.0.0.0`) is open to floods. **CoW has a rate-limiter + sim timeout + request-sharing.** → add per-IP rate limiting before exposing beyond localhost.
2. **🟡 body limit 1MB, not 16KiB** — tighten (largest legit body < 4KiB).
3. **🟡 `/refund` + `/accepted` not owner-bound by signature** — CoW recovers a sig and rejects `WrongOwner`. Ours are safe-by-consequence, but a third party who learns an orderId can trigger a (harmless) refund/re-check on another user's order. → bind to a user signature/session for defense-in-depth.
4. **🟡 no balance/allowance pre-flight at intake** — CoW simulates before accepting; we let `openFor` revert (wastes agent gas on a bad order). → cheap `balanceOf` + Permit2-allowance read before submitting.
5. **🟡 no banned-token list / no per-user order limit** — low risk (input token pinned to configured WBTC; orderId binds it), but explicit CoW stages we lack.
6. **🟡 watcher not reorg-aware** — cursor follows head with no confirmation buffer. Safe today because `verifyClaimable` live-reads `Deposited` before delivering cBTC, so a reorg'd-away deposit just fails pre-flight. → add a small confirmation buffer for defense-in-depth.

## The one accepted trust assumption (not a CoW-comparable control)

The **attestor key is treasury-grade and can release escrow with no on-chain proof
of real cBTC delivery** (`OranjAttestorOracle.sol:32-39`). This is inherent to a
single-solver custodial v1, explicitly documented, and is NOT a trustless control
CoW has an equivalent of — it's the fundamental trust difference. Key custody /
HSM / rotation is the largest operational risk and is a deployment concern.

## Bottom line

**On-chain: matches CoW on every applicable control** (audited OIF substrate).
**Off-chain: one real GAP (rate-limiting) and five WEAKER items**, none of which
lose funds today (each is mitigated by a downstream guard or by being
safe-by-consequence), but all of which CoW hardens explicitly. The rate-limiter
is the must-fix before any non-localhost exposure.

---

## Remediation (2026-06-07) — deltas closed

| Delta | Action | Verified live |
|---|---|---|
| **#1 rate-limiter (GAP)** | Added a per-IP token-bucket limiter (`api.ts` — 10 rps / 30 burst, `/health` exempt, configurable via `API_RATE_RPS`/`API_RATE_BURST`). | `/quote` flood → 429s; `/health` 20/20 OK; normal user polling 0 × 429 |
| **#2 body limit (WEAKER)** | Tightened 1 MB → 16 KiB (`MAX_BODY_BYTES`), matching CoW; oversized → 413. | 20 KB body → 413 |

Remaining deltas (#3 owner-bound /refund+/accepted, #4 balance pre-flight, #5 banned-token list / per-user cap, #6 reorg confirmation buffer) are documented above as defense-in-depth — each is currently mitigated (safe-by-consequence or by a downstream live-read guard) and none lose funds. They are the next hardening tier, not release blockers for a localhost-bound single-solver v1.

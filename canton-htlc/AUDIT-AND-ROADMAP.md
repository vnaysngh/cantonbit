# Audit + Roadmap to Full Trustless Atomic EVM↔Canton Swap

> Honest audit of the actual code (read line-by-line, 2026-06), not a recap.
> Tests passing ≠ production-ready. Below: what's real, what's a stub, what's
> unsafe, and the ordered task list to a shippable trustless atomic swap.

## Verdict in one line
The **design is proven** (EVM HTLC 8/8, Canton HTLC 5/5 against real Splice DARs,
matched to Cancore). But what exists are **verification prototypes**, not
production contracts/services. ~30% built. The hard remaining work is: (a) the
on-node registry spike, (b) hardening both HTLC contracts, (c) the orchestrator
rewire, (d) e2e + recovery testing.

---

## A. EVM HTLC (`contracts/src/HTLCEscrow.sol`) — PROTOTYPE, has real gaps

WHAT'S GOOD: clean lock/claim/refund state machine, SHA-256 (matches Daml),
safety-deposit-to-finisher, 8/8 happy-path tests.

GAPS / RISKS (the tests don't cover these):
1. **No reentrancy guard.** `claim`/`refund` do an external `token.transfer` AND a
   raw `.call` for the safety deposit. A malicious token or claimer can reenter.
   State IS set before the calls (good), but add `nonReentrant` + checks-effects.
2. **No Permit2 / gasless lock.** Today `lock` does `transferFrom` (needs prior
   approve). Production wants the user's signed intent (Permit2) → the resolver
   locks on their behalf. Current `HTLCEscrow` is NOT wired to the existing
   `InputSettlerEscrow`/Permit2 flow at all — it's standalone.
3. **`swapId` is caller-supplied + unbound to order.** Anyone picks any `swapId`;
   no link to a signed order, amounts, or the Canton leg. Needs binding to the
   order hash so the two legs provably match.
4. **Hashlock uses `sha256(abi.encodePacked(preimage))` over a bytes32.** The
   Daml side hashes a Text hex string. THESE PRODUCE DIFFERENT DIGESTS. Encoding
   parity is UNRESOLVED (see canton-htlc/VERIFY.md). Must pin one encoding.
5. **No timelock-ladder enforcement.** Nothing checks that the EVM timelock is
   later than the Canton one (the T_src > T_dst safety invariant). Caller can set
   any timelock.
6. **No fees, no min/max amount, no pause/admin.** Fine for v1 but note it.
7. **Tokens with transfer-fee / non-standard ERC20** not handled (uses bool return).

## B. Canton HTLC (`canton-htlc/daml/CbtcHtlc.daml`) — PROTOTYPE, sound but unproven on-node

WHAT'S GOOD: compiles against REAL Splice DARs; correct use of Allocation
(ExecuteTransfer / Withdraw); preimage + timelock gates; 5/5 Daml tests.

GAPS / RISKS:
1. **Pre-delegation UNPROVEN on a real registry.** The whole "executor fires
   ExecuteTransfer alone" rests on the cBTC/CC registry pre-delegating sender+
   receiver consent at allocation time. The SANDBOX MOCK could not prove this
   (test models it with one party). THIS IS THE #1 UNKNOWN → SPIKE.md.
2. **`Claim` controller = executor only.** If the registry does NOT fully
   pre-delegate, the real claim needs receiver co-auth (Cancore's "node signs on
   your behalf" mode). Fallback path not yet designed.
3. **No binding between `hashLock`/`unlockTime` and the Allocation's own
   settleBefore.** A comment says "SHOULD be <=" but it's not enforced. If
   unlockTime > settleBefore, the registry could reject execute after our gate
   passed → stuck. Must assert the relationship at creation.
4. **No amount/instrument check** that the Allocation matches the intended swap
   (the template trusts allocationCid blindly). Add view checks.
5. **`sha256` is an alpha Daml feature** (warning). Acceptable, but pin SDK + note.
6. **Refund relies on the holder still being able to Withdraw** — confirm the
   registry honors Allocation_Withdraw within the window on-node.

## C. Orchestrator (`swap-solver/` ~8.8k LOC) — EXISTS but is the OLD trusted-oracle model

The solver is the optimistic-oracle relay (delivery.ts → TransferInstruction,
settle.ts → attest+finalise on OranjAttestorOracle, accept-watch.ts, refund.ts).
NONE of it is wired to the HTLC. To reach trustless it must be rewired (not
rewritten — ~70% reuse): see task list T7–T11.

## D. Encoding/params — UNRESOLVED cross-cutting

- Preimage encoding parity (A4) — blocks atomicity until fixed.
- Timelock ladder values (skew_max from WarpX synchronizer) — unknown.
- Which EVM chains/tokens (USDC/WBTC on Ethereum/Arbitrum/Base) — decide.

---

## TASK LIST → full trustless atomic swap (ordered; each independently testable)

### Phase 1 — De-risk the one real unknown (BLOCKING)
- **T1. On-node registry spike (SPIKE.md).** Deploy DAR to WarpX DevNet; create a
  REAL Allocation (executor=solver, pre-delegated); HtlcLock.Claim by executor
  alone moves real cBTC. PASS → design is GO. FAIL → adopt receiver-co-sign
  fallback. *Nothing else proceeds until this is answered.*
- **T2. Preimage encoding parity.** Pin ONE encoding (recommend: hash lowercase-hex
  string on both). Fix `HTLCEscrow` to `sha256(bytes(hexString))`; add a
  cross-impl test asserting EVM H == Daml sha256 for the same secret.
- **T3. Read WarpX skew_max + set timelock ladder.** T_src − T_dst > finality_EVM
  + skew_max + buffer. Document the numbers.

### Phase 2 — Harden the two HTLC contracts
- **T4. EVM HTLC hardening.** Add `nonReentrant`; bind `swapId` to the signed
  order hash; enforce timelock ladder (EVM timelock > Canton's); SafeERC20;
  events for indexers; consider Permit2 lock so the user signs once. Expand
  Foundry tests: reentrancy, wrong-encoding, double-claim race, fee-token,
  timelock-boundary, griefing.
- **T5. Canton HTLC hardening.** Assert unlockTime <= Allocation.settleBefore;
  verify the Allocation view (amount/instrument/sender/receiver) matches the swap;
  add Daml tests for mismatch rejection; finalize the claim-auth model from T1.
- **T6. Integrate, don't replace, the audited InputSettlerEscrow IF feasible** —
  decide: greenfield HTLCEscrow vs. hash-gating the existing OIF escrow. (Audited
  base is safer; but it's oracle-shaped. Evaluate.)

### Phase 3 — Rewire the orchestrator to HTLC (swap-solver)
- **T7. order.ts / api.ts:** order now carries `hashLock` (H), srcTimelock,
  dstTimelock. User signs commit to H (they generate the secret, or the
  receiver-generated-secret variant — decide who holds s).
- **T8. delivery.ts → lock.ts:** create the Canton Allocation (executor=solver) +
  HtlcLock instead of the optimistic TransferInstruction. Reuse canton.ts
  allocate() + choice-context fetch.
- **T9. accept-watch.ts → reveal-watch.ts:** watch the Canton ledger for the
  Claim exercise; extract the preimage `s` from the choice argument.
- **T10. settle.ts:** replace attest()+finalise() with EVM `claim(s)`. DELETE
  OranjAttestorOracle and the attestor key entirely.
- **T11. refund.ts:** EVM refund() after T_src + Canton HtlcLock.Refund after
  T_dst. Remove the cbtcAccepted/delivered danger-state machinery (no longer
  needed — HTLC is atomic). Add a watchtower so the public reveal → EVM claim
  happens even if the main process is down.

### Phase 4 — Reverse direction + end-to-end
- **T12. Canton→EVM direction.** Maker locks cBTC first (Allocation+HtlcLock, late
  timelock), resolver locks WBTC (early), maker claims EVM revealing s, resolver
  claims Canton. Mirror of T7–T11.
- **T13. E2E on DevNet ⟷ Base/Arbitrum Sepolia.** Happy path both directions.
- **T14. Recovery matrix (the must-pass suite).** resolver-vanishes-after-src-lock,
  maker-never-reveals, reveal-then-crash, registry-rejects-execute, clock-skew at
  the timelock boundary. Each MUST self-heal with zero manual intervention.

### Phase 5 — Production
- **T15. Security review / external audit** of both HTLC contracts (custom
  fund-custody crypto — non-negotiable before mainnet).
- **T16. Mainnet params, monitoring, runbook, admin recovery endpoints** (like
  Cancore's reset-stuck / force-withdraw, for liveness only).
- **T17. (Optional) Dutch auction + partial fills** (Merkle-tree-of-secrets) —
  pure upside on the trustless core, do last.

---

## E. Concrete facts from the FULL Cancore doc (docs.cancore.io/usecases, all 12 sections)

These pin down things the roadmap was guessing at — fold into the tasks noted:

1. **EVM HTLC ABI shape (T4):** their refund is `retake(hash)` keyed by the
   **hashLock**, not a swapId. Lock carries `(recipient, hashLock, timeout)`. Our
   HTLCEscrow keys by caller-supplied swapId — align to the hashLock-keyed shape
   (battle-tested, and lets a watchtower refund knowing only the public hash).
2. **Two Canton locks for Canton↔Canton (Proposal + Counter-Proposal):** our single
   HtlcLock = one leg. The ORCHESTRATOR must create the right legs per use-case
   (Canton↔Canton = two HtlcLocks; Canton↔EVM = one HtlcLock + one EVM lock).
3. **Full use-case matrix to support (T7–T13):**
   - UC1–3 Canton↔Canton (both legs Daml HTLC)
   - UC4–5 Canton→EVM ; **UC7–8 EVM→Canton (PRIORITY)** ; UC6 EVM↔EVM
   - Loop variants (self-swap; needs the user's own Canton Ed25519 key / extension)
4. **Timeout derivation (T3):** order expiration → HTLC timeouts. Maker timeout ≥
   order expiration; taker counter-timeout shorter. **Min 2h for Canton swaps**
   (ensures maker > taker). Dropdown options 30m–72h. Use these as defaults.
5. **EVM→Canton ordering (UC7/8) — reconcile with research §5:** Cancore has the
   MAKER lock the EVM token FIRST (Approve+Lock), THEN the platform auto-creates
   the Canton counter-lock, then maker claims EVM (revealing s), Canton claim
   auto-completes. i.e. EVM = the longer-timeout/first-lock leg here. Our §5 had
   the resolver locking EVM source — re-derive the role/timelock assignment per
   direction so maker-first matches.
6. **Built-in-wallet auto-claim UX:** the participant node signs Canton legs AND
   auto-executes the claim ("Platform auto-claims → both_claimed"). This is the
   custodial-convenience mode that removes the manual reveal — and it's how the
   executor-pre-delegation (T1) gets used in practice. Self-custody = Loop mode.
7. **Fee model (T16, optional):** 1% per side in the sent token + network fees.
8. **Manual EVM refund path exists** (Etherscan → Write Contract → `retake(hash)`)
   — a good liveness fallback to replicate (T11/T16).

## Honest status table
| Component | State | Trustless yet? |
|---|---|---|
| EVM HTLC | prototype, 8/8 happy tests, unhardened | mechanism yes, prod no |
| Canton HTLC | prototype, 5/5 tests, on-node UNPROVEN | pending T1 |
| Encoding parity | UNRESOLVED | blocks atomicity (T2) |
| Orchestrator | old trusted-oracle model, not wired | NO — still trusted |
| Recovery/e2e | none | NO |

**Bottom line:** the trustless atomic design is real and verified at the unit
level. To make the *system* trustless: T1 (prove on node) → T2/T3 (encoding+time)
→ T4/T5 (harden) → T7–T11 (rewire solver, delete the oracle) → T13/T14 (e2e +
recovery) → T15 (audit). T1 is the gate; the oracle isn't gone until T10.

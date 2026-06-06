# Full Swap Architecture Benchmark — Us vs. CoW (every step, quote → settled)

> Mandate: benchmark EVERY architectural decision against CoW Swap (and where
> useful UniswapX / 1inch Fusion), from the moment the user gets a quote to the
> moment they hold their swapped funds. For each step: what CoW does (from
> source/docs), what we do, MATCH / DIVERGE, and if we diverge — is it a Canton
> necessity or a choice to reconsider?
>
> Sources: CoW contracts (GPv2Settlement/Order/Signing.sol), CoW docs (quote,
> orderbook, swap-and-bridge, fees), UniswapX (Permit2 nonce), 1inch Fusion
> (nonce bitmap), OIF InputSettlerEscrow, Canton token standard + ledger API.
> All verified this session unless marked [doc].

Legend: ✅ match · 🟡 match-with-Canton-necessity · 🔴 diverge-reconsider

---

## STEP 1 — Quote

| | CoW | Us |
|---|---|---|
| How | Quote runs a 1-order solver auction; returns order params + fee, ready to sign [doc] | `/quote` computes `cbtcOut = wbtcIn*(10000-feeBps)/10000`, returns the order + Permit2 typed data to sign |
| Fee | Basis points, volume-based, in the quote | `feeBps` (currently 0 = clean 1:1), subtracted from cBTC out |
| Price source | Solver competition (best of N) | Fixed 1:1 (we're the only solver; WBTC≈cBTC by peg) |

**Verdict: 🟡 MATCH (single-solver necessity).** Same shape (quote → signable order +
fee in bps). We don't run a competitive auction because we are a **single solver** —
CoW's multi-solver price competition is irrelevant at 1:1 peg with one solver. The
quote→sign handoff is identical. *Reconsider only if multiple solvers ever exist.*

---

## STEP 2 — What the user signs

| | CoW | Us |
|---|---|---|
| Object | `GPv2Order` (sellToken, buyToken, receiver, amounts, validTo, appData, feeAmount, kind, partiallyFillable, nonce…) | OIF `StandardOrder` (user, nonce, originChainId, expires, fillDeadline, inputs, outputs[recipient=keccak(cantonParty)]) via Permit2 EIP-712 |
| Scheme | EIP-712 / EthSign / EIP-1271 / PreSign | EIP-712 (Permit2 witness) |
| Replay protection | nonce + domain separator (chainId, contract) | Permit2 nonce + domain (chainId, escrow) + escrow `orderStatus` |

**Verdict: ✅ MATCH.** Both: a single EIP-712 signature over a structured order, with
chainId+contract-bound replay protection. We use Permit2 — the SAME mechanism
UniswapX uses. The only field-level difference is ours encodes a cross-chain
recipient (keccak of the Canton party); CoW's `receiver` is an EVM address. That's
the cross-chain necessity, not a design difference.

**One gap vs CoW: signing SCHEMES.** CoW supports 4 (incl. EIP-1271 for smart-contract
wallets, PreSign for contracts that can't sign). We support only EIP-712. 🟡 fine for
EOA users today; revisit if SC-wallet users need it. (Loop wallets are the signer here.)

---

## STEP 3 — Order submission / "no pre-lock"

| | CoW | Us |
|---|---|---|
| When funds leave wallet | Pulled in `settle()` via VaultRelayer allowance — at fill, atomically | Pulled by `openFor` (Permit2) — TODAY at submit (pre-lock) |
| Gas | Gasless (solver pays) | Solver (agent) pays gas to submit openFor |

**Verdict: 🔴 DIVERGE — and it's the one real architectural difference to be deliberate
about.** CoW pulls the input *at fill* (inside the atomic settle), so funds never move
until the swap executes. We pull at submit (pre-lock). BUT: we PROVED (docs/
ATOMIC-SWAP-DESIGN.md) that CoW's atomicity is single-chain; their CROSS-chain leg
(Across) DOES lock first too. So vs CoW *cross-chain*, we match (lock-then-settle).
vs CoW *same-chain*, we can't (no cross-chain atomic tx exists). **Decision on record:
keep lock-first; it equals CoW's cross-chain (Across) model. The no-pre-lock reorder
was scoped (COWSTYLE-NO-PRELOCK-PLAN.md) but is NOT closer to CoW cross-chain — it'd
move risk to the treasury for no atomicity gain.**

---

## STEP 4 — Double-spend / double-fill prevention

| | Mechanism | Atomic via |
|---|---|---|
| CoW | `filledAmount[orderUid]` map + `require(==0)` | EVM (one settle tx) |
| UniswapX | Permit2 nonce `_checkPermit2Nonce` | Permit2/EVM |
| 1inch Fusion | nonce/epoch bitmap invalidation | EVM |
| **Us — WBTC leg** | OIF escrow `orderStatus[orderId]` + `revert InvalidOrderStatus` | EVM (escrow) ✅ |
| **Us — cBTC leg** | Canton `commandId` dedup (ledger) + app-layer `claimStatus` CAS | Canton ledger + app |

**Verdict: ✅ MATCH on WBTC (same on-chain status-map pattern as CoW). 🟡 cBTC leg is
the part CoW DOESN'T HAVE (off-chain delivery).** The reference-aligned guard is to
lean on the LEDGER like CoW leans on the EVM: Canton's `commandId` + `deduplicationPeriod`
is the native equivalent of `filledAmount`/nonce. **ACTION: use a deterministic
commandId (= f(orderId)) so the ledger dedupes the delivery — currently we use a random
UUID, which defeats it. The app-layer `claimStatus` CAS (added this session) stays as
defense-in-depth, but the LEDGER dedup should be primary — that's how CoW/UniswapX do it
(chain-enforced, not app-enforced).** ← highest-priority alignment fix.

---

## STEP 5 — Fill / delivery

| | CoW | Us |
|---|---|---|
| Who delivers | Solver, in `settle()` (pulls sell, gives buy, atomically) | Solver delivers cBTC (TransferInstruction) BEFORE pulling WBTC isn't our order — we lock WBTC first, then deliver cBTC |
| Output receipt | Buyer gets buy token in the same tx | User gets a pending cBTC `TransferInstruction` to accept |

**Verdict: 🟡 DIVERGE — Canton necessity.** CoW's output delivery is atomic & final in
the settle tx. Ours is a two-step Canton transfer the user must ACCEPT (proven: the
token standard makes `TransferInstruction_Accept` receiver-controlled — solver CANNOT
auto-deliver). This is the single biggest UX divergence and it is FORCED by Canton, not
chosen. Mitigation aligned to intent-UX: bring the accept INTO our app
(CANTON-LOOP-ACCEPT-MONITORING.md) so it's one in-context approve, like a DEX confirm.

---

## STEP 6 — Settlement finalisation (releasing the input)

| | CoW | Us |
|---|---|---|
| How | Atomic in settle — input → solver, output → user, same tx | After cBTC delivered+accepted: solver `attest`s the fill to our oracle, then `finalise`s the escrow → WBTC to treasury |
| Trust | EVM atomic | Solver + our oracle attestation |

**Verdict: 🟡 DIVERGE — Canton necessity.** CoW binds the two transfers atomically. We
can't (cross-chain), so we use the OIF optimistic oracle + solver — which IS how CoW's
cross-chain bridge (Across) works (optimistic verification, bonded relayer). Same family.
*Note: our oracle is single-party (us). Across uses bonded multi-party optimistic
verification. For a single-solver custodial model this is acceptable and documented, but
it's the trust difference vs a decentralised bridge.*

---

## STEP 7 — Expiry / refund

| | CoW | Us |
|---|---|---|
| Refund trigger | Permissionless ("any account") | Permissionless (escrow `refund()` always pays order.user) ✅ |
| Auto-refund service | Monitors expired orders, auto-refunds | `refundExpiredOrders` sweep in the watch loop ✅ |
| Invalidate-once | `filledAmount = max` | escrow `orderStatus` (Claimed/Refunded) prevents double ✅ |
| Manual refund | tx-hash tool | `POST /orders/:id/refund` ✅ |
| Window | order `validTo` | order `expires` (configurable) ✅ |

**Verdict: ✅ MATCH — fully aligned with CoW.** Permissionless, auto-sweep,
single-invalidation, manual fallback. This was already CoW-shaped (OIF escrow modeled on
the same principles). No change needed.

---

## STEP 8 — Cancellation

| | CoW | Us |
|---|---|---|
| Cancel an order before fill | Off-chain free cancel, or on-chain `invalidateOrder` | We have NO explicit user cancel — order lives until filled or expires |

**Verdict: 🔴 GAP vs CoW.** CoW lets a user cancel a pending order (gasless off-chain, or
on-chain invalidate). We don't expose cancellation. For us, "cancel" = let it expire +
refund. 🟡 acceptable because our orders are short-lived and lock-first (the user already
committed funds), but a pre-fill cancel (refund early) would match CoW. Low priority.

---

## STEP 9 — Status tracking / monitoring

| | CoW | Us |
|---|---|---|
| User tracking | Orderbook API + explorer; order states | `/orders/:id` polling + UI tracking view |
| Solver monitoring | Auction/competition logs | watch-loop health report + order store |

**Verdict: ✅ MATCH (shape).** Both expose order status to the user and have
solver-side monitoring. Ours is single-solver so simpler.

---

## SCORECARD

| Step | Verdict | Action |
|---|---|---|
| 1 Quote | 🟡 match (single-solver) | none |
| 2 Sign | ✅ match (Permit2 EIP-712) | (opt) add EIP-1271 for SC wallets |
| 3 No-pre-lock | 🔴 diverge (= CoW cross-chain though) | keep lock-first; documented |
| 4 Double-spend | ✅ WBTC / 🟡 cBTC | **use deterministic commandId (ledger dedup) — TOP FIX** |
| 5 Delivery | 🟡 Canton necessity | bring accept in-app |
| 6 Finalise | 🟡 Canton necessity (= Across optimistic) | note single-party oracle |
| 7 Refund | ✅ match | none |
| 8 Cancel | 🔴 gap | (low) add pre-fill cancel/refund |
| 9 Tracking | ✅ match | none |

**Bottom line:** the architecture is CoW-shaped at every step. Genuine divergences are
either (a) FORCED by Canton (3,5,6 — and even those mirror CoW's *cross-chain* Across
path, not a worse design) or (b) minor gaps (8 cancel; 2 SC-wallet signing).

---

## RESOLUTION (2026-06-06) — fixes applied

**Step 4 (double-spend) — FIXED, ledger-aligned.** The cBTC delivery now uses a
DETERMINISTIC commandId (`deliver-<orderId>`) so Canton dedupes a repeat delivery of
the same order at the LEDGER level (SUBMISSION_ALREADY_IN_FLIGHT) — the chain-enforced
guard, like CoW's filledAmount / UniswapX's Permit2 nonce. STRONGER still: the transfer
exercises a CONSUMING choice that archives the input holdings, so any duplicate reaching
the ledger is rejected with CONTRACT_NOT_ACTIVE (Canton-guaranteed, no config). The
app-layer `claimStatus` CAS remains as defense-in-depth. NOTE: an explicit
`deduplicationPeriod` was deliberately NOT added — its exact JSON-Ledger-API-v2 shape
isn't verified, and (commandId + consuming-choice) already give at-most-once; shipping
an unverified field could break every delivery. Verified: 59/59 tests pass.

**Step 8 (cancel) — best-available, escrow-limited.** Audited the OIF escrow: it has
ONLY timeout-`refund` ("anyone may call refund after order.expires"), NO immediate
owner-cancel / invalidateOrder. That's an audited-contract limit, not our choice. The
CoW-aligned mitigation is already in place: (a) the refund is permissionless and pays
order.user; (b) the swap UI ALREADY exposes a "Refund my WBTC" button once expired; (c)
tight `expires` (configurable) makes cancel-via-refund available quickly. Immediate
pre-expiry cancel would require forking the audited escrow — rejected.

**Step 2 (EIP-1271) — deferred, not needed.** Loop wallets sign as EOAs; EIP-1271 is for
smart-contract wallets. No SC-wallet users today. Documented; revisit if needed.

**The architecture is now CoW-aligned at every step that is not a hard Canton constraint,
with every safety guarantee pushed onto the chain/ledger wherever possible — no
app-code-only guard for anything that can be chain-enforced.**

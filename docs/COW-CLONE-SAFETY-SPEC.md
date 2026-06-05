# CoW Clone — Fund-Safety Spec (audited from CoW's real source)

> Mandate: build our WBTC→CBTC swap **as close to CoW Protocol as possible**, so
> there is **no room for fund-loss bugs**. This doc distills CoW's fund-safety
> model **from the actual contract source** (`cowprotocol/contracts`,
> `src/contracts/*`), and states the invariants our solver MUST preserve.
>
> Read alongside `docs/COWSTYLE-NO-PRELOCK-PLAN.md` (the build plan). This doc is
> the *why it's safe*; that doc is the *what to change*.

Audited files (commit `main`): `GPv2Settlement.sol`, `GPv2Order.sol`,
`GPv2Signing.sol`, `GPv2Transfer.sol`, `GPv2Trade.sol`.

---

## 1. CoW's exact `settle()` ordering (the model to copy)

From `GPv2Settlement.sol::settle()` — one atomic EVM tx, `nonReentrant onlySolver`:

```solidity
function settle(...) external nonReentrant onlySolver {
    executeInteractions(interactions[0]);          // 1. pre: solver sources buy-token
    (inTransfers, outTransfers) = computeTradeExecutions(...);  // validates every order
    vaultRelayer.transferFromAccounts(inTransfers); // 2. PULL sell token from users
    executeInteractions(interactions[1]);          // 3. intra
    vault.transferToAccounts(outTransfers);         // 4. DELIVER buy token to users
    executeInteractions(interactions[2]);          // 5. post
    emit Settlement(msg.sender);
}
```

**Critical takeaway #1: CoW pulls the INPUT (step 2) BEFORE delivering the OUTPUT
(step 4).** Even in the "no pre-lock" model, the sell token is secured *first*,
the buy token is delivered *second* — they are just nanoseconds apart in one
atomic tx, so they can't desync.

**Critical takeaway #2: it's atomic.** If the output delivery (step 4) would fail,
the whole tx reverts and the input pull (step 2) is undone. The solver is *never*
out the output without having secured the input.

### What this means for us (cross-chain, can't be atomic)

We physically cannot put the WBTC pull and the CBTC delivery in one transaction —
they're on different ledgers. So we **cannot** get CoW's atomic guarantee. The
**only** safe way to approximate it is to **invert the leg order from CoW** and
make the gap as close to zero as possible:

- CoW (atomic): pull input → deliver output, same tx.
- Us (non-atomic): we must **deliver CBTC first, then pull WBTC** — because if we
  pulled WBTC first we'd be back to pre-locking. So our risk window is "CBTC
  delivered, WBTC not yet pulled." **Everything below exists to make that window
  safe and tiny.**

---

## 2. CoW's fund-safety invariants — and our equivalents

Each row is a safety property CoW enforces in-contract. We must enforce the
equivalent in our solver (we have no settlement contract on the Canton side).

| # | CoW invariant (source) | Mechanism | Our equivalent (MUST implement) |
|---|---|---|---|
| I1 | **Only authenticated solvers settle** | `onlySolver` modifier (`GPv2Settlement` L87) | Our solver key is the only submitter of `openFor`/finalise — already true. Keep it the sole authority; never expose to user input. |
| I2 | **No replay / no double-fill** | `orderUid = digest‖owner‖validTo`; `require(filledAmount[uid]==0)` (L217) | Track a per-order "consumed" set keyed by the **same orderId** the escrow uses. Refuse to deliver/pull twice for one orderId. Persist it crash-safely (our `store`). |
| I3 | **Order must not be expired** | `require(order.validTo >= block.timestamp, "order expired")` (computeTradeExecution) | Refuse to deliver CBTC or submit `openFor` if `now > order.fillDeadline`. Check at BOTH steps (deliver AND pull). |
| I4 | **Signature authorizes exactly this order** | EIP-712 digest over the full order + `domainSeparator(chainId, contract)` (`GPv2Signing`) | We already sign the OIF `StandardOrder` via Permit2/EIP-712 with chainId in the domain. Verify the signature server-side before acting; never trust client-passed fields. |
| I5 | **Cross-chain replay impossible** | `domainSeparator` binds `chainId` + `verifyingContract` (L50-53) | Our order's chainId is the mainnet-offset Canton chainId + the escrow address. A signature for one network can't satisfy another — already designed in (`config.ts` CANTON_CHAIN_OFFSET). Keep it. |
| I6 | **Reentrancy can't double-spend** | `nonReentrant` (L126) | Our legs are sequential in a single-process loop, not reentrant. Keep the loop single-process; guard the store against concurrent writers (the API + loop already share via reload). |
| I7 | **Input pull is allowance-based, exact-amount** | `safeTransferFrom` via VaultRelayer (`GPv2Transfer` L57) | `openFor` pulls via the user's Permit2 signature for the exact input amount. Never pull more than `order.inputs[0][1]`. |
| I8 | **Validate BEFORE moving funds** | All `require`s run in `computeTradeExecutions` *before* any transfer | **Our claimability pre-flight is the analogue of I8** — see §3. This is the single most important safety step, because we lack the atomic revert. |

---

## 3. The claimability pre-flight = our substitute for atomicity (MUST be airtight)

CoW gets safety from atomic revert (I8): it validates every order, and if anything
is wrong the whole tx reverts before funds move. **We have no revert across
chains.** So before we deliver CBTC (the irreversible step that exposes the
treasury), we must prove the WBTC pull *will* succeed. This is the crux.

**Pre-flight, run immediately before delivering CBTC — deliver ONLY if ALL pass:**

1. **Not expired**: `now < order.fillDeadline` (I3), with margin for the time the
   pull takes.
2. **User still holds the WBTC**: on-chain `balanceOf(user) >= order.inputs[0][1]`
   at the current block.
3. **Pull is authorized & live**: Permit2 allowance/signature for the escrow is
   present and its own deadline `>= fillDeadline` (I4/I7).
4. **Not already consumed**: orderId not in the consumed set (I2).
5. **Optional, strongest**: simulate `openFor` via `eth_call` (staticcall) at the
   current block — if the simulation reverts, do NOT deliver. This is the closest
   we get to CoW's "validate then move."

Then: deliver CBTC → **immediately** submit `openFor` (pull WBTC) → finalise.
Minimise wall-clock between deliver and pull (no extra polling in between).

**Residual risk (cannot be fully eliminated, same as every solver-fronting model):**
between the pre-flight `eth_call` and the actual `openFor` mining, the user could
move the WBTC or the chain could reorg. Bound it by:
- Keeping `fillDeadline` tight (minutes).
- Capping per-order and total in-flight exposure (treasury limit).
- Treating any failed `openFor`-after-delivery as a **logged treasury loss event**
  for reconciliation, never a silent failure.

---

## 4. Signature replay — the specific footgun, handled CoW's way

CoW binds each signature to: the order digest, the owner, `validTo`, the chainId,
and the verifying contract — and records `filledAmount[uid]` so a signature can't
be reused. **Replicate all of it:**

- The Permit2 witness already binds the order + a deadline + chainId. **Set the
  Permit2 deadline = `fillDeadline`** so a held signature self-expires.
- Persist a **consumed-orderId set** (I2) and check it before *both* deliver and
  pull. A signature whose orderId is consumed is dead.
- Never widen the window: the API stores the signed intent, but the solver acts on
  it only within `fillDeadline`. Past that → expire, don't pull.

---

## 5. Things CoW does that we must NOT naively copy (cross-chain divergences)

- **CoW's atomic single-tx settlement** — impossible for us; do NOT pretend the
  two legs are atomic. Design every state as crash-recoverable mid-flight.
- **Partial fills (`partiallyFillable`)** — CoW supports them; **we should NOT**
  for v1. Force full-fill only (simpler, fewer fund-accounting edge cases).
- **Batch auctions / multiple solvers** — CoW has many competing solvers; we are
  single-solver. Keep it that way (our `onlySolver` analogue is one key).
- **Internal Vault balances** — CoW's Balancer-vault internal-balance path is a
  gas optimization irrelevant to us; ignore.

---

## 6. Implementation checklist (maps to COWSTYLE-NO-PRELOCK-PLAN.md)

Every item below is a fund-safety requirement, not a nice-to-have:

- [ ] `POST /orders` stores the signed intent only — no `openFor` yet (no pre-lock).
- [ ] **Consumed-orderId set** persisted in `store` (I2) — checked before deliver AND pull.
- [ ] **Expiry check** (`now < fillDeadline`) at deliver AND pull (I3).
- [ ] **Server-side signature verification** of the full order before any action (I4).
- [ ] **Claimability pre-flight** before delivering CBTC, incl. the `eth_call`
      simulation of `openFor` (§3) — the airtight gate.
- [ ] Deliver CBTC → **immediately** `openFor` (pull WBTC) → finalise; minimal gap.
- [ ] Permit2 deadline == `fillDeadline` (§4).
- [ ] Per-order + total in-flight **exposure caps** (§3).
- [ ] Failed-pull-after-delivery → **logged treasury-loss event** + alert, never silent.
- [ ] Full-fill only; no partial fills (§5).
- [ ] Single-process solver loop; store guarded against concurrent writers (I6).

---

## 7. Sources (primary, read directly)

- `cowprotocol/contracts` — `GPv2Settlement.sol`, `GPv2Order.sol`,
  `GPv2Signing.sol`, `GPv2Transfer.sol`, `GPv2Trade.sol` (settle ordering,
  orderUid/filledAmount replay protection, validTo expiry, EIP-712 signing).
- docs.cow.fi — core contracts overview (VaultRelayer, signature schemes,
  signature-replay warning).
- OIF `oif-contracts` — `InputSettlerEscrow` / `openFor` (our existing input leg).

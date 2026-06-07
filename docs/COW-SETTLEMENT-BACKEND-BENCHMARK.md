# CoW settlement backend benchmark — contracts + services

Benchmarks our **solver** (order intake → settle → refund) against CoW's actual
backend code: the `GPv2Settlement` contracts (`cow-contracts`) and the Rust
services (`cow-services`: `order-validation`/`orderbook`, `autopilot`, `driver`,
`refunder`). Read at the source level, cited per row.

## The structural contrast (why this can't be 1:1)

CoW is a **single-chain, multi-solver, pull-then-verify-outcome atomic
settlement**: `settle()` pulls every sell token, runs arbitrary solver
interactions, pays every buy token, all in **one atomic tx** that reverts as a
whole; a competitive auction of N solvers picks a fair winner each block.

Ours is a **cross-chain, single custodial solver**: there is no single atomic tx
across Arbitrum + Canton, and no competition. So the CoW guarantees we mirror are
the *invariants* (no-double-settle, only-authorized-settler, funds-recoverable),
not the auction or the single-tx atomicity.

## On-chain settlement (GPv2Settlement.sol → our OIF escrow)

| CoW guard | CoW mechanism (file:line) | Our analogue | Verdict |
|---|---|---|---|
| Double-settle / single-fill | `filledAmount[orderUid]` monotonic accumulator; `require(filledAmount==0)` fill-or-kill, `require(<= amount)` partial (`GPv2Settlement.sol:217,393,421`) | OIF escrow `orderStatus[orderId]` (None→Deposited→Claimed/Refunded); finalise reverts unless Deposited | ✅ equivalent: an order settles at most once, chain-enforced |
| Only authorized settler | `onlySolver` → `authenticator.isSolver(msg.sender)` (`GPv2Settlement.sol:85-90`) | escrow `finalise` requires the agent's attestation on our oracle; only the agent attests | ✅ equivalent |
| Reentrancy | `nonReentrant` around arbitrary interactions (`ReentrancyGuard.sol:54`) | escrow is OIF-audited; no arbitrary interactions in finalise | ✅ N/A (no untrusted callouts) |
| Tamper-proof order id | UID = `digest ++ owner ++ validTo`, digest = on-chain EIP-712 hash of full order (`GPv2Order.sol:178`) | `orderId = orderIdentifier(order)` (escrow hashes the full StandardOrder); recipient = keccak(cantonParty) | ✅ id bound to full terms |
| Signature schemes | EIP712/EthSign/EIP1271/PreSign verified on-chain (`GPv2Signing.sol:151`) | escrow `openFor` verifies the Permit2 (EIP-712) signature on-chain; reverts on bad sig | ✅ (we support EIP-712; SC-wallet schemes deferred) |
| User cancel | `invalidateOrder` sets `filledAmount = uint256.max`, owner-only (`GPv2Settlement.sol:250`) | OIF escrow has only timeout `refund()` (permissionless → user) | 🟡 audited-contract limit; "cancel" = expire + refund |

## Order intake / validation (order-validation → our /orders)

| CoW check | CoW (file) | Our /orders | Verdict |
|---|---|---|---|
| Validation runs BEFORE accept | `validate_and_construct_order` (`shared/src/order_validation.rs:739`) | we validate before the irreversible `openFor` | ✅ same ordering principle |
| Signature → owner | `verify_owner` ec-recover (`model/src/order.rs:397`) | escrow `openFor` ec-checks the Permit2 sig on-chain (reverts on bad sig) | ✅ on-chain instead of off-chain pre-check |
| Recipient binding | n/a (single chain) | `verifyCantonParty(party, recipient)` — preimage must hash to the committed recipient | ✅ (our cross-chain-specific guard) |
| **validTo window** | `validate_period`: too-soon→Insufficient, too-far→Excessive; min 60s / max 3h (`order_validation.rs:1032`, `configs/.../order_validation.rs`) | **added** `minFillDeadlineMargin` / `maxOrderValiditySeconds` + `fillDeadline < expires` check in `api.ts` | ✅ **adopted this session** — was missing; a stale/absurd order could lock WBTC then fail |
| Zero amount | fast reject (`order_validation.rs:764`) | `wbtcAmount > 0` at /quote; per-order cap | ✅ |
| Duplicate / replay | DB unique on uid → 23505 → DuplicatedOrder (`database/orders.rs`) | `store.get(orderId)` idempotency + deterministic Canton commandId (ledger dedup) | ✅ equivalent |
| Balance / allowance | simulated `can_transfer` at post (`account-balances`) | the escrow `openFor` itself pulls via Permit2 — it reverts if balance/allowance insufficient | ✅ chain-enforced at lock |
| Status lifecycle | computed-on-read: Fulfilled>Cancelled>Expired>PresignPending>Open (`database/orders.rs:536`) | store status seen→delivering→delivered→attested→finalised; refunded/failed | ✅ comparable state set |

## Settlement loop / retry / finality (autopilot+driver → our watch loop)

| CoW behavior | CoW (file) | Ours | Verdict |
|---|---|---|---|
| Retry model | **re-solve**, not re-submit: one bounded settlement attempt per auction; on revert the order re-enters the next auction (`run_loop.rs:744`); intra-attempt only gas-bump/cancel (`mempools.rs:234`) | our settle is **deterministic** (attest a fixed fill, finalise a fixed order); on failure it returns `skipped` and retries next tick, re-reading on-chain `orderStatus` first | ✅ equivalent — single-solver has no plan to re-solve; we reconcile with chain truth before re-trying |
| Idempotent settle | driver `swap_remove_front` before submit; observer rejects settlement not matching a winning solution (`settlement/mod.rs:183`) | `settle.ts`: skips attest if `isProven`, skips finalise if `orderStatus==Claimed` | ✅ equivalent (chain-state-driven idempotency) |
| Deadlines | solve deadline + submission deadline (blocks) + refund deadline; nothing sits forever (`run_loop.rs`, `mempools.rs:249`) | per-order `fillDeadline` (deliver-by) + `expires` (refund window); delivery guard skips if margin too low | ✅ comparable |
| **Finality = reorg-aware** | event-indexing with `replace_events` (delete-from-block + re-insert) on reorg (`event-indexing/src/event_handler.rs`, `boundary/events/settlement.rs:68`) | our watcher only inserts (idempotent skip); cursor advances monotonically — **NOT reorg-aware** | 🟡 **gap, self-healing**: a reorg'd-away `Open` leaves a `seen` order, but its WBTC isn't actually locked (escrow status ≠ Deposited) → pre-flight/finalise fails → it expires + refund is a no-op. Documented; a `replace_events`-style rollback would be cleaner. |
| **Refunder** | stateless/idempotent: re-derive eligibility from on-chain `RefundStatus` every 30s; never tracks local "pending refund" (`refunder/src/refund_service.rs:183`) | `refundOrder` re-reads on-chain `orderStatus` each tick (reconciles Claimed/Refunded before acting); permissionless refund → user; sweep every loop | ✅ **already matches CoW's exact pattern** — drives off authoritative on-chain state, idempotent across restarts |

## Net

The settlement **invariants** match CoW's chain-enforced ones: at-most-once
settle (escrow orderStatus = CoW's filledAmount), only-authorized-settler
(attestation = CoW's onlySolver), deterministic-idempotent retry that reconciles
with chain truth (= CoW's re-solve), and a **stateless on-chain-driven refunder**
that is essentially identical to CoW's refunder. This session closed the one real
intake gap (validTo-window validation before the irreversible lock).

Remaining 🟡: (a) no pre-expiry cancel — an OIF audited-escrow limit, mitigated
by permissionless refund; (b) the watcher isn't reorg-rollback-aware like CoW's
`replace_events` — but the mismatch self-heals because a reorg'd lock simply
isn't claimable. Both are documented, neither risks user funds (every failure
path refunds to the user).

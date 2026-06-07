# CoW frontend benchmark — code-level, end to end

Benchmarks our WBTC→cBTC swap against CoW Swap's **actual frontend code** (the
monorepo at `desktop/cantonops/cowswap`, `apps/cowswap-frontend` + `libs/`), not
docs or memory. Every row cites the real CoW source file. Where we differ, it's
either adopted (✅ now matches) or a forced Canton difference (🟡).

## The architecture-defining difference (why some legs can't match 1:1)

In CoW, the user signs an **off-chain order**; nothing leaves the wallet until a
solver pulls it **inside the atomic `settle()`** at fill time. So submitting an
order is free and reversible — which is why CoW records the order locally *after*
a successful sign+POST with no write-ahead, and never has a "funds locked but no
record" window.

Our swap is cross-chain: the WBTC is **locked on Arbitrum at submit** (`openFor`),
because there is no settle-time pull on Canton. That single fact is what made our
earlier bug possible (lock succeeded, store-write lost). CoW's *own cross-chain*
path has the analogous shape (source-leg commit, then async bridge) — so we
benchmark against CoW **cross-chain**, and add a write-ahead because our commit
is irreversible where CoW's order-post is not.

## Quote → submit

| Step | CoW (file) | Us | Verdict |
|---|---|---|---|
| Quote shape | `QuoteResults`/`QuoteAndPost` (`sdk-trading`); `TradeQuoteState` (`modules/tradeQuote/state/tradeQuoteAtom.ts`) | `QuoteResponse` (`lib/swap-api.ts`) — order + permit2 typed data | ✅ same shape (signable order + the data to sign) |
| Quote polling | `useTradeQuotePolling.ts` — 30s poll + 2s expiry revalidation | we quote on Review click; no live re-quote | 🟡 single-solver 1:1 peg — no price competition to poll |
| Confirm handler | `ConfirmButton.tsx` — `confirmInFlightRef` reentrancy guard; `swapFlow/index.ts` step pipeline | `handleConfirm` in `app/swap/page.tsx` | ✅ same pipeline (approve → sign → submit), guarded by stage machine |
| Approval | separate prior step (`useApproveAndSwap.tsx`), permit-first then on-chain approve | Permit2 allowance check then `approve`, then sign | ✅ aligned (allowance-gated, infinite approve) |
| Sign scheme | `SigningScheme.EIP712` for EOA (`swapFlow/index.ts:175`) | EIP-712 Permit2 witness | ✅ same |
| Record order | **after** successful sign+POST, keyed by server `orderId` (`addPendingOrderStep`) | **write-ahead**: record order + cantonParty *before* `openFor` | 🟡 forced — our commit is irreversible, CoW's POST is not (see above) |
| Error sink | single try/catch → `getSwapErrorMessage` → `onError` (`swapFlow/index.ts:283`) | per-step `retry()` → `getSwapErrorMessage` | ✅ adopted CoW's mapper |

## Order state machine + progress

| Element | CoW (file) | Us | Verdict |
|---|---|---|---|
| Progress states | `OrderProgressBarStepName` enum — INITIAL/SOLVING/EXECUTING/FINISHED/DELAYED/EXPIRED/REFUND_COMPLETED/BRIDGING_* (`modules/orderProgressBar/constants.ts`) | `SwapProgressState` — initial/delivering/finished/delayed/expired/refunded/failed (`lib/swap-api.ts`) | ✅ adopted (collapsed to our legs) |
| State derivation | `getProgressBarStepName(...)` (`useOrderProgressBarProps.ts`) | `deriveProgress(order, now)` (`lib/swap-api.ts`) | ✅ same idea: derive UI state from order + clock |
| **Grace buffer** | `PENDING_ORDERS_BUFFER = 60s` before declaring expired, "to take into account race conditions where a solver might execute after the backend changed status" (`libs/common-const/src/common.ts`, `legacy/state/orders/utils.ts` `isOrderExpired`) | `PENDING_BUFFER_SECONDS = 60` in `deriveProgress` + the refund gate | ✅ **adopted — this fixes our premature-expiry/ghost bug** |
| **DELAYED state** | slow order (past a short countdown) shows "Still searching… network issue delaying your order" instead of a frozen spinner (`SolvingStep.tsx`) | `DELAYED_AFTER_SECONDS = 45` → "taking a little longer than usual — your funds are safe" | ✅ adopted (no frozen "Swapping…") |
| Steps shown | small fixed step set, generic copy; never exposes internal mechanics | 3 steps (`SWAP_STEPS`); generic copy, no lock/attest jargon | ✅ aligned |
| Polling cadence | 2s market / 15s limit (`consts.ts`) | 4s tracking poll | ✅ comparable |
| Persistence | localStorage via `redux-localstorage-simple`, keyed `[chainId][bucket][orderUid]`, pruned top-10/status on mount (`legacy/state/index.ts`, reducer `clearOrdersStorage`) | single active order in `localStorage` + give-up-after-404 | 🟡 we track one order at a time; pruning N/A, but we now forget terminal orders |
| 404 / gone | classifier never resurrects a locally-cancelled order; expiry only past buffer | tracking gives up after sustained 404 (≥4), forgets the order, shows clean message | ✅ no infinite spinner |

## Failure / cancel / refund

| Path | CoW (file) | Us | Verdict |
|---|---|---|---|
| Three terminal states | EXPIRED (validTo) / CANCELLED (user-invalidated) / FAILED (placement tx failed) — distinct reducer actions + colors (`reducer.ts`, `getOrderStatusTitleAndColor.ts`) | expired / refunded / failed — distinct progress states + copy | ✅ aligned |
| User cancel | off-chain signed cancellation or on-chain `invalidateOrder`; `isCancelling` intermediate (`useCancelOrder`, `trade.ts`) | no pre-expiry cancel — the OIF escrow only has timeout `refund()` | 🟡 audited-contract limit; "cancel" = let it expire + refund (permissionless, → user) |
| Refund (cross-chain) | `BridgeStatus.REFUND → REFUND_COMPLETED`; "Refunded to <chain> <addr>"; manual "Recover funds from Account Proxy" (`useSwapAndBridgeContext.ts`, `RefundedBridgingContent`, `useRecoverFundsCallback`) | escrow `refund()` permissionless → always `order.user`; auto-refund sweep + manual "Refund my WBTC" | ✅ equivalent: funds always recoverable to the user on failure |
| Error mapping | 3-way: user-rejected (4001 + msg allowlist) / API error / RPC (`getSwapErrorMessage.ts`, `misc.ts isRejectRequestProviderError`) | `getSwapErrorMessage` + `isUserRejection` — same 3-way (`lib/swap-api.ts`) | ✅ adopted, same allow-list, same -32000 exclusion rationale |
| Reentrancy guard | `confirmInFlightRef` / `flowInProgressRef` (`ConfirmButton.tsx`, `useHandleSwap.ts`) | stage machine (`quoting`/`approving`/`signing`/`submitting`) blocks re-entry | ✅ equivalent |

## Solver-side (no CoW analogue — single custodial solver)

CoW's solvers are a competitive off-chain network; ours is one custodial solver.
The settlement guarantees we *can* mirror (chain-enforced no-double-spend, refund
permissionless to user, accept-first/pay-second) are covered in
`COW-ARCHITECTURE-BENCHMARK.md`. The frontend-facing behavior is what this doc
benchmarks.

## Net

Every frontend step now follows CoW's actual code: same confirm pipeline, same
3-way error mapping, the **60s grace buffer**, a **DELAYED state** (no frozen
spinner), derived progress states, generic non-jargon copy, and
funds-always-recoverable-on-failure. The remaining 🟡 rows are forced by Canton
(irreversible commit → write-ahead) or by the audited OIF escrow (no pre-expiry
cancel) — and even those mirror CoW's *cross-chain* shape, not a worse design.

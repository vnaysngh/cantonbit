# Best-Achievable-Trustless Swap — Design Spec (all 3 fixes)

Status: PROPOSAL for review. No code yet. Branch: `feat/trustless-bonded-swap`.

## Why this exists

Mainnet probe (`probe-hashlock-support.mts`) PROVED cBTC/CC/USDC on Canton expose
only TIME locks, no hashlock, and the registry has no preimage choice. So a 1inch
HTLC (cryptographic atomicity) is impossible for this asset pair. The ceiling is
**economic** trustlessness: the solver can technically trigger the WBTC release,
but lying about delivery must cost it more than it gains.

Today's gap (audited from live code): `OranjAttestorOracle.attest()` lets the
solver's hot key mark ANY fill proven and pull a user's WBTC **with no cBTC
delivered and no penalty**. The user is safe (worst case = refund); the solver is
restrained by nothing but honesty. We close that.

## The 3 fixes, as ONE coherent change to the release path

All three touch the same line: *what must be true on-chain before WBTC releases.*

### Fix #1 — Bond + delivery proof (the load-bearing one)

Replace `OranjAttestorOracle` (self-attest, no stake) with **`BondedDeliveryOracle`**:

- Solver posts a **bond** (collateral) held by the contract: `depositBond()` /
  `withdrawBond()` (withdraw blocked while orders in-flight).
- `finalise()` may release WBTC ONLY when a **delivery proof** is present. The
  proof is a **user-signed receipt**: an EIP-712 message signed by the user's EVM
  key — `DeliveryReceipt{ orderId, cbtcAmount, cantonRecipient, fillTimestamp }` —
  confirming the cBTC arrived. No receipt → no release. (The user already signs
  the order; signing a receipt after auto-accept is one more cheap signature, and
  with auto-accept ON it can be produced by the app automatically — see #2.)
- **Slashing / dispute**: if the solver finalises on a forged receipt, or fails to
  deliver after locking, the bond is slashable. Because the receipt is user-signed,
  forging it is infeasible without the user's key; the bond's role is to cover the
  one residual case (solver locks, never delivers, user can't get cBTC) — there the
  user (or anyone) calls `claimBondForUndelivered(orderId)` after the deadline and
  is paid from the bond.

> **Alternative considered (optimistic + watchtower):** finalise opens a challenge
> window; a watchtower posts a Canton non-delivery proof to slash. REJECTED as
> default: needs Canton-proof-on-EVM verification (hard) + longer capital lockup.
> User-signed receipt is simpler, needs no window, and fits the existing flow where
> the user is already present. Keep optimistic as a v2 option if receipts prove
> operationally heavy.

### Fix #2 — No accept after deadline (offer auto-expires)

Root cause of the "MANUAL REVIEW" stranding: a user could accept cBTC AFTER
`fillDeadline`, making the WBTC proof permanently invalid (escrow requires
`fillTimestamp <= fillDeadline`) → solver can't claim, can't refund (user has cBTC).

This is now PREVENTABLE, not a loss to write off, using two facts confirmed today:

1. The cBTC offer already carries **`executeBefore`** (a hard Canton deadline; the
   registry will not execute the transfer after it). Code already sets it to
   `now + TRANSFER_TTL_MS` — we **bind it to the order**: `executeBefore =
   min(now + TTL, fillDeadline − margin)`. After that instant the user **cannot**
   accept; the offer is dead and the float returns to the solver.
2. **Auto-accept is mandatory** (enforced pre-quote — see #3). With auto-accept ON,
   the wallet accepts the offer the moment it lands — well inside `executeBefore` —
   so the late-accept path effectively never triggers.

Result: the `delivered`-past-`fillDeadline` and `accepted-too-late` branches in
`accept-watch.ts` become **unreachable**; we keep them only as a hard assertion
("must not happen") instead of a manual-review queue. No stranding.

### Fix #3 — Bind `destination` into the proof + enforce auto-accept gate

- **Destination binding:** today `finalise(order, solveParams, destination, …)`
  takes `destination` as a free param NOT covered by the attested hash — a
  compromised key could reroute WBTC. Fix: include `destination` in the
  user-signed `DeliveryReceipt` (and in the escrow's proof check), so WBTC can only
  go where the user signed off. One hashed field, closes the reroute.
- **Auto-accept gate (precondition for #2):** the quote endpoint REQUIRES the user
  to have auto-accept enabled before issuing a quote. Add a pre-quote check
  (`POST /quote` returns 412 + "enable auto-accept" if not detected/attested). This
  is what makes `executeBefore` binding safe — we know the wallet will accept
  promptly, so a tight deadline won't strand honest users.

## Resulting trust model (the honest statement to publish)

| Party | Can steal? | Bounded by |
|---|---|---|
| User | No (always was) | permissionless refund at `expires` |
| Solver | **No** | WBTC releases only on a **user-signed receipt** for the exact destination; locking-without-delivery is covered by the **bond** |

Residual (irreducible for this asset pair): **liveness** — someone must produce the
receipt / run refund before deadlines. Not custody, not honesty. This is the
ceiling the probe proved; we are now at it.

## Build order (each independently testable)

1. **#3 destination + auto-accept gate** — smallest; receipt struct + escrow proof
   field + `/quote` precondition. Foundry test: finalise reverts if destination not
   in signed receipt.
2. **#2 executeBefore binding** — `createOffer` sets `executeBefore =
   min(now+TTL, fillDeadline−margin)`; assert late-accept unreachable. Tests in
   `accept-watch.test.ts` flip from "manual review" to "cannot occur".
3. **#1 BondedDeliveryOracle** — new Solidity (deposit/withdraw/finalise-with-receipt
   /claimBondForUndelivered) + Foundry tests (no release without receipt; forged
   receipt reverts; undelivered → bond pays user). Solver `settle.ts` swaps
   `attest()` for "attach receipt"; `delivery.ts` unchanged; `OranjAttestorOracle`
   deleted.

## Open questions before coding

- **Who signs the receipt** — user's EVM key (they already have one for the order)
  vs. user's Canton key. EVM key is simpler (escrow verifies EIP-712 natively).
  Proposed: EVM key. Confirm.
- **Bond sizing** — fixed amount, or ≥ max in-flight WBTC? Proposed: ≥
  `maxInflightSats` value so a total default is fully covered. Confirm.
- **Auto-accept detection** — can the app verify auto-accept is ON via Loop SDK, or
  only instruct the user? Affects whether the `/quote` gate is enforced or advisory.

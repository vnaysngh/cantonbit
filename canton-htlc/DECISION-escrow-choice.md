# Decision (T6): EVM escrow = the new HTLCEscrow. OIF escrow retired for swaps.

Date: 2026-06. Status: DECIDED.

## The choice
The EVM leg of the trustless atomic swap uses our **new `HTLCEscrow.sol`**
(hashlock + timelock, aligned to Cancore's production HTLC). We do **NOT** reuse
or retrofit the old OpenIntents `InputSettlerEscrow`.

## Why (plain)
- The new `HTLCEscrow` releases funds ONLY on the secret reveal → trustless.
  This is the whole point of the migration.
- The old OIF `InputSettlerEscrow` is shaped for the trusted-ORACLE model
  (releases when the solver's oracle attests). Bending it into a hashlock is
  awkward, risky, and against its design.
- "But OIF is already audited" — that advantage VANISHES the moment you modify
  audited code (the audit no longer covers your changes). So you'd need a fresh
  audit either way → no security saving from the retrofit.
- **Cancore (the live production system we reverse-engineered) uses a brand-new
  custom HTLC, NOT a fork/retrofit of OpenIntents.** Strong precedent.

## Consequence
- The new `HTLCEscrow.sol` MUST go through an external audit before mainnet — that
  is task **T15** (non-negotiable for custom fund-custody code).
- OIF `InputSettlerEscrow` + Permit2 stay ONLY as part of the OLD trusted-oracle
  solver, which keeps running until the new path is live.

## What is NOT deleted yet (and why)
`OranjAttestorOracle.sol` and the OIF escrow integration are still referenced by
~12 live solver files (watcher.ts, settle.ts, order.ts, deploy.ts, abi.ts, …).
Deleting them now would break the working solver before the HTLC path exists.
**They are removed in task T10** ("settle.ts: EVM claim(s); DELETE the oracle"),
as the final step of the solver rewire — build the new path first, then delete
the old. Do not delete earlier.

## One thing to keep from the OIF world
**Permit2** (the user's gasless signed approval) is worth keeping for the user-
locks-EVM legs (UC7/UC8 EVM→Canton) so the user signs once instead of doing a
separate approve+lock. Evaluate wiring Permit2 into `HTLCEscrow.lock` during T7.
This is independent of retiring the OIF settler/oracle.

# On-Node Spike — the last unknown before building the full swap

## Status going in
- ✅ EVM HTLC (`contracts/src/HTLCEscrow.sol`) — 8/8 Foundry tests.
- ✅ Canton HTLC (`canton-htlc/daml/CbtcHtlc.daml`) — compiles against the REAL
  Splice token-standard DARs + 5/5 Daml Script tests pass in the sandbox.
- ✅ Design validated against Cancore (live mainnet HTLC EVM↔Canton product).

## The ONE thing the sandbox could not prove (this spike proves it)
The sandbox `MockAllocation` is a plain template, not the cBTC registry's
coordinating contract. So it cannot replicate the registry's **pre-delegation**:
in production, when the sender creates the Allocation via the registry, the
registry grants sender+receiver consent to the `executor` up front, so the
executor can fire `Allocation_ExecuteTransfer` ALONE.

The canonical source confirms this is the intended pattern
(`Splice.Api.Token.AllocationV1`):
> "Typically this authorization is granted by sender and receiver to the executor
>  as part of the contract coordinating the settlement, so that the executor can
>  release the allocated assets early..."

**Spike goal: confirm that on the WarpX node, a real registry-created Allocation
lets our `executor` party fire `ExecuteTransfer` alone (via `HtlcLock.Claim`),
and that a real cBTC/CC holding actually moves.**

## Prereqs
- DPM toolchain working (done): `export PATH="$HOME/.dpm/bin:/opt/homebrew/opt/openjdk@17/bin:$PATH"`
- The `cbtc-htlc-0.1.0.dar` built (done): `dpm build` in `canton-htlc/`.
- WarpX DevNet access: ledger API host, registry URL, Keycloak m2m creds
  (the same the swap-solver already uses — see `swap-solver/.env`).
- A small cBTC OR CC float on a party you control (the "locker").
- The token-standard DARs vetted on the node (they are — the registry uses them).

## Steps

### 1. Deploy the DAR to WarpX
Upload `canton-htlc/.daml/dist/cbtc-htlc-0.1.0.dar` to the WarpX participant
(via the 5N dashboard, or `dpm`/ledger-api upload). This vets the `HtlcLock`
template on the node so it can be created.

### 2. Create a REAL Allocation via the registry (the pre-delegation step)
As the locker, call the registry's `AllocationFactory_Allocate` (the same HTTP
flow `swap-solver/src/canton.ts` `allocate()` already implements — reuse it):
- `settlement.executor`   = your HTLC executor party (the solver/platform party)
- `settlement.settleBefore` = the timelock instant `unlockTime`
- `settlement.allocateBefore` = slightly before `settleBefore`
- `transferLeg.sender`    = locker, `.receiver` = the swap receiver
- `transferLeg.amount/instrumentId` = the cBTC/CC being locked
- `inputHoldingCids`      = a real holding you own

This LOCKS the holding and returns an `Allocation` contract id. **Key check:**
the resulting Allocation must have the executor in its controller set with
sender+receiver consent pre-granted (that is what the factory does).

### 3. Create the HtlcLock wrapping that Allocation
Create `HtlcLock` with `allocationCid` = the real Allocation cid from step 2,
`hashLock` = `sha256(preimage)`, `unlockTime` = the `settleBefore`.

### 4. THE DECISIVE TEST — Claim with the executor ALONE
As the `executor` party only (no co-signers), exercise `HtlcLock.Claim` with the
correct `preimage` and the registry choice-context for `Allocation_ExecuteTransfer`
(fetch it the same way `canton.ts` fetches transfer/allocation choice-contexts).

**PASS:** the choice succeeds, the locked cBTC/CC moves to the receiver, and the
preimage is visible on-ledger (read the exercised choice argument).
→ Pre-delegation works. The full trustless HTLC design is GO. Build it.

**FAIL (authorization error):** the registry did NOT pre-delegate enough; the
executor can't fire execute alone. → Fall back: have the receiver's participant
co-sign the claim (Cancore's "platform signs on your behalf" mode handles this),
or structure the claim as a two-step accept. Still HTLC-safe, slightly more UX.

### 5. Refund path (separate run)
Create another Allocation+HtlcLock, let `unlockTime` pass, exercise
`HtlcLock.Refund` as the locker alone → confirm `Allocation_Withdraw` returns the
holding to the locker. (Sandbox already proved the auth model; this confirms on
the real registry.)

### 6. Preimage encoding parity (do once)
Confirm `sha256(preimage)` on the Daml side == the EVM `HTLCEscrow` hashlock for
the SAME bytes. EVM hashes raw bytes; Daml `sha256` takes Text. Pin ONE encoding
(recommended: lowercase-hex string on both — adjust the EVM side to
`sha256(bytes(hexString))`). Reference value from the EVM test:
`H = 0xa5146db745a9b5587adf7c6bbd18b9ca4094fa4c52b2c345ed8ec8f3d0546cbb`
for preimage `0x…1234567890abcdef`. See `VERIFY.md`.

## After the spike passes
Wire `swap-solver`:
- `delivery.ts` → create Allocation (executor=solver) + HtlcLock instead of the
  optimistic TransferInstruction.
- new `reveal-watch.ts` → read the preimage from the Canton Claim, fire EVM `claim(s)`.
- `settle.ts` → drop attest/oracle; just the hashlock claim.
- `refund.ts` → EVM refund after T_src + Canton `HtlcLock.Refund` after T_dst.
- Delete `OranjAttestorOracle`.
(Full migration map: CROSSCHAIN-TRUSTLESS-RESEARCH.md §8.)

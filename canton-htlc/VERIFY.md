# Verification spike — trustless atomic wBTC ⇄ cBTC (this session)

Goal: prove the design works **before** building it. Two legs, two test artifacts.
The EVM leg is already RUN (results below). The Canton leg is ready for you to run
on the WarpX node (I can't — no Daml SDK or DAR-upload rights in this environment).

## The whole design in one sentence

One 32-byte secret `s` with `H = sha256(s)`. Locking on both chains under `H`;
revealing `s` to claim one leg makes `s` public, which claims the other. Never
reveal → both refund after staggered timelocks. The solver is **never trusted with
funds** — the trusted oracle (`OranjAttestorOracle`) is deleted.

## Leg 1 — EVM HTLC — ✅ RUN, 8/8 PASS

`contracts/src/HTLCEscrow.sol` + `contracts/test/HTLCEscrow.t.sol`

```
forge test --match-contract HTLCEscrowTest -vv
```

Results (run this session):

| Test | Proves | Result |
|---|---|---|
| test_sha256_parity_value | H = sha256(s) is a fixed value | ✅ `0xa5146db745a9b5587adf7c6bbd18b9ca4094fa4c52b2c345ed8ec8f3d0546cbb` |
| test_claim_with_correct_preimage | correct secret releases principal | ✅ |
| test_claim_wrong_preimage_reverts | wrong secret → revert (no theft) | ✅ |
| test_claim_after_timelock_reverts | can't claim once refund window opens | ✅ |
| test_refund_before_timelock_reverts | funder can't pull a claimable swap | ✅ |
| test_refund_after_timelock | refund works after timeout | ✅ |
| test_safety_deposit_paid_to_claim_sender | completion incentive | ✅ |
| test_no_double_claim | terminal state closes | ✅ |

For `s = 0x0000000000000000000000000000000000000000000000001234567890abcdef`,
**`H = 0xa5146db745a9b5587adf7c6bbd18b9ca4094fa4c52b2c345ed8ec8f3d0546cbb`**.

## Leg 2 — Canton HTLC — ⏳ YOU RUN on WarpX

`canton-htlc/daml/CbtcHtlc.daml` + `canton-htlc/daml/CbtcHtlcTest.daml`

```
cd canton-htlc
# set sdk-version in daml.yaml to the WarpX node's SDK first
daml test            # runs all Script tests in the sandbox
# then `debug` the parity value and compare to H above
```

Pass criteria:

| Check | Test | Pass = |
|---|---|---|
| P1 hashlock parity | test_hashlock_parity | Daml `sha256(preimage)` == EVM `H` (after encoding reconciliation, below) |
| P2 hashlock gate | test_htlc_lifecycle | wrong preimage fails; correct preimage claims |
| P3 timelock gate | test_htlc_lifecycle, test_timelock_refund | Claim fails after unlockTime; Unlock fails before, succeeds after |

If P1–P3 all pass → **the Canton leg is GO** and the full atomic design is proven
end to end. If P1 fails → it's almost certainly the encoding gotcha below, not a
dealbreaker — fix the encoding and re-run.

## ⚠️ The one real gotcha the spike surfaced: preimage byte-encoding

Atomicity requires **both chains hash the EXACT SAME BYTES**. The EVM test hashed
the 32 raw bytes of `s` (`sha256(abi.encodePacked(bytes32))`). The Daml script
hashes the **hex string** `"0000...1234567890abcdef"` via `DA.Crypto.Text.sha256`
(which takes `Text`). Those are different byte sequences → different digests.

Before building, pick ONE canonical encoding and use it on both sides:

- **Option A (recommended): hash the lowercase-hex string on both chains.** Change
  the EVM `lock`/`claim` to `sha256(bytes(hexString))` so it matches Daml's
  `sha256(Text)`. Cleanest, because Daml's sha256 is text-only.
- **Option B: hash raw 32 bytes on both.** Decode the hex to bytes in Daml before
  hashing. Needs a hex→bytes step in Daml.

This is a *protocol constant to fix once*, not a design flaw. The verification
caught it exactly as intended. Once chosen, uncomment the hard assertion in
`test_hashlock_parity` to lock it in.

## Two unknowns that still need a number from the node (read them, don't assume)

1. **`skew_max`** of the WarpX synchronizer. The timelock gap `T_canton − T_evm`
   must exceed `skew_max + EVM_finality + buffer`. Get the actual value; size the
   gap to dominate it.
2. **cBTC Holding binding.** `CbtcHtlc.daml` proves the hashlock+timelock logic
   with a `Decimal amount` placeholder. The real build replaces that with locking
   an actual Splice `Holding` on create and releasing it on Claim/Unlock. Confirm
   on the node that a custom template can take control of a cBTC Holding (lock it
   on the template's create, transfer it out on the choice). This is the final
   integration check — the logic above proves everything around it.

## Go / no-go

- EVM leg: **GO** (proven).
- Canton leg: **GO if** P1–P3 pass on the node AND the Holding binding works.
- Whole design: trustless and atomic the moment both legs share one verified
  preimage encoding and the timelock gap exceeds skew. No trusted oracle anywhere.

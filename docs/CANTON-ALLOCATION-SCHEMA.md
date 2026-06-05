# Canton Allocation Primitive — Verified Schema (the cBTC "escrow")

> Verified 2026-06-05 two ways: (1) live mainnet cBTC registry field-by-field
> validation (`api.utilities.digitalasset.com`), (2) canonical Splice Daml source
> (`hyperledger-labs/splice` token-standard interfaces). This is the exact shape to
> build the Canton-leg lock/release/refund on. No custom Daml — it's an HTTP client
> against the existing standard registry endpoint (sibling of our transfer-factory
> client).

## Endpoint (LIVE, confirmed)

```
POST <REGISTRY>/api/token-standard/v0/registrars/<ADMIN>/registry/allocation-instruction/v1/allocation-factory
```
- Returns `422 "Missing required field: choiceArguments"` on empty body (live).
- Metadata declares: `splice-api-token-allocation-{request,v1,instruction}-v1: 1`.
- Same envelope/shape as the `transfer-instruction/v1/transfer-factory` we already use.

## `AllocationFactory_Allocate` — the LOCK choice (create the allocation)

From `Splice.Api.Token.AllocationInstructionV1` (`AllocationFactory` interface):

```
AllocationFactory_Allocate with
  expectedAdmin    : Party                  -- cBTC admin party; impl validates it
  allocation       : AllocationSpecification -- the nested spec (below)
  requestedAt      : Time
  inputHoldingCids : [ContractId Holding]    -- which cBTC holdings to lock (may be [])
  -- extraArgs : ExtraArgs                    -- registry context (as in transfer-factory)
```

### `AllocationSpecification` (from `Splice.Api.Token.AllocationV1`)
```
AllocationSpecification with
  settlement    : SettlementInfo   -- deadlines + executor (drives refund)
  transferLegId : Text             -- unique id for this leg within the settlement
  transferLeg   : TransferLeg      -- sender/receiver/amount/instrument
```

### `SettlementInfo` — THE REFUND-SAFETY FIELDS
```
SettlementInfo with
  executor       : Party     -- who may fire Allocation_ExecuteTransfer (= our solver)
  settlementRef  : Reference -- id + optional cid of the settlement
  requestedAt    : Time      -- should be in the past
  allocateBefore : Time      -- deadline to CREATE the lock
  settleBefore   : Time      -- deadline to RELEASE; after this, release is impossible
                             --   → locked cBTC returns to sender (auto-refund window)
```

### `TransferLeg`
```
TransferLeg with
  sender       : Party        -- solver's float party
  receiver     : Party        -- user's Canton party
  amount       : Decimal      -- cBTC amount (BTC units)
  instrumentId : InstrumentId -- { admin: <cBTC admin>, id: "CBTC" }
  meta         : Metadata
```

## Lifecycle choices (lock → release → refund)

| Choice | Authority | Effect | Our use |
|---|---|---|---|
| `AllocationFactory_Allocate` | sender | **LOCK** cBTC into an `Allocation` | solver locks float (replaces plain transfer) |
| `Allocation_ExecuteTransfer` | `executor` | **RELEASE** to receiver; only before `settleBefore` | solver fires AFTER verifying WBTC on Arbitrum |
| `Allocation_Withdraw` | sender | sender reclaims locked funds | refund path |
| `Allocation_Cancel` | sender+receiver+executor | release back to sender | clean abort |

`Allocation_ExecuteTransfer`: *"SHOULD succeed provided the `settleBefore` deadline
has not yet passed."* → after `settleBefore`, the cBTC cannot be wrongly released and
is recoverable by the sender. **This is the built-in timeout-refund.**

## Trust model (unchanged, stated honestly)

The `executor` (our solver) still decides WHEN to release — Canton cannot observe
Arbitrum. So this is **conditional lock + auto-refund**, NOT cross-chain atomicity.
The upgrade vs. today is: cBTC is held in a STANDARD audited lock with a real
timeout-refund, instead of fire-and-forward-transfer + our own oracle. See
`docs/ATOMIC-SWAP-DESIGN.md` (Canton-side audit) for why this is the best
achievable EVM→Canton design.

## Verification spikes (2026-06-05) — all 3 pre-build gaps closed live

- **GAP 1 — allocate envelope shape: VERIFIED.** Posting the full envelope (mirrored
  on our working transfer-factory: `choiceArguments.{expectedAdmin, allocation:
  {settlement, transferLegId, transferLeg}, requestedAt, inputHoldingCids,
  extraArgs:{context,meta}}`) to the LIVE registry returned
  `404 {"error":"No holdings provided"}` — a BUSINESS-logic error, meaning the
  registry parsed every nested field and only rejected the empty holdings list.
  The shape is accepted; real call needs real `inputHoldingCids` + parties.
- **GAP 2 — executor / release authority: VERIFIED (Splice source).**
  `allocationControllers = [settlement.executor, transferLeg.sender,
  transferLeg.receiver]`; `Allocation_ExecuteTransfer` is controlled by ALL THREE.
  BUT the Daml comment: *"Typically this authorization is granted by sender and
  receiver to the executor as part of the contract"* — i.e. consent is delegated
  to the executor UP FRONT, so our solver (as executor, and as sender of its own
  float) can fire the release without the user online at release time. The user
  authorizes once at setup (same touch-point as today's "accept in Loop wallet").
- **GAP 3 — EVM pre-flight (eth_call openFor): VERIFIED.** `eth_call` of `openFor`
  with empty and junk signatures both REVERTED → eth_call executes the real
  validation, so simulating `openFor` before delivering cBTC is a usable
  claimability gate (our substitute for CoW's atomic revert). NOTE: revert reason
  came back undecoded ("unknown") — production should decode the escrow's custom
  errors to distinguish bad-sig vs insufficient-balance vs expired.

## Build note

Mirror the existing transfer-factory client (`swap-solver/src/canton.ts`
`createOffer`): same POST, same `choiceArguments` envelope, same holding-cid
selection, then submit the returned command via the Loop provider /
`submitTransaction`. Add three calls: allocate, executeTransfer, withdraw.

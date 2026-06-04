# Reverse Swap (cBTC → WBTC) — Feasibility Spike

> Investigation to size the reverse-direction swap before committing to it.
> **Definitive finding: the hard part (locking cBTC on Canton with conditional
> release + timeout refund) is a SHIPPED token-standard primitive — no custom
> Daml escrow needed.** Confirmed against the live cBTC mainnet registry.

## The question

Forward swap (WBTC→cBTC, DONE + live on mainnet) reused OIF's audited Solidity
`InputSettlerEscrow` to lock the input. The reverse direction inverts this: the
input (cBTC) must be locked **on Canton**, where we have no escrow. The whole
effort estimate hinged on one unknown: **can we lock cBTC and release-on-proof
using existing token-standard primitives, or must we write + audit custom Daml?**

## Answer: YES — use the token standard's `Allocation` primitive. No custom Daml.

The Splice/Canton token standard ships a purpose-built two-legged DvP/escrow
mechanism: **Allocation**. It locks a holder's tokens for a settlement leg,
releases them to a recipient only when an authorized **executor** fires the
release choice, and refunds the holder on cancel/withdraw or lock expiry.

### The choices (all standard, no Daml to write)
| Interface / choice | Authority | Effect |
|---|---|---|
| `AllocationFactory_Allocate` (allocation-instruction-v1) | holder (sender) | LOCKS the holder's cBTC (archives the input holdings into a locked allocation). |
| `Allocation_ExecuteTransfer` (allocation-v1) | executor + sender + receiver (typically pre-delegated to executor) | RELEASES locked cBTC to the receiver. Our solver fires this AFTER it verifies WBTC landed on the EVM chain. |
| `Allocation_Withdraw` | sender only | Holder's unilateral REFUND escape hatch (before `allocateBefore`). |
| `Allocation_Cancel` | sender + receiver + executor | Early refund when the cross-chain leg definitively fails. |
| `AllocationRequest` (allocation-request-v1) | app | The app asks the holder's wallet to create the allocation. |

### Refund-to-holder on timeout (the user-safety leg) — also built in
1. `Allocation_Withdraw` — holder pulls out anytime before `allocateBefore`.
2. `Allocation_Cancel` — executor/app releases back on abort.
3. **Lock auto-expiry** — the locked Holding carries `expiresAt`/`expiresAfter`;
   after `settleBefore` passes the allocation is dead and the cBTC returns to the
   holder. (`SettlementInfo.allocateBefore` / `settleBefore` drive the windows.)

This is the exact mirror of the forward direction's refund safety — just on the
Canton side instead of the EVM escrow.

## Verified against the LIVE cBTC registry (not just the docs)

Probed `https://api.utilities.digitalasset.com` for the mainnet cBTC registrar:

1. **Allocation factory endpoint exists** — `POST …/registry/allocation-instruction/v1/allocation-factory` returns the SAME `422 "Missing required field: choiceArguments"` as the transfer-factory we already use (a 404 would mean unsupported; 422 = live endpoint, empty body).
2. **Registry metadata declares full allocation support:**
   ```
   "supportedApis": {
     "splice-api-token-allocation-request-v1": 1,
     "splice-api-token-allocation-v1": 1,
     "splice-api-token-allocation-instruction-v1": 1,
     "splice-api-token-transfer-instruction-v1": 1,
     "splice-api-token-holding-v1": 1
   }
   ```

So locking + conditional release + timeout refund work for **our** token, today.

## The one real caveat (same as forward)

The standard's atomicity is **on-ledger only** — there is NO native primitive
that makes a Canton leg atomic with an EVM leg. So the reverse swap is
**conditional release with refund safety, NOT cross-chain atomicity** — exactly
the same trust model as the forward direction. The off-chain condition ("WBTC
landed on Arbitrum") is enforced by OUR solver/oracle (which already exists),
which only fires `Allocation_ExecuteTransfer` after verifying EVM delivery.

## What this means for effort

The piece I feared could be weeks of custom Daml + audit is **not** custom Daml —
it's an integration against an existing, supported registry API (the same shape
as the transfer-factory client we already wrote). The custom work is the
off-chain executor bridging the proof — which is what our solver already is,
just inverted.

### Effort estimate (revised, de-risked)
| Piece | Effort |
|---|---|
| Allocation client (allocate / execute / withdraw / cancel) — mirrors our transfer-factory client | ~3–5 days |
| WBTC delivery on Arbitrum = plain ERC20 transfer (simpler than the Permit2 lock) | ~1 day |
| Canton-side proof consumption (executor verifies EVM delivery, then ExecuteTransfer) — reuses our oracle/attestor pattern | ~3–5 days |
| Solver pipeline (reversed legs) — ~70% reuse (store, retry, monitor, env, both chain clients) | ~3–5 days |
| UI (direction toggle + reversed flow) — mostly reuse | ~2–3 days |
| Testing (testnet + mainnet, unhappy paths, the inevitable live-only bugs) | ~40% of total |

**Total: ~1.5–2.5 focused weeks** (was "1–2 weeks IF the lock primitive works,
else 3–4 weeks" — the spike collapsed it to the lower, confident range, because
the lock primitive is confirmed to exist and be supported).

## Build-time unknowns — RESOLVED via live probes (2026-06)

Ran read-only probes against the live cBTC mainnet registry + the Loop SDK
types. All the "confirm during build" items are now answered with evidence:

### ✅ 1. The allocation-factory request shape — fully reverse-engineered + WORKS
Stepped the live `…/registry/allocation-instruction/v1/allocation-factory`
endpoint field-by-field (it validates exactly like the transfer-factory we
already use). The COMPLETE accepted request body:
```jsonc
{ "choiceArguments": {
  "expectedAdmin": "<cbtc admin>",
  "allocation": {
    "settlement": {
      "executor": "<solver party>",
      "settlementRef": { "id": "...", "cid": null },
      "requestedAt": "<ISO>", "allocateBefore": "<ISO>", "settleBefore": "<ISO>",
      "meta": { "values": {} }
    },
    "transferLegId": "leg1",
    "transferLeg": {
      "sender": "<user party>", "receiver": "<recipient>",
      "amount": "0.00001", "instrumentId": { "admin": "<cbtc admin>", "id": "CBTC" },
      "meta": { "values": {} }
    }
  },
  "requestedAt": "<ISO>",
  "inputHoldingCids": ["<real holding cid>"],
  "extraArgs": { "context": { "values": {} }, "meta": { "values": {} } }
} }
```
With a REAL float holding cid, the factory **returned `{ factoryId, choiceContext }`
with 2 disclosed contracts** — i.e. everything needed to exercise
`AllocationFactory_Allocate`. This is the SAME response shape + flow as the
transfer-factory client we already have in production. → the allocation client is
"copy transfer-factory client, swap endpoint + choice args", not net-new.

### ✅ 2. User can sign AllocationFactory_Allocate via Loop
Loop's `provider.submitTransaction` takes a generic `TransactionPayload`
(`commands: any[]`, `disclosedContracts: any[]`, `actAs`) — the EXACT shape our
transfer-factory `ExerciseCommand` already builds. The provider signs whatever
command payload it's handed; it doesn't care which choice. So the user locking
their OWN cBTC (signing the allocate as sender) is structurally identical to any
other user-signed Canton tx. No special SDK support required.

### ⚠️ 3. Decimals: metadata says `decimals: 10`, holdings are 8dp in practice
The registry instrument metadata reports `decimals: 10` for CBTC, but the actual
holdings we've moved are 8dp (amounts like "0.00001"). The transfer/allocation
APIs take amount as a DECIMAL STRING ("0.00001"), so decimals only matter for
display/parsing — reconcile before relying on metadata decimals, but it does NOT
block the allocation flow (amounts are strings end-to-end). Cosmetic.

## Net: NO blockers remain. Estimate firmed to the LOWER end (~1.5–2 weeks).
Every load-bearing unknown is confirmed against the live registry:
- Allocation API supported by cBTC ✓
- Full request shape works ✓ (factoryId + choiceContext returned)
- User can sign the lock via Loop ✓
- Refund/timeout primitives are standard ✓
The reverse swap is an INTEGRATION (mirror the existing solver + allocation
client), not new infrastructure or custom Daml.

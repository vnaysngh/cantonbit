# Canton + Loop: cBTC Transfer Monitoring & In-App Accept (feasibility)

> Question: when we send cBTC to the user, what happens if they don't accept?
> Can we MONITOR the pending transfer and let the user ACCEPT it from OUR app
> (not the Loop wallet's Offers tab) — without any security loophole?
>
> Sourced from primary code/docs, NOT assumption:
> - Loop SDK source: github.com/fivenorth-io/loop-sdk (provider.ts, connection.ts,
>   types.ts, docs/usage.md, docs/server.md, docs/api-reference.md)
> - Canton token standard source: hyperledger-labs/splice
>   (TransferInstructionV1.daml)
> - TODO: cross-check docs.canton.network for the accept choice-context.

## 1. Does an un-accepted cBTC transfer stay pending? — YES (confirmed)

The cBTC transfer creates a `TransferInstruction` in state
`TransferPendingReceiverAcceptance`. It stays there until the receiver
**accepts**, **rejects**, or it **expires** (then funds return to the sender).
Verified live (we saw multiple pending offers in the Loop Offers tab).

## 2. Can we MONITOR it? — YES, three independent ways

- **By interface id**: `provider.getActiveContracts({ interfaceId:
  "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction" })`
  → lists the user's pending incoming transfers. (connection.ts L104-110 forwards
  templateId/interfaceId as query params.)
- **By memo**: `provider.transfer(..., { memo })` stores a memo as transfer
  metadata (provider.ts L206, connection.ts L150, types.ts `TransferRequest.memo`).
  We can tag each swap's cBTC transfer with the swap orderId and match it back.
- **By update callback**: `onTransactionUpdate(payload)` fires with `command_id`,
  `submission_id`, and on success `update_id` + `update_data` (the ledger tx
  tree). (api-reference.md.)

## 3. Can the user ACCEPT from OUR app? — YES, and SECURELY

- The Canton token standard choice `TransferInstruction_Accept` is
  **`controller (view this).transfer.receiver`** — i.e. ONLY the receiver
  authorizes it. The receiver is our user, whose wallet session our app holds
  (the Loop `provider`).
- The Loop SDK exposes `provider.submitTransaction({ commands: [{ ExerciseCommand:
  { templateId, contractId, choice, choiceArgument } }] })` — the dApp can
  exercise ANY choice on ANY contract through the user's session (usage.md shows
  exercising a token-standard choice directly).
- **Security:** `submitTransaction` routes through the Loop WALLET, which PROMPTS
  the user to approve (with a custom message). It does NOT require the user's
  private key. (Server-side signing — `docs/server.md` — DOES require the private
  key: *"Party ID + public key alone is not enough."* We will NOT use that; it's
  the loophole to avoid.)

So our app can: detect the incoming cBTC (getActiveContracts) → present an "Accept
your CBTC" button in the swap screen → call
`provider.submitTransaction(TransferInstruction_Accept on that contract)` → the
user approves ONE in-context wallet prompt. No key custody, no security
compromise. Smoother than hunting in the Loop Offers tab.

## 4. The open verification before building (NO assumptions)

- `TransferInstruction_Accept` takes `extraArgs : ExtraArgs` — like the transfer
  factory, the registry likely requires a **choice-context** fetched from the
  registry's `transfer-instruction/.../<cid>/choice-contexts/accept` endpoint
  (CLAUDE.md references this endpoint). MUST fetch + pass it, or accept reverts.
  → VERIFY against docs.canton.network + a LIVE accept test before building.
- The pending `TransferInstruction` lives on the RECEIVER's participant. Our
  solver's m2m token can't read it (403) — but the USER's own `provider` session
  CAN (it's their party). So monitoring must use the user's provider, not the
  solver. Confirmed by the 403s we hit solver-side.

## 5. Why this matters for the product

Today the swap's step 3 ("user accepts cBTC") sends the user OUT of our app into
the Loop wallet's Offers tab, where (as we saw) multiple identical-looking offers
are confusing. Bringing the accept INTO our swap screen — detect by memo, one
in-context approve — removes that confusion and the "did it work?" gap, while
keeping the exact same security model (receiver-authorized, wallet-approved).

## 6. The exact accept mechanics — VERIFIED (DA's official CLI + live registry)

Authoritative reference: Digital Asset's Token Standard CLI
`token-standard/cli/src/commands/acceptTransferInstruction.ts` (canton-network/splice).
The proven pattern:

```
// 1. fetch the accept choice-context from the registry
const ctx = await registry.getTransferInstructionAcceptContext(transferInstructionCid)
//    → POST <REGISTRY>/.../registry/transfer-instruction/v1/<cid>/choice-contexts/accept

// 2. exercise the accept choice with that context (via Loop provider.submitTransaction)
ExerciseCommand {
  templateId: "#splice-api-token-transfer-instruction-v1:...:TransferInstruction",
  contractId: <transferInstructionCid>,
  choice: "TransferInstruction_Accept",
  choiceArgument: { extraArgs: { context: ctx.choiceContextData, meta: { values: {} } } }
}
// + disclosedContracts: ctx.disclosedContracts
```

**Live verification on the cBTC mainnet registry (2026-06-06):**
- `POST .../transfer-instruction/v1/<cid>/choice-contexts/accept` → **500** with a
  bogus cid (route EXISTS, choked on the bad contract id).
- `POST .../choice-contexts/NONSENSE` → **404 Not found** (proves 500 above is a
  real route, not a catch-all).
So the accept choice-context endpoint is LIVE. The accept is buildable exactly
like our existing createOffer (fetch context → exercise with extraArgs +
disclosed contracts).

## Status

In-app, user-approved accept is **PROVEN FEASIBLE from primary sources** with NO
security loophole (receiver-authorized, wallet-approved, no private key). The exact
choice, context endpoint, and submit path are all verified. Remaining before
SHIPPING: one live accept via provider.submitTransaction from the app (the user
must approve) to confirm the end-to-end UX, and wiring it into the swap screen.

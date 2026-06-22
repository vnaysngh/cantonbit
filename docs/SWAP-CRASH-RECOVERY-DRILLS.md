# Swap Crash-Recovery Drills

Purpose: prove the swap system converges after a process crash at every external
commit boundary. These drills should be run on devnet with small funded swaps
before mainnet release and after any lifecycle/daemon/storage change.

The expected result is not “no error appeared.” The expected result is:

- no duplicate user payout;
- no duplicate solver payout;
- no stranded vault/user funds after retry windows;
- no order stuck forever in a transient state;
- deterministic command recovery finds the committed Canton update when the DB
  write was missed;
- EVM finality/hash checks still gate any irreversible Canton action.

## Required setup

1. Apply all Supabase migrations through `039`.
2. Use a dedicated devnet vault with small CC/CBTC float.
3. Keep `CANTON_SWAP_SETTLEMENT_PARTY` preapproval OFF for CC and CBTC.
4. Enable CC + CBTC receive preapprovals on the test user party.
5. Run the preapproval diagnostic:

   ```bash
   npm run check-swap-preapprovals:devnet -- '<vault-party>' '<user-party>'
   ```

6. Run one clean baseline swap for each route being drilled.

## Drill method

Use a small amount. For each checkpoint:

1. Start the web app and the relevant daemon.
2. Drive the swap until the named checkpoint is about to execute.
3. Kill the process immediately after the external submit returns but before the
   next DB status/evidence write where possible.
4. Restart the web app and daemon.
5. Wait for reconciliation.
6. Verify ledger/EVM state and DB state.

Where exact code breakpoints are easier than timing, add a local-only `throw` or
`process.exit(1)` at the checkpoint, run the drill, then remove it before commit.
Do not commit artificial crash hooks.

## Cross-chain HTLC: EVM → Canton

| Checkpoint | Kill after | Expected recovery |
| --- | --- | --- |
| User WBTC lock submitted | EVM tx broadcast, before/while `recordMainLock` persists `mainLockTx` | Pending-main-lock recovery or manual retry records the lock only after confirmations/hash validation. |
| Solver CBTC allocation created | Allocation submit committed, before `allocationCid` persists | Duplicate deterministic command recovery finds the allocation or cleanup withdraws stale allocation. |
| `HtlcLock` created | HTLC create committed, before `htlcCid` persists | Ledger recovery finds exact HTLC by command/update evidence; no duplicate allocation is consumed. |
| Managed user claim | `HtlcLock.Claim` committed, before `counter_claimed` persists | Duplicate command recovery records claim update and preimage; daemon claims WBTC once. |
| Loop reveal/delivery | Preimage stored / standard transfer committed, before delivery evidence persists | Delivery recovery finds direct holding or pending offer; order remains `counter_claimed`/`main_claimed`, never re-reveals as a new obligation. |
| Solver WBTC claim | EVM claim tx broadcast, before `main_claimed` persists | EVM event reconciliation marks `main_claimed`; no second claim attempt matters because HTLC is spent. |

## Cross-chain HTLC: Canton → EVM

| Checkpoint | Kill after | Expected recovery |
| --- | --- | --- |
| Reverse WBTC float reserved | DB reservation succeeds, before Canton user lock/custody | Retry sees reservation and continues; no second order can consume the same reserved float. |
| Managed user CBTC HTLC created | Canton `HtlcLock` committed, before `main_locked` evidence persists | Ledger recovery records allocation/HTLC; refund path remains available after timeout. |
| Loop seller custody transfer | Standard transfer/holding committed, before custody evidence persists | Custody evidence recovery finds exact sender/receiver/amount/instrument; unique index prevents evidence reuse. |
| Solver WBTC lock | EVM lock tx broadcast, before `counter_locked` persists | EVM verification records lock only after confirmations/hash validation. |
| User WBTC claim | EVM claim committed, before `counter_claimed` persists | Preimage discovery advances order; Canton claim proceeds once. |
| Refund in progress | Status CAS to `refunding`, after refund submit, before `refunded` persists | Retry re-enters `refunding`, recovers duplicate command, and marks `refunded`. |

## C2C managed/email

| Checkpoint | Kill after | Expected recovery |
| --- | --- | --- |
| User sell offer created | Offer submit committed, before `userLegOfferCid` persists | Offer resolver finds exact pending offer on the vault ACS; no duplicate offer is created. |
| Fill committed | Accept user sell + direct counter delivery committed, before `settlementUpdateId`/`filled` persists | Deterministic command recovery finds the fill update and marks `filled`. |
| Fee collected | Fill committed with fee leg, before fee ledger booking | `networkFeeAccountingPending`/outbox drains exactly once. |

Managed C2C must not leave a pending counter offer. If the counter leg is not
direct, the service should refuse to consume the user sell leg.

## C2C Loop

| Checkpoint | Kill after | Expected recovery |
| --- | --- | --- |
| Loop user sell offer confirmed | Loop submit returns update id, before DB stores offer CID/update id | Submit-update proof or vault ACS scan records the exact pending offer; preapproval auto-settle is rejected. |
| Vault fill committed direct | Fill committed, before `filled` persists | Deterministic command recovery marks `filled`; no reissue occurs. |
| Vault fill committed pending | Fill committed, before `counterLegOfferCid`/offset persists | Recovery records the counter offer and creation offset; order stays `user_locked`. |
| User accepts pending counter | Accept committed, before `counterReceiptUpdateId` persists | Receipt scan from creation offset records acceptance and marks `filled`. |
| Counter offer disappears | Pending offer leaves ACS with no receipt visible yet | Reissue is blocked until cooldown and complete receipt scan; if receipt appears, no reissue. |
| Counter reissue committed | Reissue committed, before new offer CID persists | Deterministic command recovery records the reissued offer; no duplicate reissue for the same attempt. |

## Required post-drill checks

Run after each killed/restarted scenario:

```bash
npm test
npm run check-swap-preapprovals:devnet -- '<vault-party>' '<user-party>'
npm run party-balances:devnet -- '<vault-party>'
```

Then inspect the order row:

- terminal success: `main_claimed`, `filled`, or `refunded`;
- no active duplicate order with the same custody evidence or user-leg offer CID;
- `network_fee_accounting_pending = false` after the outbox drains;
- `counter_leg_created_offset` is present for any pending/reissued counter offer.

## Mainnet release gate

Before mainnet, record at least one completed drill per route:

- HTLC EVM→Canton managed
- HTLC Canton→EVM managed
- HTLC EVM→Canton Loop
- HTLC Canton→EVM Loop
- C2C managed direct
- C2C Loop direct or pending-counter path, depending on actual Loop receive
  preapproval behavior

Do not treat a funded happy-path smoke swap as equivalent to these drills. The
drills target crash windows that normal happy-path testing does not exercise.

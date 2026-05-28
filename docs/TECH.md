# Oranj — Technical Reference

Engineer-facing reference for the mint and redeem flows. For the user-facing intro, see [`README.md`](../README.md). For raw API request bodies, see [`YAAK_REFERENCE.md`](./YAAK_REFERENCE.md).

---

## Overview

Oranj is a Next.js 14+ app (App Router, TypeScript, Tailwind v4, shadcn/ui) that lets users mint and redeem cBTC — a Bitcoin-backed token on Canton Network — by coordinating between three external systems:

1. **Loop wallet** (`@fivenorth/loop-sdk`) — user's Canton wallet, signs every on-chain action
2. **DLC.link coordinator** — public HTTP service run by BitSafe, no auth, provides factory contract IDs and BTC addresses
3. **Five North validator** — Canton participant node that hosts the ledger; server-side reads use an Authentik m2m JWT against this node

**Important**: user transactions (mint, redeem) do NOT go through the Five North validator directly. They are submitted by Loop's own backend via WebSocket. The Five North node is used only for server-side read routes (`/api/canton/*`).

---

## System map

```
Browser
├── Loop SDK (WebSocket → wss://devnet.cantonloop.com)
│     └── user transactions: redeem, deposit-account create, P2P send
│         (Loop signs + submits via Loop's own Canton participant)
│
└── fetch → Oranj Next.js server
      ├── /api/auth/token             → Authentik (m2m JWT)
      ├── /api/canton/*               → Five North validator (JWT bearer)
      ├── /api/activity               → derive activity from update stream
      ├── /api/transfers/*            → server-side P2P transfer (m2m)
      ├── /api/mint/process-transfers → MINT PROCESSOR (m2m, dual auth)
      └── lib/bitsafe.ts              → DLC.link coordinator (no auth)

Mint delivery (server-side, m2m JWT — no Loop, no browser needed):
  BitSafe attestors  →  mint cBTC onto WARPX party
  mint-processor     →  warpx → user party  (TransferFactory_Transfer + Accept)
  state in Supabase  →  mint_transfers, mint_processor_state, deposit_accounts

Triggers for the processor:
  • mint page poll  (Supabase-session auth)
  • cron worker     (scripts/process-mints.sh, CRON_SECRET auth)
```

---

## The two identities

Every operation in Oranj uses one of two identities:

| Identity | How obtained | What it can do | Where used |
|---|---|---|---|
| **App (m2m)** | Authentik `client_credentials` grant | Read public Canton ledger state on the Five North node | `lib/auth.ts`, `lib/canton.ts`, `/api/canton/*` routes |
| **User** | Loop wallet session | Sign and submit transactions actAs the user's party | `provider.submitTransaction()`, `provider.getActiveContracts()` |

The m2m token cannot `actAs` a user's party — it 403s if you try. User-side writes must go through Loop. This was verified in testing (see troubleshooting section below).

---

## Canton contract model

Every action in Oranj touches Canton contracts. A contract is an immutable on-ledger record. It has a **contract ID** (long hex, starts with `00...`) that uniquely identifies one instance. You never guess or construct contract IDs — you either fetch them from the coordinator or parse them from transaction responses.

### The two contract IDs in the mint flow

These are the two that confuse people most. Keep them straight:

#### Contract ID #1 — `da_rules` (the shared factory)

- **What**: `CBTCDepositAccountRules` — a factory contract published by BitSafe. Everyone uses the same one.
- **How you get it**: `POST coordinator/app/get-account-contract-rules` → `{da_rules: {contract_id, template_id, created_event_blob}}`
- **What you do with it**: Exercise the choice `CBTCDepositAccountRules_CreateDepositAccount` on it. This creates a new contract.
- **When it changes**: BitSafe republishes it occasionally. Always fetch fresh. Never cache.

#### Contract ID #2 — `CBTCDepositAccount` (per-user)

- **What**: The user's personal deposit account on Canton. Links their party to the bridge.
- **How you get it**: Doesn't exist until the user creates it (step above). Oranj parses it from the transaction tree response after creation. On subsequent mints, `listDepositAccounts()` finds the existing one via `getActiveContracts`.
- **What you do with it**: Pass as the `id` field to `POST coordinator/app/get-bitcoin-address`. The coordinator returns the BTC address tied to this contract.
- **When it changes**: Stable after creation. Reused indefinitely.

The burn flow has the exact same structure but with `wa_rules` (withdraw account rules) instead of `da_rules`.

---

## Mint flow — step by step

**Source**: [`lib/mint.ts`](../lib/mint.ts), [`app/mint/page.tsx`](../app/mint/page.tsx)  
**Reference**: [BitSafe docs — How to Mint CBTC](https://docs.bitsafe.finance/developers/cbtc-minting-and-burning)

```
┌──────────────────────────────────────────────────────────────────────┐
│ Step 1: GET FACTORY CONTRACT                                          │
│                                                                       │
│ POST https://devnet.dlc.link/attestor-2/app/get-account-contract-rules│
│ Body: {"chain": "canton-devnet"}                                      │
│                                                                       │
│ Response:                                                             │
│   {                                                                   │
│     da_rules: {                                                       │
│       contract_id: "00abc...",                                        │
│       template_id: "...",                                             │
│       created_event_blob: "..."    ← needed for disclosedContracts   │
│     },                                                                │
│     wa_rules: { ... }             ← used in redeem, ignore for now  │
│   }                                                                   │
│                                                                       │
│ ▶ We now have CONTRACT ID #1 (the factory).                           │
└──────────────────────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Step 2: CHECK FOR EXISTING DEPOSIT ACCOUNT                            │
│                                                                       │
│ provider.getActiveContracts({                                         │
│   templateId: "#cbtc:CBTC.DepositAccount:CBTCDepositAccount"          │
│ })                                                                    │
│                                                                       │
│ → Loop calls: GET https://devnet.cantonloop.com/api/v1/.connect/      │
│               pair/account/active-contracts?templateId=...            │
│                                                                       │
│ ▶ If list is non-empty: skip step 3, jump to step 4 with existing cid.│
│ ▶ If empty: go to step 3.                                             │
└──────────────────────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Step 3: CREATE DEPOSIT ACCOUNT                            [Loop popup]│
│                                                                       │
│ provider.submitTransaction({                                          │
│   actAs: [userParty],                                                 │
│   disclosedContracts: [{                                              │
│     templateId:        da_rules.template_id,                          │
│     contractId:        da_rules.contract_id,    ← CONTRACT ID #1     │
│     createdEventBlob:  da_rules.created_event_blob,                   │
│     synchronizerId:    ""                                             │
│   }],                                                                 │
│   commands: [{                                                        │
│     ExerciseCommand: {                                                │
│       templateId:      "#cbtc:CBTC.DepositAccount:CBTCDepositAccount" │
│                        "Rules",                                       │
│       contractId:      da_rules.contract_id,    ← CONTRACT ID #1     │
│       choice:          "CBTCDepositAccountRules_CreateDepositAccount", │
│       choiceArgument:  { owner: userParty }                           │
│     }                                                                 │
│   }]                                                                  │
│ })                                                                    │
│                                                                       │
│ Loop pops up → user approves → Loop signs and submits                 │
│ Canton creates a new CBTCDepositAccount contract.                     │
│ Transaction tree response contains the new contract's ID.            │
│                                                                       │
│ ▶ We parse CONTRACT ID #2 from the transaction tree response.         │
└──────────────────────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Step 4: GET BTC DEPOSIT ADDRESS                                       │
│                                                                       │
│ POST https://devnet.dlc.link/attestor-2/app/get-bitcoin-address       │
│ Body: {"id": "<CONTRACT ID #2>", "chain": "canton-devnet"}            │
│                                                                       │
│ Response: {"address": "bcrt1p..."}   (P2TR taproot address)           │
│                                                                       │
│ ▶ Display address as QR code. User sends BTC to it.                   │
└──────────────────────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Step 5: USER SENDS BTC                          [outside our code]    │
│                                                                       │
│ User sends at minimum 0.001 BTC to the address from step 4.          │
│ Minimum amount enforced by BitSafe, not by Oranj.                 │
└──────────────────────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Step 6: ATTESTORS CONFIRM + MINT → WARPX        [outside our code]    │
│                                                                       │
│ BitSafe attestor network watches Bitcoin for 6 confirmations (~60min).│
│ After confirmation 6: attestors submit ConfirmDepositAction on Canton.│
│ Additional 60–120 sec for attestor processing.                        │
│                                                                       │
│ ⚠ The cBTC Holding is created on the WARPX holding party, NOT the     │
│   user's party. The transaction also ARCHIVES the CBTCDepositAccount  │
│   and creates a fresh rolled-forward one. (Archived-DA = mint sig.)   │
└──────────────────────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Step 7: MINT PROCESSOR DELIVERS WARPX → USER     [lib/mint-processor] │
│                                                                       │
│ Oranj's mint processor (server-side, m2m JWT) detects the holding on  │
│ warpx and transfers it to the user's party via a two-phase transfer.  │
│ Triggered by: the mint-page poll AND/OR the background cron.          │
│ See "Mint processor" section below for the full design + guarantees.  │
└──────────────────────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Step 8: ORANJ POLLS BALANCE                                           │
│                                                                       │
│ While mint page is open: setInterval(refetchBalance, 30_000)          │
│ When cBTC balance increases on the user party → mint complete.        │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Mint processor (warpx → user delivery)

**Source**: [`lib/mint-processor.ts`](../lib/mint-processor.ts) (orchestration + ledger I/O), [`lib/mint-processor-logic.ts`](../lib/mint-processor-logic.ts) (pure decision logic, unit-tested), [`app/api/mint/process-transfers/route.ts`](../app/api/mint/process-transfers/route.ts) (HTTP entry)
**DB**: Supabase tables `mint_transfers`, `mint_processor_state`, `deposit_accounts` — migrations [`003_mint_processor.sql`](../supabase/migrations/003_mint_processor.sql), [`004_mint_processor_hardening.sql`](../supabase/migrations/004_mint_processor_hardening.sql)

### Why a processor exists

BitSafe mints cBTC into the **warpx holding party** (`NETWORK.warpxPartyId`), not into the user's party. Something must move it from warpx to the user. That something is the processor. It runs server-side under the **m2m JWT**, which on this node has authority over both `warpx-mainnet-1` and all `cbtc-user-*` parties — so it can both create the transfer (as warpx) and accept it (as the user).

### Design: holding-based, not cursor-based

The trigger is **"what cBTC Holdings are currently owned by warpx?"** (an ACS query — `getActiveWarpxHoldings()`), NOT "what's new since offset X". This is deliberate and was a rewrite:

- **Why not a cursor:** a monotonic `last_processed_offset` bookmark moves forward unconditionally. If a transfer failed, the cursor advanced past the mint and the cBTC was stranded forever (this happened in production on 2026-05-27).
- **Holding-based is un-strandable:** a holding stays in the warpx ACS until it is actually transferred (transfer archives it on warpx). So unfinished work is always visible, and re-running is always safe and idempotent.
- Offsets are still used, but only as a **lookup key** to find a specific holding's creating transaction — never as the scan trigger.

### Mint classification (the critical filter)

Not every holding on warpx is a fresh mint — some are change/leftovers from transfers or released offers. A holding is a **mint** only if its creating transaction **archived a `CBTCDepositAccount`**. `findMintForHolding()` fetches the holding's creating transaction (via `events-by-contract-id` → that single offset's `/v2/updates`) and checks for an archived DepositAccount. Non-mints are left untouched.

### User resolution

The archived DepositAccount's contract ID maps to a user via Supabase `deposit_accounts`. **Caveat:** after each mint BitSafe archives the old DepositAccount and creates a fresh one whose `createArgument.id` field holds the contract ID of the *original* DA. Our DB stores the original. So we match by **either** the archived CID **or** the rolled-forward `id` (`candidateDaIds`). Without this, second+ mints to the same BTC address become unresolvable "orphans". A coordinator-address fallback (`getBitcoinAddress`) is the last resort.

### Two-phase transfer + state machine

```
pending → processing → offer_created → transferred
                                    ↘  failed (any error)
```

1. **Claim** the row atomically (`claim_mint_transfer` RPC): `pending|failed|offer_created → processing`. Returns null if already owned → skip. Reclaims rows stuck in `processing` > 15 min (crash self-heal).
2. **Phase 1** (`createTransferOffer`): exercise `TransferFactory_Transfer` (interface-style templateId) as warpx. The created offer's contract ID is extracted **directly from the transaction-tree response** (`extractCreatedOfferCid`), not a follow-up ACS query — this kills a race that previously caused "Phase 1 succeeded but no offer found".
3. **Persist** the offer CID to `mint_transfers.offer_contract_id` (status `offer_created`) **before** accepting. If the run crashes here, the next run sees the recorded offer and accepts it rather than creating a duplicate.
4. **Phase 2** (`acceptTransferOffer`): exercise `TransferInstruction_Accept` as the user. cBTC now owned by the user.
5. Mark `transferred`.

### Concurrency control (two layers)

- **Lease lock** (`try_lock_mint_processor` / `unlock_mint_processor`): a single atomic UPDATE on `mint_processor_state.locked_until`. Only one processor run executes at a time. NOT a `pg_advisory_lock` — advisory locks are session-scoped and don't survive across separate Supabase PostgREST RPC calls (each runs on a different pooled connection). The lease auto-expires (300s) so a crashed run can't deadlock.
- **Atomic per-holding claim** (`claim_mint_transfer`): even if two runs overlapped, only one can claim a given holding. This is the authoritative duplicate guard.

### Duplicate-offer prevention (defense in depth)

The 2026-05-27 incident created duplicate TransferOffers. Three independent guards now prevent it: (a) offer CID persisted before accept → retries accept, never recreate; (b) atomic claim → one worker per holding; (c) full-amount transfers → no change/fragmentation. Pure decision logic is in `lib/mint-processor-logic.ts` and unit-tested (`npm test`).

### Triggers & auth

- `POST /api/mint/process-transfers` — dual auth: `CRON_SECRET` bearer token (cron) OR Supabase session (frontend poll). The route is in middleware's public list (it does its own auth).
- Background cron: [`scripts/process-mints.sh`](../scripts/process-mints.sh) (curl + `CRON_SECRET`), schedulable on Railway/etc.

### Known caveat

The cBTC arrives on the user party as a holding the user did not create — fine for balance, but worth noting if reasoning about provenance. Leftover/change holdings on warpx (from manual sends or cancelled offers) are correctly ignored by the mint filter but must be reconciled separately.

---

## Redeem (burn) flow — step by step

**Source**: [`lib/redeem.ts`](../lib/redeem.ts), [`app/redeem/page.tsx`](../app/redeem/page.tsx)  
**Reference**: [BitSafe docs — How to Burn CBTC](https://docs.bitsafe.finance/developers/cbtc-minting-and-burning)

```
┌──────────────────────────────────────────────────────────────────────┐
│ Step 1: GET FACTORY CONTRACT (same call as mint step 1)               │
│                                                                       │
│ POST coordinator/app/get-account-contract-rules                       │
│ Body: {"chain": "canton-devnet"}                                      │
│                                                                       │
│ ▶ We use wa_rules this time (withdraw account rules).                 │
│   CONTRACT ID #1 = wa_rules.contract_id                               │
└──────────────────────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Step 2: CHECK FOR EXISTING WITHDRAW ACCOUNT                           │
│                                                                       │
│ provider.getActiveContracts({                                         │
│   templateId: "#cbtc:CBTC.WithdrawAccount:CBTCWithdrawAccount"        │
│ })                                                                    │
│                                                                       │
│ Filter results by destinationBtcAddress === user's entered address.   │
│ ▶ If match found: reuse it, skip step 3.                              │
│ ▶ If no match: go to step 3.                                          │
└──────────────────────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Step 3: CREATE WITHDRAW ACCOUNT                           [Loop popup]│
│                                                                       │
│ provider.submitTransaction({                                          │
│   actAs: [userParty],                                                 │
│   disclosedContracts: [wa_rules],                                     │
│   commands: [{                                                        │
│     ExerciseCommand: {                                                │
│       templateId: "#cbtc:CBTC.WithdrawAccount:CBTCWithdrawAccount"    │
│                   "Rules",                                            │
│       contractId: wa_rules.contract_id,      ← CONTRACT ID #1        │
│       choice:     "CBTCWithdrawAccountRules_CreateWithdrawAccount",   │
│       choiceArgument: {                                               │
│         owner: userParty,                                             │
│         destinationBtcAddress: "bcrt1..."                             │
│       }                                                               │
│     }                                                                 │
│   }]                                                                  │
│ })                                                                    │
│                                                                       │
│ ▶ Parse CONTRACT ID #2 (CBTCWithdrawAccount) from tx response.        │
└──────────────────────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Step 4: GET TOKEN STANDARD CONTRACTS                                  │
│                                                                       │
│ POST coordinator/app/get-token-standard-contracts                     │
│ Body: {"chain": "canton-devnet"}                                      │
│                                                                       │
│ Response — 5 contracts, all needed for the burn:                      │
│   burn_mint_factory          → burnMintFactoryCid in choiceArgument   │
│   instrument_configuration   ┐                                        │
│   app_reward_configuration   │ → extraArgs.context.values             │
│   featured_app_right         │   (keyed by URI string)                │
│   issuer_credential          ┘                                        │
│                                                                       │
│ All 5 also go into disclosedContracts on the burn transaction.        │
└──────────────────────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Step 5: PICK HOLDINGS TO BURN                                         │
│                                                                       │
│ provider.getActiveContracts({                                         │
│   interfaceId: "#splice-api-token-holding-v1:Splice.Api.Token.        │
│                 HoldingV1:Holding"                                    │
│ })                                                                    │
│                                                                       │
│ Filter out locked holdings (in-flight transfers).                     │
│ Sort descending by amount, pick greedily until total >= burn amount.  │
│ ▶ Their contract IDs go into choiceArgument.tokens                    │
└──────────────────────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Step 6: EXERCISE WITHDRAW (BURN)                          [Loop popup]│
│                                                                       │
│ provider.submitTransaction({                                          │
│   actAs: [userParty],                                                 │
│   disclosedContracts: [all 5 token-standard contracts],               │
│   commands: [{                                                        │
│     ExerciseCommand: {                                                │
│       templateId: "#cbtc:CBTC.WithdrawAccount:CBTCWithdrawAccount",   │
│       contractId: <CONTRACT ID #2>,                                   │
│       choice:     "CBTCWithdrawAccount_Withdraw",                     │
│       choiceArgument: {                                               │
│         amount: "0.001",                                              │
│         tokens: ["00cid1...", "00cid2..."],   ← from step 5           │
│         burnMintFactoryCid: ts.burn_mint_factory.contract_id,         │
│         extraArgs: {                                                  │
│           context: {                                                  │
│             values: {                                                 │
│               "utility.digitalasset.com/instrument-configuration":   │
│                 { tag: "AV_ContractId", value: <cid> },              │
│               "utility.digitalasset.com/app-reward-configuration":   │
│                 { tag: "AV_ContractId", value: <cid> },              │
│               "utility.digitalasset.com/featured-app-right":         │
│                 { tag: "AV_ContractId", value: <cid> },              │
│               "utility.digitalasset.com/issuer-credentials":         │
│                 { tag: "AV_List",                                     │
│                   value: [{ tag: "AV_ContractId", value: <cid> }] }  │
│             }                                                         │
│           },                                                          │
│           meta: {                                                     │
│             values: {                                                 │
│               "splice.lfdecentralizedtrust.org/reason": "CBTC Burn"  │
│             }                                                         │
│           }                                                           │
│         }                                                             │
│       }                                                               │
│     }                                                                 │
│   }]                                                                  │
│ })                                                                    │
│                                                                       │
│ Loop pops up → user approves → Canton burns Holdings.                 │
│ Canton update ID returned in tx response → shown in success UI.       │
└──────────────────────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Step 7: ATTESTOR RELEASES BTC               [outside our code]        │
│                                                                       │
│ Attestors watch Canton for burn events.                               │
│ When they see the CBTCWithdrawAccount_Withdraw tx, they send BTC      │
│ from the bridge reserve to destinationBtcAddress.                     │
│ Takes minutes to an hour depending on Bitcoin conditions.             │
│ Oranj does not track this — check destination on block explorer.  │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Why `disclosedContracts` are required

This trips up anyone who's new to Canton.

The bridge contracts (`da_rules`, `wa_rules`, all five token-standard contracts) are owned by BitSafe. The user's party has never interacted with them — they're not in the user's local contract store. Canton's validator would normally reject a transaction that references contracts it can't see.

`disclosedContracts` is the solution: you ship the full contract data (template ID, contract ID, the `created_event_blob` — an opaque base64 blob that proves the contract exists on-ledger) as part of the transaction submission. The validator accepts it as proof.

**The coordinator response gives you everything you need.** Every contract it returns has all three fields. Map them to the Loop SDK's shape:

```ts
{
  templateId:       c.template_id,
  contractId:       c.contract_id,
  createdEventBlob: c.created_event_blob,
  synchronizerId:   ""   // empty string, not null
}
```

Forgetting to include a contract → "contract not found" rejection. Including a stale contract blob → "contract key mismatch" rejection. Fetching fresh from the coordinator each time avoids both.

---

## Loop SDK internals

Worth knowing when debugging:

- `provider.submitTransaction()` sends a `RUN_TRANSACTION` WebSocket message to `wss://devnet.cantonloop.com/api/v1/.connect/pair/ws/<ticketId>`.
- Loop's backend receives it, shows the approval popup in the user's wallet app, signs with the user's key, and submits to Canton via Loop's own participant node.
- **The Five North validator is not involved in this path.** Loop routes to wherever the user's party is hosted on Loop's infrastructure.
- `provider.getActiveContracts()` → `GET https://devnet.cantonloop.com/api/v1/.connect/pair/account/active-contracts?templateId=...`
- `provider.getHolding()` → `GET https://devnet.cantonloop.com/api/v1/.connect/pair/account/holding`

All Loop calls use the user's `auth_token` (session token from the WebSocket handshake), not the Authentik m2m JWT.

---

## Authentication reference

| Where | Auth type | Token source | What it can do |
|---|---|---|---|
| `lib/canton.ts` (server) | Bearer JWT | Authentik `client_credentials` | Read ledger state on Five North node |
| `lib/bitsafe.ts` (client/server) | None | — | Fetch public bridge contracts/addresses |
| `provider.submitTransaction()` (browser) | Loop session | Loop WebSocket handshake | Submit transactions actAs user |
| `provider.getActiveContracts()` (browser) | Loop session | Loop WebSocket handshake | Query user's active contracts |

The Authentik JWT is cached in-memory on the server with a 5-minute refresh buffer before the 8-hour expiry (`lib/auth.ts`). A single-flight pattern prevents multiple simultaneous refresh requests.

---

## Coordinator endpoints

All public, no auth. All POST with `Content-Type: application/json`.

| Endpoint | Request body | Response | Used in |
|---|---|---|---|
| `/app/get-account-contract-rules` | `{"chain": "canton-devnet"}` | `{da_rules, wa_rules}` | Mint step 1, Redeem step 1 |
| `/app/get-bitcoin-address` | `{"id": "<depositAccountCid>", "chain": "canton-devnet"}` | `{"address": "bcrt1p..."}` | Mint step 4 |
| `/app/get-token-standard-contracts` | `{"chain": "canton-devnet"}` | 5 named contracts | Redeem step 4 |

Chain values: `canton-devnet` / `canton-testnet` / `canton-mainnet`

Coordinator hosts:

| Network | Host | Status |
|---|---|---|
| devnet | `https://devnet.dlc.link/attestor-2` | Intermittently down (Cloudflare 1016) |
| testnet | `https://testnet.dlc.link/attestor-1` | Working |
| mainnet | `https://mainnet.dlc.link/attestor-1` | Untested |

---

## Canton Ledger API endpoints (server-side only)

Used by `/api/canton/*` routes. All require Bearer JWT from Authentik. Base URL: `https://ledger-api.validator.devnet.warpx.fivenorth.io`

| Endpoint | Method | Purpose |
|---|---|---|
| `/v2/state/ledger-end` | GET | Current ledger offset (returns JSON number, not string) |
| `/v2/packages` | GET | List installed DAR package hashes (opaque — no names available in this Canton version) |
| `/v2/state/active-contracts` | POST | Query contracts by template or interface ID |
| `/v2/commands/submit-and-wait-for-transaction-tree` | POST | Submit commands as the app party (not used for user transactions) |

---

## UTXO limits

| Threshold | Behavior |
|---|---|
| < 8 holdings | No warning |
| 8–9 holdings | Amber warning banner on mint page |
| 10 holdings | Mint blocked with error message; user must redeem first |

Holdings are individual `Holding` contracts on Canton. Each mint may create one new holding. There's no automatic consolidation — users must redeem to reduce holding count.

---

## Network configuration

One env var drives everything. Set `NEXT_PUBLIC_NETWORK=devnet|testnet|mainnet` in `.env.local`. All URLs, party IDs, BTC address prefixes, and the `chain` string sent to the coordinator are derived from this single value in [`lib/constants.ts`](../lib/constants.ts).

---

## Project structure

```
Oranj/
├── app/
│   ├── page.tsx                  ← Dashboard (balance + on-ledger activity)
│   ├── mint/page.tsx             ← Mint flow state machine
│   ├── redeem/page.tsx           ← Redeem flow state machine
│   ├── send/page.tsx             ← Send cBTC to another Canton party
│   ├── receive/page.tsx          ← QR + incoming offers list w/ Accept
│   └── api/
│       ├── auth/token/           ← Debug: JWT cache status
│       ├── canton/
│       │   ├── ledger-end/       ← Debug: current ledger offset
│       │   ├── packages/         ← Debug: installed DAR hashes
│       │   └── holdings/         ← m2m holdings read for a party
│       ├── activity/             ← GET on-ledger activity for the user's party
│       ├── transfers/            ← create / accept / pending (P2P cBTC)
│       └── mint/
│           ├── create-deposit-account/   ← create DA on Canton
│           ├── list-deposit-accounts/    ← recover existing DA
│           ├── bitcoin-address/          ← coordinator BTC address
│           └── process-transfers/        ← MINT PROCESSOR entry (dual auth)
│
├── components/
│   ├── TopNav.tsx                ← Nav: Dashboard, Mint, Send, Receive, Redeem
│   ├── ThemeToggle.tsx           ← Light/dark toggle (next-themes)
│   ├── WalletConnectButton.tsx   ← Loop connect/disconnect
│   └── ...
│
├── hooks/
│   ├── useWallet.tsx             ← Loop init, autoConnect, session recovery
│   ├── useBalance.ts             ← balance + 30s background poll (visibility-aware)
│   └── useTransfers.ts           ← /api/activity poll (mint/send/receive/redeem rows)
│
├── lib/
│   ├── constants.ts              ← Network config (single source of truth; warpxPartyId here)
│   ├── auth.ts                   ← Authentik m2m JWT with in-memory cache [server-only]
│   ├── canton.ts                 ← Five North ledger API client [server-only]
│   ├── bitsafe.ts                ← DLC.link coordinator client
│   ├── mint.ts                   ← Mint UI flow: deposit accounts + BTC address
│   ├── redeem.ts                 ← Redeem flow: withdraw accounts + burn
│   ├── transfer.ts               ← Server-side P2P transfer helpers (create/accept/list)
│   ├── mint-processor.ts         ← MINT PROCESSOR: warpx→user delivery [server-only]
│   ├── mint-processor-logic.ts   ← Pure decision logic (unit-tested, no DB/network)
│   ├── mint-processor-logic.test.ts ← node:test unit tests (`npm test`)
│   ├── activity.ts               ← Derive activity rows from the update stream [server-only]
│   ├── supabase/                 ← server + browser Supabase clients
│   ├── format.ts                 ← BTC/satoshi math (BigInt), party ID truncation
│   ├── types.ts                  ← Shared TypeScript types
│   └── utils.ts                  ← shadcn cn() helper
│
├── supabase/migrations/
│   ├── 001_party_mappings.sql
│   ├── 002_deposit_accounts.sql
│   ├── 003_mint_processor.sql            ← mint_transfers + mint_processor_state
│   └── 004_mint_processor_hardening.sql  ← state machine, lease lock, atomic claim RPCs
│
├── scripts/
│   └── process-mints.sh          ← Cron worker: curl process-transfers w/ CRON_SECRET
│
└── docs/
    ├── TECH.md                   ← This file
    └── YAAK_REFERENCE.md         ← Raw API request/response examples
```

---

## Common failure modes

### `/api/auth/token` returns 500
**Cause**: Missing or wrong Authentik credentials.  
**Fix**: Check `.env.local` has all three `KEYCLOAK_*` values. Restart the dev server.

### Coordinator returns 530 / DNS error / Cloudflare 1016
**Cause**: DLC.link coordinator is down (their infrastructure, not ours).  
**Verify**:
```bash
curl -X POST https://testnet.dlc.link/attestor-1/app/get-account-contract-rules \
  -H "Content-Type: application/json" \
  -d '{"chain":"canton-testnet"}'
```
If testnet responds and devnet doesn't → devnet coordinator outage, contact DLC.link.

### Loop popup never appears
**Causes (in order of likelihood)**:
1. Loop wallet not connected — check top-right button
2. Browser blocked the popup — check browser popup settings
3. Stale session — disconnect and reconnect
4. If reconnect fails: open browser DevTools → Application → Local Storage → clear `loop_connect` for `localhost:3000` → reload

### Loop popup appears, "transaction rejected"
**Causes (in order of likelihood)**:
1. **Missing Minter/Holder credential** — Your party doesn't have the BitSafe credential on-ledger. This is the most common reason. Contact BitSafe to get your party credentialed.
2. **cBTC DARs not installed** — The Canton templates for cBTC don't exist on the participant. Ask Five North to install them.
3. **Stale `da_rules` / `wa_rules` contract** — These rotate occasionally. The app fetches fresh each time; if it's cached anywhere, clear it.
4. **Wrong `actAs`** — Should always be the user's own party ID from `provider.party_id`. Check `useWallet.tsx` if this is wrong.

### Holdings query returns 403
**Cause**: The server-side m2m JWT cannot `actAs` user parties — Canton rejects it.  
**This is expected behavior.** User-side reads must go through `provider.getActiveContracts()` via Loop, not through `lib/canton.ts`. The `/api/canton/holdings` route only works for the app's own party.

### Balance shows 0 after a confirmed mint
Remember the two stages: BitSafe mints to **warpx**, then the **processor** delivers warpx → user. A 0 balance can fail at either stage.

**Check, in order:**
1. Did the BTC transaction actually get 6 confirmations? Verify on mempool.space or a regtest block explorer.
2. Has it been at least 2 minutes after confirmation 6? (Attestor processing takes 60–120 sec.)
3. **Did BitSafe mint to warpx yet?** Query the warpx party's active Holdings (ACS). If there's a new Holding on warpx, stage 1 is done and the problem is stage 2 (the processor). If not, it's still a bridge/attestor issue → escalate to BitSafe with the deposit account contract ID.
4. **Did the processor run?** Trigger it: `POST /api/mint/process-transfers` (with `CRON_SECRET` bearer, or from a logged-in browser tab). Check the JSON result — `mintsFound`/`transferred`. Inspect the `mint_transfers` row for this holding: `status` and `error` tell you where it's stuck.
   - `status=failed`, error "Could not resolve user…" → the deposit account isn't mapped in Supabase `deposit_accounts`, OR it's a subsequent mint and the rolled-forward `id` match failed. Confirm the DA row exists.
   - `status=offer_created` → Phase 1 done, Phase 2 (accept) didn't complete. Re-run the processor; it accepts the recorded offer (never recreates).
   - `errors: ["already running (lease held)"]` → another run holds the lease; wait and retry.
5. If warpx has the Holding but the processor keeps failing, gather the holding contract ID + the `mint_transfers.error` and debug from there.

### Mint processor created/left a pending TransferOffer (cBTC not delivered)
If a transfer's Phase 1 succeeded but Phase 2 never did, the cBTC sits in a pending TransferOffer to the user. Re-running `process-transfers` is safe and will accept the recorded offer (the offer CID is persisted in `mint_transfers.offer_contract_id` before accept, so no duplicate is created). A holding that ends up back on warpx (e.g. a cancelled offer) is re-seen on the next run because the processor is holding-based.

### BTC sent, deposit account created, but no cBTC after 2 hours
This is a bridge-side issue. The on-chain part worked; the attestors didn't pick it up. Gather:
- The deposit account contract ID (shown on the mint page)
- The Bitcoin transaction ID
- The timestamp

Contact BitSafe support with these three pieces of information.

---

## Debugging endpoints

While the dev server is running:

```bash
# Check JWT cache status (is Authentik working?)
curl http://localhost:3000/api/auth/token

# Verify the Five North ledger is reachable
curl http://localhost:3000/api/canton/ledger-end

# List installed DAR packages (by opaque hash; names not available in this Canton version)
curl http://localhost:3000/api/canton/packages

# Verify coordinator is up (testnet)
curl -X POST https://testnet.dlc.link/attestor-1/app/get-account-contract-rules \
  -H "Content-Type: application/json" \
  -d '{"chain":"canton-testnet"}'
```

---

## Source hierarchy — when docs disagree

1. **[DLC.link Yaak collection](https://github.com/DLC-link/api-collections-public)** — canonical wire format. Always wins.
2. **[BitSafe developer docs](https://docs.bitsafe.finance/developers/cbtc-minting-and-burning)** — narrative + examples. Matches Yaak.
3. **cbtc-lib Rust source** — one consumer implementation; may add optional fields. Cross-reference only.
4. **This repo's docs** — engineer notes; can be stale. Treat as secondary.

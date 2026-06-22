# OranjSwap — WBTC↔CBTC HTLC + Canton CBTC↔CC Swaps

> **Single source of truth for this repo.** What the app supports, where the
> trust boundaries are, and what must be true before a deployment is safe.
> Task list: [`TASKS.md`](./TASKS.md). Agent/runtime notes: [`CLAUDE.md`](./CLAUDE.md).

OranjSwap now supports two swap families:

- **Cross-chain HTLC swaps:** WBTC on Base/Base Sepolia ↔ CBTC on Canton.
- **Same-Canton C2C swaps:** CBTC ↔ CC on Canton.

Both swap families support **participant-managed/email parties** and **Loop wallet
parties**, but those two wallet modes have different authority and custody
properties. The app routes all new swap inventory through a funded **settlement
vault party** configured by `CANTON_SWAP_SETTLEMENT_PARTY`.

Post-audit status: the release-blocking findings from the June 2026 swap audit
have been remediated in code, but production rollout still requires the database
migrations, exact deployment env, funded smoke swaps, and recovery drills to match
the target network. See:

- [`docs/SWAP-SECURITY-AUDIT-README-2026-06-21.md`](./docs/SWAP-SECURITY-AUDIT-README-2026-06-21.md)
- [`docs/SWAP-QUOTE-DESIGN.md`](./docs/SWAP-QUOTE-DESIGN.md)
- [`docs/SECURITY-AUDIT-2026-06-21.md`](./docs/SECURITY-AUDIT-2026-06-21.md)

---

## Table of contents

1. [Swap families at a glance](#1-swap-families-at-a-glance)
2. [Cross-chain HTLC swaps](#2-cross-chain-htlc-swaps)
3. [Canton-to-Canton C2C swaps](#3-canton-to-canton-c2c-swaps)
4. [Wallet modes and trust model](#4-wallet-modes-and-trust-model)
5. [Quotes, floors, and price safety](#5-quotes-floors-and-price-safety)
6. [Fees and swap parameters](#6-fees-and-swap-parameters)
7. [Order lifecycle, daemons, and recovery](#7-order-lifecycle-daemons-and-recovery)
8. [Database migrations and deployment invariants](#8-database-migrations-and-deployment-invariants)
9. [On-chain / on-ledger building blocks](#9-on-chain--on-ledger-building-blocks)
10. [Running locally](#10-running-locally)
11. [Deploying on Railway](#11-deploying-on-railway)
12. [Repo layout and deeper docs](#12-repo-layout-and-deeper-docs)

---

## 1. Swap families at a glance

| Family | Assets | Core mechanism | Wallet modes | Atomicity boundary |
| --- | --- | --- | --- | --- |
| Cross-chain HTLC | WBTC ↔ CBTC | EVM `HTLCEscrow` + Canton `HtlcLock` or standard transfer path | Email + Loop | Economic HTLC atomicity across two ledgers |
| Same-Canton C2C | CBTC ↔ CC | Fixed-amount Canton transfer offers settled by the vault | Email + Loop | Single Canton update when direct; otherwise durable pending counter offer |

The important distinction is:

- A **single Canton transaction** is all-or-nothing.
- A **cross-chain swap** can never commit atomically on EVM and Canton at the same
  instant. HTLCs provide economic atomicity through a shared hashlock, staggered
  timelocks, finality checks, and refund paths.
- The **database/orchestrator** must never lie about external state. Recent audit
  fixes moved irreversible steps behind compare-and-swap state transitions,
  deterministic command IDs, and serialized inventory-reservation RPCs.

### Core design decisions

The app intentionally uses different settlement models for different wallet
constraints:

1. **Email / participant-managed cross-chain swaps use the custom Canton HTLC.**
   These parties are hosted on the WarpX participant, where the `cbtc-htlc` DAR is
   uploaded/vetted and the backend can submit with the user's `CanActAs`
   authority. Canton enforces the hashlock, timelock, allocation binding, and
   claim/refund controllers on-ledger.
2. **Loop cross-chain swaps do not use the custom Canton HTLC.** Loop's
   participant cannot currently vet arbitrary third-party DARs. Explicit
   disclosure gives visibility to a contract, but it does not let Loop interpret
   or confirm choices from an unvetted package. Loop users therefore sign only
   standard Token Standard / Utility choices, and OranjSwap treats these flows as
   trust-minimized venue settlement, not fully trustless HTLC settlement.
3. **C2C swaps use same-ledger settlement instead of HTLCs.** CBTC and CC are both
   Canton assets, so the strongest v1 path is a fixed-amount offer/fill where the
   vault accepts the user sell leg and delivers the counter leg in one Canton
   submit. When the counter leg is direct, the fill is atomic at the Canton
   transaction boundary.
4. **The settlement vault is intentionally preapproval-free.** The user sell leg
   must create a pending offer to the vault; if vault preapproval auto-accepts the
   sell leg before the counter leg is included, the app loses the atomic
   offer-plus-counter fill shape. User receive parties should have preapproval on
   for the assets they receive, so the counter leg can direct-deliver inside the
   fill transaction.

---

## 2. Cross-chain HTLC swaps

Cross-chain swaps bind both legs to the same 32-byte secret:

```text
hashLock H = keccak256(secret s)

EVM leg                         Canton leg
WBTC HTLC                       CBTC HtlcLock or standard transfer path
lock / claim / retake           lock / claim / refund or deliver
```

The browser generates `s`; the order stores only `H`. The secret is revealed only
when the user claims their receive leg.

Canonical test vector: secret `the-cross-chain-secret-32bytes!!` →  
`H = 0x94277b389401042e35f8709846050797955e2b321bee500555c2fbdc2f4e9903`.

### EVM → Canton: buy CBTC with WBTC

| Step | Who | What |
| --- | --- | --- |
| 1 | User | Generate `s`; create order with `H` |
| 2 | Vault/solver | Accept order after serialized CBTC-float reservation |
| 3 | User | Approve + lock WBTC in `HTLCEscrow` |
| 4 | Vault/solver | Lock or prepare CBTC counter leg |
| 5 | User | Claim CBTC, revealing `s` |
| 6 | HTLC daemon | Read `s` and claim WBTC on EVM |

Participant-managed/email users receive CBTC through the on-ledger `HtlcLock.Claim`
path. Loop users receive through a standard Canton transfer after the backend
verifies the revealed preimage; this is trust-minimized, not fully trustless.

### Canton → EVM: sell CBTC for WBTC

| Step | Who | What |
| --- | --- | --- |
| 1 | User | Generate `s`; create order with `H` |
| 2 | Vault/solver | Accept after WBTC exposure is reserved |
| 3 | User / backend | Lock or transfer CBTC on Canton |
| 4 | HTLC daemon | Lock WBTC in `HTLCEscrow` for the user's EVM address |
| 5 | User | Claim WBTC on EVM, revealing `s` |
| 6 | HTLC daemon | Claim CBTC on Canton using the EVM reveal |

Email users use the custom `HtlcLock` path. Loop sellers use a standard transfer
to the vault, so the vault is temporarily custodian of the CBTC during settlement.
The reverse WBTC leg is reserved before user Canton funds are locked or custodied.

### Why the Loop path is deliberately weaker

The custom `HtlcLock` template is only used where every confirming participant can
interpret and vet the package. Loop currently supports the standard Splice /
Utility packages used by the Token Standard, but not third-party package vetting
for `cbtc-htlc`. Passing a disclosed contract is not enough: disclosure solves
visibility, while package vetting is required for interpretation and confirmation.

Therefore:

- **Email / managed:** use the custom HTLC and claim/refund on-ledger.
- **Loop buyer:** backend verifies the preimage and delivers CBTC with a standard
  transfer. This is a delivery obligation backed by recovery logic, not a Loop-side
  custom `HtlcLock.Claim`.
- **Loop seller:** user transfers CBTC to the vault with standard choices; WBTC is
  reserved before that custody step and refunds are deterministic if settlement
  cannot proceed.

If Loop or 5N later supports vetting `cbtc-htlc`, the Loop route should be migrated
to the same custom HTLC path as managed parties.

### HTLC secret vault

The secret is held client-side in `localStorage` under `oranj.htlc.secrets.v3`
using AES-GCM (`lib/secret-vault.ts`).

| Anchor | Wallet mode | Unlock |
| --- | --- | --- |
| `managed-session` | Email / participant-managed | Active Supabase session + matching Canton party |
| `loop-wallet` | Loop | Connected Loop party + matching public key; `signMessage` is a consent gate |

Design constraints:

- The server must not receive `s` before claim.
- The vault entry must survive refresh and `/orders` recovery.
- Wrong Supabase session, Loop wallet, or MetaMask address must not decrypt/claim.
- Same-origin XSS can still access browser-held material; CSP and Trusted Types
  reduce that risk but do not make browser storage a hardware boundary.

---

## 3. Canton-to-Canton C2C swaps

C2C swaps trade **CBTC ↔ CC** on the Canton ledger. They do not use the HTLC secret.
The order binds fixed input, output, `minOut`, quote expiry, user party, wallet mode,
and the settlement vault party.

### Managed/email C2C

Participant-managed parties can be settled by the backend with the required
`actAs` authority. The desired path is:

```text
create quote → create order → user sell offer to vault →
vault accepts sell offer + directly delivers counter asset in one Canton update
```

The service refuses to consume the user sell leg if the counter leg would only
create a pending offer for a managed user. That keeps managed C2C atomic at the
Canton transaction boundary.

### Loop C2C

Loop users sign the sell leg in Loop. The vault then fills:

```text
Loop user signs sell offer to vault →
daemon accepts that offer and sends/creates the counter leg →
user accepts counter offer if direct delivery did not auto-settle
```

The fill transaction atomically consumes the user sell offer and creates or
delivers the counter leg. If the counter leg is a pending offer, final receipt
depends on the user accepting it in Loop. The service persists the counter-offer
creation offset and permanent receipt proof before any reissue, so an old accepted
offer cannot be mistaken for a failed delivery and paid twice.

### C2C preapproval rules

Preapproval is directional: it affects the **receiver** of a transfer.

| Party / leg | Desired preapproval state | Reason |
| --- | --- | --- |
| User sell leg receiver: settlement vault | **OFF** for CC and CBTC | Forces a pending offer to the vault. The daemon can then accept that offer and include the counter leg in the same Canton submit. |
| User counter-leg receiver: email / managed party | **ON** for the asset being received | Lets the vault direct-deliver the counter asset in the fill transaction; managed C2C refuses pending counter delivery. |
| User counter-leg receiver: Loop party | **ON where Loop supports it** | Makes Loop C2C final in the fill transaction. If absent, the fill creates a pending counter offer that the Loop user must accept later. |
| Network-fee receiver | **ON for CC** | Required for direct CC fee collection and fee proof verification. |

Do **not** enable CC or CBTC preapproval on `CANTON_SWAP_SETTLEMENT_PARTY`.
Scripts and readiness checks intentionally fail closed when the user sell leg
would auto-settle into the vault.

### C2C order states

```text
open → settling / filling → user_locked → filled
                         ↘ expired / failed / cancelled
```

Important fields:

- `settlementParty`: current vault party.
- `floatReserved`: vault inventory reservation held during settlement.
- `settlementUpdateId`: Canton update that consumed the sell leg / delivered or
  offered the counter leg.
- `counterLegCreatedOffset` + `counterReceiptUpdateId`: durable proof for counter
  offer recovery.
- `networkFeeAccountingPending`: outbox marker for fee-booking recovery.

---

## 4. Wallet modes and trust model

| | Email / participant-managed | Loop wallet |
| --- | --- | --- |
| Sign-in | Supabase OTP | Loop API key/session + wallet popups |
| Canton party | Hosted on the WarpX participant | Hosted on Loop's participant |
| Canton signing | Backend via `CanActAs` | User signs in Loop |
| Cross-chain forward | On-ledger `HtlcLock.Claim` | Backend hash gate + standard transfer |
| Cross-chain reverse | On-ledger `HtlcLock` | Vault custody during settlement |
| C2C | Backend submit with user + vault authority | User signs sell leg; vault daemon fills |

Trust model by flow:

| Flow | Current property | Limitation |
| --- | --- | --- |
| Cross-chain, email | Economic HTLC atomicity | Requires configured EVM finality, active daemon, and refund/watchtower paths |
| Cross-chain, Loop buyer | Trust-minimized venue delivery obligation | Preimage reveal cannot be one atomic Canton/EVM transaction |
| Cross-chain, Loop seller | Custodial during settlement | Vault temporarily controls CBTC; WBTC is reserved first and refunds are deterministic |
| C2C, managed | Atomic direct Canton delivery | Quote/reference checks and DB reservation happen before submit |
| C2C, Loop | Atomic sell-consumption + counter creation/delivery | User may still need to accept a pending counter offer |

The EVM leg stays trustless in both wallet modes: `HTLCEscrow.sol` enforces
`keccak256(preimage) == hashLock` and `retake` after timelock.

Loop parties cannot currently use the custom `HtlcLock` template on their external
participant. That is a Canton authority/package-vetting boundary, not a UI choice.

---

## 5. Quotes, floors, and price safety

The quote is a guaranteed floor, not just display math. The UI should say
**“You receive at least X”** and show source, age, expiry, and stale/indicative notes.

### Cross-chain WBTC↔CBTC

Quote math:

- EVM → Canton: `cbtcOut = wbtcIn × WBTC/BTC × (1 − platformFee)`
- Canton → EVM: `wbtcOut = cbtcIn ÷ WBTC/BTC × (1 − platformFee)`

Controls:

- CoinGecko + Binance WBTC/BTC cross-check.
- 30s fresh cache; max 90s bounded stale serve; then refuse to quote.
- 2% WBTC/BTC depeg breaker.
- 60s quote TTL.
- Server-side create re-quote with tight amount tolerance.
- Settlement-time quote floor before solver value is locked or delivered.

### Same-Canton CBTC↔CC

Quote source:

- Tradecraft fixed-input quote is the executable market price input.
- The service independently sanity-checks Tradecraft against `amuletPrice × BTC/USD`.
- Mainnet default sanity band is tight; devnet is wider because devnet C2C still
  references mainnet Tradecraft pricing and is labeled indicative.
- Settlement re-quotes and enforces `minOut` plus a bounded settlement slippage floor.

### Deferred quote work

Dutch auction / solver competition is intentionally deferred for v1. The current
production target is short-TTL fixed-floor quotes with strict refuse-on-bad-price
behavior.

---

## 6. Fees and swap parameters

There are three separate cost categories:

| Cost | Paid by | Notes |
| --- | --- | --- |
| Platform spread | User receives less than fair mid | Configured by `PLATFORM_FEE_BPS`; embedded in output amount |
| EVM gas | EVM transaction sender | ETH on Base/Base Sepolia |
| Canton traffic / CC | Party submitting Canton traffic | Managed fees can be quoted/collected by the app; Loop traffic is paid by Loop wallet |

### Platform fee

Default server fee: `PLATFORM_FEE_BPS=100` (1%), with client preview using
`NEXT_PUBLIC_FEE_BPS`. The authoritative value comes from the server quote.

The fee is not a separate transfer. It is embedded in the fixed receive amount:
the vault/solver pays less output than mid-market and receives the full input leg.

### Canton network fee

For managed/email flows, `NETWORK_FEE_ENABLED=1` enables order-bound CC network-fee
collection. The fee is:

- estimated at quote/create time;
- capped by configured notional bounds;
- revalidated before settlement/lock/claim;
- collected in the same relevant Canton transaction where possible;
- recorded through a durable accounting outbox.

When `NETWORK_FEE_ENABLED=0`, the backend does not bind a CC fee to new orders,
does not append CC fee-transfer commands, does not run the high-fee notional
guard, and settlement/claim/lock revalidation returns a disabled zero-fee
estimate. Existing historical orders may still show their stored fee metadata in
history, but disabled runtime config will not collect a new fee leg.

`NETWORK_FEE_QUOTE_PREVIEW=1` is preview-only. It may estimate and display the
would-be Canton traffic fee, but it does not collect CC and it does not block
small swaps on the max-bps guard. Keep it `0` when the fee row should disappear
entirely from quotes and review screens.

`NEXT_PUBLIC_NETWORK_FEE_ENABLED` controls the client-side display path. Set it
to the same value as `NETWORK_FEE_ENABLED`; if the server says a fee is actually
being charged, the review UI intentionally still shows it even if the public flag
is misconfigured, so users never sign a hidden fee.

`NETWORK_FEE_BUFFER_BPS` is basis points added to the raw Canton traffic estimate:
`1000` = +10%, `1500` = +15%. Inline comments in env files are supported.

In local dev, restart `npm run dev:devnet` / `npm run dev:mainnet` after changing
fee flags. The dev wrapper regenerates `.env.development.local`; stale values in
that file can otherwise override `.env.local` in Next/Turbopack workers.

For Loop flows, the separate Oranj-side CC fee prepayment was removed. Loop wallet
traffic cost is handled by Loop signing/traffic mechanics, and platform costs are
covered by the spread. This avoids the old “fee paid but swap cannot proceed”
failure mode.

Useful knobs:

- `PLATFORM_FEE_BPS`
- `NEXT_PUBLIC_FEE_BPS`
- `NETWORK_FEE_ENABLED`
- `NEXT_PUBLIC_NETWORK_FEE_ENABLED`
- `NETWORK_FEE_QUOTE_PREVIEW`
- `NETWORK_FEE_RECEIVER_PARTY`
- `NETWORK_FEE_BUFFER_BPS`
- `NETWORK_FEE_RESERVE_CC`
- `NETWORK_FEE_MAX_BPS_OF_NOTIONAL`

### Timelocks and windows

- HTLC default expiration: 4h.
- HTLC minimum Canton swap window: 2h.
- HTLC leg gap: about 20m minimum between shorter and longer timelocks.
- Cross-chain quote TTL: 60s, separate from the HTLC refund window.
- Loop C2C order TTL: 15m to sign/fill.
- Loop counter offer TTL: 24h.

---

## 7. Order lifecycle, daemons, and recovery

### HTLC statuses

```text
open → accepted → main_locking → main_locked → counter_locking → counter_locked
                                      ↘ refunding → refunded
counter_locked → counter_claimed → main_claimed
```

The transient states are intentional:

- `main_locking` / `counter_locking` claim the right to perform irreversible
  ledger/EVM work.
- `refunding` is durable and re-entrant, so a crash after submit does not strand
  an order as terminal-but-unpaid.

### C2C statuses

```text
open → settling / filling → user_locked → filled
                         ↘ expired / failed / cancelled
```

### Required daemons

Run the daemon that matches the swap family being tested:

```bash
# Cross-chain HTLC WBTC↔CBTC
npm run solver:htlc
npm run solver:htlc:mainnet

# Loop C2C CBTC↔CC fills/recovery
npm run solver:canton-swap
npm run solver:canton-swap:mainnet
```

Do **not** use `npm run solver:watch` for HTLC or C2C. That is the legacy OIF
solver watcher.

The HTLC daemon:

1. accepts/advances HTLC orders;
2. locks counter legs after finality/quote checks;
3. reads public preimages from Canton/EVM claims;
4. claims the opposite leg;
5. calls auto-refund and cleanup routes.

The C2C daemon:

1. fills Loop sell offers;
2. reconciles pending or committed counter legs;
3. reissues expired counter offers only after complete receipt-proof scans;
4. drains fee-accounting outbox work.

Recovery design:

- irreversible Canton commands use deterministic command IDs;
- duplicate-command committed responses are treated as committed and reconciled;
- EVM settlement evidence requires configured confirmations and block-hash
  revalidation before irreversible Canton actions;
- full-row lifecycle overwrites have been replaced with CAS/state-specific writes;
- stale cancel/expire paths must not clear committed contract IDs or update IDs.

### Hardening backlog

The core protocol design is now acceptable for v1. The next improvements should
focus on proving and operating the design rather than changing the settlement
model:

1. **State-machine/property tests:** assert no double-settlement, no custody
   evidence reuse, no reveal without durable delivery obligation, no refund after
   claim, and no accepted order without reserved inventory.
2. **Crash-recovery drills:** kill the web/daemon after each external commit point
   and verify deterministic-command recovery converges without duplicate payment
   or stranded funds.
3. **Independent watcher:** run a second read-only/watchtower process for expired
   HTLC refunds, public preimage discovery, pending Loop counter offers, and stuck
   accounting outbox rows.
4. **Loop settlement commitments:** before any Loop custody or preimage reveal,
   persist/sign the exact order terms and venue delivery obligation, then surface
   that evidence in `/orders`.
5. **Maximize direct C2C counter delivery:** keep user receive preapprovals enabled
   for CC and CBTC, especially for Loop, while keeping the settlement vault
   preapproval-free.

Do not prioritize Dutch auctions or solver competition until these controls have
production evidence from funded smoke tests.

---

## 8. Database migrations and deployment invariants

Apply all Supabase migrations in order before running the post-audit code on a
network. The audit-critical range is **029–039**. There is no `033` migration file
in this branch; apply every migration file that exists.

| Migration | Purpose |
| --- | --- |
| `029_htlc_refunding_and_float_reservation.sql` | HTLC `refunding` state + atomic forward CBTC reservation |
| `030_canton_swap_atomic_float_reservation.sql` | Atomic C2C vault-float reservation |
| `031_htlc_lifecycle_and_custody_evidence.sql` | HTLC lock states + Loop custody baseline/evidence |
| `032_canton_swap_counter_receipt_proof.sql` | Counter-offer creation offset + receipt proof |
| `034_distributed_api_rate_limits.sql` | Shared Postgres-backed API rate limits |
| `035_reverse_htlc_evm_float_reservation.sql` | Reverse HTLC WBTC reservation during counter lock |
| `036_network_fee_accounting_outbox.sql` | Durable network-fee accounting outbox |
| `037_htlc_forward_reservation_states.sql` | Keep forward CBTC reserved through locking states |
| `038_reverse_htlc_prelock_reservation.sql` | Reserve WBTC before user Canton leg is locked |
| `039_htlc_custody_evidence_uniqueness.sql` | One custody evidence CID can prove only one HTLC order |

Release blockers if missing:

- `accept_htlc_order_with_float_reservation(...)` must exist and be executable by
  the service role.
- `reserve_canton_swap_float(...)` must exist.
- `reserve_reverse_htlc_evm_float_before_main_lock(...)` and
  `reserve_reverse_htlc_evm_float(...)` must exist.
- `consume_api_rate_limit(...)` and `api_rate_limits` must exist.
- `network_fee_ledger` must have the settlement-update uniqueness protection.
- `htlc_orders.counter_transfer_offer_cid` uniqueness must be present.

Other deployment invariants:

- `CANTON_SWAP_SETTLEMENT_PARTY` and `NEXT_PUBLIC_CANTON_SWAP_SETTLEMENT_PARTY`
  must point to the funded vault for that network.
- `SOLVER_EVM` / `NEXT_PUBLIC_SOLVER_EVM` must match the EVM hot wallet used by
  the HTLC daemon.
- `API_BASE` on each daemon must point to the web app built for the same network.
- `HTLC_DAEMON_SECRET` must match web and daemon services.
- `CRON_SECRET` should be a strong secret and is compared with timing-safe auth.
- Do not mix devnet Loop parties with mainnet web/daemon env.

---

## 9. On-chain / on-ledger building blocks

| Component | Location | Role |
| --- | --- | --- |
| EVM HTLC | `contracts/src/HTLCEscrow.sol` | WBTC `lock` / `claim` / `retake` |
| Canton HTLC DAR | `canton-htlc/daml/CbtcHtlc.daml` | `HtlcLock` wraps Allocation with hash + timelock |
| HTLC service | `lib/htlc-service-singleton.ts` | Cross-chain order lifecycle and on-ledger ops |
| C2C service | `lib/canton-swap-service.ts` | CBTC↔CC order lifecycle and recovery |
| C2C settlement | `lib/canton-swap-settle.ts` | Canton transfer-offer fill/reissue/receipt proof |
| Quote engines | `lib/htlc-quote.ts`, `lib/canton-quote.ts` | Price, fee, freshness, and floor enforcement |
| Fee engine | `lib/canton-network-fee.ts` | Managed network-fee estimate/collection/accounting |
| Secret vault | `lib/secret-vault.ts` | Client-side HTLC preimage storage |
| UI | `app/swap/page.tsx`, `app/orders/page.tsx` | Swap, claim, history, and recovery UX |
| Daemons | `swap-solver/src/*.mts` | HTLC and C2C background workers |

DevNet references:

| Thing | Value |
| --- | --- |
| EVM HTLCEscrow | `0x1b19a764ab35db1833ae2137544dd84ba5bf8cf1` |
| Mock WBTC | `0x8d587e55236d1d4898e85711f709e53e657413ee` |
| CBTC HTLC DAR | `cbtc-htlc-hardened v0.1.0` |

---

## 10. Running locally

Environment file layout is documented in [`docs/ENV.md`](./docs/ENV.md). Network
values belong in `.env.devnet` or `.env.mainnet`; `.env.local` should be overrides
only.

First-time setup:

```bash
cp .env.devnet.example .env.devnet
cp .env.mainnet.example .env.mainnet
cp swap-solver/.env.htlc-devnet.example swap-solver/.env.htlc-devnet
cp swap-solver/.env.htlc-mainnet.example swap-solver/.env.htlc-mainnet
```

Devnet cross-chain HTLC:

```bash
npm run dev:devnet
npm run solver:htlc
```

Devnet Loop C2C:

```bash
npm run dev:devnet
npm run solver:canton-swap
```

Mainnet smoke tests use real funds:

```bash
npm run dev:mainnet
npm run solver:htlc:mainnet
npm run solver:canton-swap:mainnet
```

Validation commands:

```bash
npm run typecheck
npm test
npm run lint
npm run check-swap-preapprovals:devnet -- '<vault-party>' '<user-party>'
```

---

## 11. Deploying on Railway

Use separate web and daemon services per network. Parallel devnet/mainnet services
are safer than flipping one deployment.

| Service | Root directory | Build | Start |
| --- | --- | --- | --- |
| Web | `/` | `npm ci && npm run build:prod` | `npm run start -- -p $PORT` |
| HTLC solver | `swap-solver` | `npm ci` | `npx tsx src/htlc-solver-daemon.mts` |
| C2C daemon | `swap-solver` | `npm ci` | `npx tsx src/canton-swap-daemon.mts` |

Network switch:

| | Devnet | Mainnet |
| --- | --- | --- |
| `NEXT_PUBLIC_NETWORK` | `devnet` | `mainnet` |
| `NEXT_PUBLIC_LOOP_NETWORK` | `devnet` | `mainnet` |
| `NEXT_PUBLIC_SWAP_CHAIN` | `base-sepolia` | `base` |
| HTLC daemon `SWAP_NETWORK` | `devnet` | `mainnet` |
| HTLC daemon `EVM_CHAIN` | `base-sepolia` | `base` |
| Mainnet guard | unset | `ALLOW_MAINNET=true` |

Required web env categories:

- Supabase URL, anon key, and service-role key.
- WarpX/Auth m2m credentials.
- `CBTC_HTLC_PKG_ID`.
- `NEXT_PUBLIC_HTLC_ESCROW`, `NEXT_PUBLIC_WBTC_ADDRESS`.
- `SOLVER_EVM`, `NEXT_PUBLIC_SOLVER_EVM`.
- `CANTON_SWAP_SETTLEMENT_PARTY`, `NEXT_PUBLIC_CANTON_SWAP_SETTLEMENT_PARTY`.
- `HTLC_DAEMON_SECRET`, `CRON_SECRET`.
- Quote/fee knobs such as `PLATFORM_FEE_BPS`, `NETWORK_FEE_ENABLED`, and optional
  `COINGECKO_API_KEY` / `TRADECRAFT_API_URL`.

Required daemon env categories:

- `API_BASE` for the matching web service.
- `HTLC_DAEMON_SECRET` matching web.
- EVM RPC, escrow address, solver hot key for HTLC.
- Same network labels as the web build.

Detailed rollout checklist: [`docs/MAINNET-DEPLOY.md`](./docs/MAINNET-DEPLOY.md).

---

## 12. Repo layout and deeper docs

| Path | What |
| --- | --- |
| `app/api/htlc/*` | Cross-chain HTLC API routes |
| `app/api/canton/swap/*` | C2C API routes |
| `app/swap/page.tsx` | Unified swap UI |
| `app/orders/page.tsx` | History, claim, counter-accept, and recovery UI |
| `lib/htlc-service-singleton.ts` | HTLC lifecycle and recovery |
| `lib/canton-swap-service.ts` | C2C lifecycle and recovery |
| `lib/canton-swap-settle.ts` | C2C settlement proofs and reissue logic |
| `lib/htlc-quote.ts` | Cross-chain WBTC/BTC quote engine |
| `lib/canton-quote.ts` | C2C Tradecraft + reference sanity quote engine |
| `lib/canton-network-fee.ts` | CC network-fee estimate/collection/accounting |
| `supabase/migrations/` | Required database schema/RPC security controls |
| `swap-solver/src/htlc-solver-daemon.mts` | HTLC daemon |
| `swap-solver/src/canton-swap-daemon.mts` | C2C daemon |

| Doc | Topic |
| --- | --- |
| [`docs/ENV.md`](./docs/ENV.md) | Env-file layout and local run commands |
| [`docs/SWAP-RUNBOOK.md`](./docs/SWAP-RUNBOOK.md) | Operational swap runbook |
| [`docs/SWAP-SECURITY-AUDIT-README-2026-06-21.md`](./docs/SWAP-SECURITY-AUDIT-README-2026-06-21.md) | Full post-audit security report |
| [`docs/SWAP-QUOTE-DESIGN.md`](./docs/SWAP-QUOTE-DESIGN.md) | Quote architecture and deferred Dutch-auction work |
| [`docs/SWAP-CRASH-RECOVERY-DRILLS.md`](./docs/SWAP-CRASH-RECOVERY-DRILLS.md) | Funded crash-recovery drill checklist |
| [`docs/HTLC-SECRET-VAULT.md`](./docs/HTLC-SECRET-VAULT.md) | Browser preimage vault threat model |
| [`docs/MAINNET-DEPLOY.md`](./docs/MAINNET-DEPLOY.md) | Deployment guide |
| [`docs/canton-to-evm-design.md`](./docs/canton-to-evm-design.md) | Reverse HTLC design notes |

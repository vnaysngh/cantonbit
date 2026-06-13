# OranjSwap — Atomic EVM ↔ Canton Swaps

> **Single source of truth for this repo.** What we're building, how swaps work, and
> what's trustless vs trust-minimized. Task list: [`TASKS.md`](./TASKS.md). Agent/runtime
> notes: [`CLAUDE.md`](./CLAUDE.md).

OranjSwap is a cross-chain swap app that moves **Bitcoin-backed tokens** between **EVM**
(WBTC on Base Sepolia today) and **Canton** (CBTC on WarpX DevNet). Swaps are bound by a
single **hashlock**: one random secret `s`, one hash `H = keccak256(s)`. Reveal the secret
→ the trade completes on both legs. Wait out the timelock without revealing → each side
gets its own funds back.

We support **participant-managed** (email) and **Loop** (external wallet) Canton
identities — the same split used by production EVM↔Canton HTLC venues, with different
trust properties on the CBTC leg for each mode.

---

## Table of contents

1. [The idea in one minute](#1-the-idea-in-one-minute)
2. [Two swap directions](#2-two-swap-directions)
3. [Two wallet modes](#3-two-wallet-modes)
4. [Trust model (honest)](#4-trust-model-honest)
5. [The HTLC secret](#5-the-htlc-secret)
6. [Swap page vs Orders page](#6-swap-page-vs-orders-page)
7. [Order lifecycle & the solver daemon](#7-order-lifecycle--the-solver-daemon)
8. [On-chain / on-ledger building blocks](#8-on-chain--on-ledger-building-blocks)
9. [Running locally](#9-running-locally)
10. [Deploying on Railway](#10-deploying-on-railway)
11. [Repo layout & deeper docs](#11-repo-layout--deeper-docs)
12. [Fees & swap parameters](#12-fees--swap-parameters)

---

## 1. The idea in one minute

Imagine two people want to trade assets on different blockchains without trusting each other.

1. **Both sides lock** under the same hash `H`, with **staggered refund timers**.
2. **One party reveals** the secret `s` (where `keccak256(s) = H`) to claim what they're owed.
3. That reveal **unlocks the other leg** — the counterparty uses the now-public `s` to claim their side.
4. If someone stalls, **timelocks refund** each leg independently. Nobody can take the other's
   funds without giving up their own (or waiting for a timeout).

On **EVM**, this is a standard ERC-20 HTLC contract (`lock` / `claim` / `retake`).

On **Canton**, CBTC does not ship with a native hashlock. We wrap a Splice **Allocation** in our
custom Daml template **`HtlcLock`**, which enforces `keccak256(preimage) == hashLock` **on the
ledger** before CBTC moves.

```text
         hashLock H = keccak256(secret s)
                    │
    ┌───────────────┴───────────────┐
    │                               │
 EVM leg                         Canton leg
 (WBTC HTLC)                     (CBTC HtlcLock or transfer path)
 user/solver lock                solver/user lock
 longer/shorter timelock         shorter/longer timelock (per direction)
```

**keccak256 parity (critical):** EVM and Daml both hash the same raw 32-byte secret —
we use keccak256 on both legs.

Canonical test vector: secret `the-cross-chain-secret-32bytes!!` →  
`H = 0x94277b389401042e35f8709846050797955e2b321bee500555c2fbdc2f4e9903`.

---

## 2. Two swap directions

Timelocks follow the standard HTLC rule: **whoever reveals second gets the longer window**.
Our server validates the ladder (`lib/htlc-timelock.ts`) — a hostile client cannot invert the legs.

Default expiration: **4 hours** (user-selectable: 30m … 72h; minimum **2h** for Canton swaps).

### EVM → Canton (buy CBTC with WBTC)

You lock **WBTC on Base Sepolia** first; the solver locks **CBTC on Canton** second; you claim
CBTC (reveal); the solver claims WBTC.

| Step | Who | What |
| ---- | --- | ---- |
| 1 | User (browser) | Generate secret `s`, publish order with `H = keccak256(s)` |
| 2 | Solver | Accept the order |
| 3 | User (MetaMask) | Approve + **lock WBTC** on `HTLCEscrow` under `H` → `main_locked` |
| 4 | Solver | **Lock CBTC** on Canton under the same `H` → `counter_locked` |
| 5 | User | **Claim CBTC** — reveal `s` → `counter_claimed` |
| 6 | Solver (daemon) | Read public `s`, **claim WBTC** on EVM → `main_claimed` / **Completed** |

**Timelocks (forward):** `userTimelock` = EVM (longer — you retake WBTC after this);  
`solverTimelock` = Canton (shorter — solver's CBTC refund window).

**CBTC delivery path depends on wallet mode** (see [§3](#3-two-wallet-modes)):
- **Email:** on-ledger `HtlcLock.Claim` — hash checked by the Daml ledger.
- **Loop:** standard CBTC transfer + backend hash gate (trust-minimized).

### Canton → EVM (sell CBTC for WBTC)

You lock **CBTC on Canton** first; the solver locks **WBTC on EVM** second; you claim WBTC in
MetaMask (on-chain reveal); the solver claims CBTC on Canton.

| Step | Who | What |
| ---- | --- | ---- |
| 1 | User (browser) | Generate `s`, publish order with `H` |
| 2 | Solver | Accept |
| 3 | User / backend | **Lock CBTC** on Canton → `main_locked` |
| 4 | Solver (daemon) | **Lock WBTC** on EVM (receiver = your MetaMask address) → `counter_locked` |
| 5 | User (MetaMask) | **`claim(preimage)` on EVM** — reveal on-chain → `counter_claimed` |
| 6 | Solver (daemon) | Read `s` from the EVM `Claimed` event, **claim CBTC** on Canton → `main_claimed` |

**Timelocks (reverse):** `userTimelock` = Canton (longer); `solverTimelock` = EVM (shorter).

**Email users:** fully on-ledger — our backend signs `HtlcLock` lock/refund via `CanActAs` over
your warpx-hosted party (**platform auto-lock**).

**Loop sellers:** CBTC moves via a **standard transfer to the venue** (custody during swap —
see [§4](#4-trust-model-honest)).

---

## 3. Two wallet modes

We support two Canton identity models:

| | **Email / participant-managed** | **Loop wallet (external)** |
| --- | --- | --- |
| **Sign in** | Supabase OTP (email) | Loop Exchange API Key + wallet popup |
| **Canton party** | Hosted on **our WarpX node** | Hosted on **Loop's participant** |
| **Canton signing** | Backend signs via **`CanActAs`** — no popup for most steps | User signs in **Loop wallet** |
| **`counterMode`** | `managed` | `loop` |
| **Forward (EVM→Canton) CBTC claim** | `POST /claim-managed` — on-ledger `HtlcLock.Claim` | `claim-counter` + optional Loop `TransferInstruction_Accept` |
| **Reverse (Canton→EVM) CBTC lock** | Backend `lock-main` — on-ledger `HtlcLock` | User signs transfer → venue accepts (custody) |
| **Trust on CBTC leg** | ✅ **Fully trustless** (ledger enforces hash) | ⚠️ **Trust-minimized** (backend hash gate + standard transfer) |

### Why email users get a fully trustless Canton leg

Three things must align for `HtlcLock.Claim` to work on our node:

1. **DAR on the receiver's participant** — our `cbtc-htlc-hardened` package must be vetted where
   the receiver party lives. Email parties are **local on WarpX** → our DAR applies.
2. **`CanActAs` grant** — the backend may sign `Claim` for the hosted receiver
   (participant-managed path).
3. **Disclosed Allocation** — the claim submission includes the Allocation contract the template
   executes against.

Proven on live DevNet: receiver exercises `HtlcLock.Claim` → ledger checks keccak →
`Allocation_ExecuteTransfer` → CBTC delivered.

### Why Loop users cannot be fully trustless on Canton (yet)

Loop parties live on an **external participant** that does **not** have our custom DAR. A
cross-participant `HtlcLock` where the receiver is a Loop party fails with synchronizer /
authority errors — we proved this on-node in both directions.

**Canton's authority model forces a different path:**

- **Forward (buy CBTC):** after you lock WBTC, the solver delivers CBTC via a **standard Splice
  transfer**. We verify `keccak256(preimage) == hashLock` **server-side** before releasing; you
  may need one Loop popup to `TransferInstruction_Accept` unless preapproval auto-accepts.
- **Reverse (sell CBTC):** you sign a **standard transfer** of your CBTC to the venue; we accept
  as custodian, then lock WBTC on EVM. Refunds return custodied CBTC if you never reveal.

This is the structural tradeoff for external-wallet Canton parties: **custody or
backend-gated reveal**, not an on-ledger hash template on the external participant.

**Your EVM leg stays fully trustless in both modes** — real `HTLCEscrow` on Base Sepolia with
on-chain `keccak256` checks and `retake` refunds.

---

## 4. Trust model (honest)

| Leg | Email user | Loop user |
| --- | --- | --- |
| **EVM (WBTC)** | ✅ Trustless — `HTLCEscrow.sol` | ✅ Trustless — same contract |
| **Canton (CBTC) forward** | ✅ Trustless — `HtlcLock` on ledger | ⚠️ Trust-minimized — backend reveal gate + transfer |
| **Canton (CBTC) reverse** | ✅ Trustless — `HtlcLock` on ledger | ⚠️ Trust-minimized — venue custody during swap |

**What "trust-minimized" means here:** the solver/platform must not learn your secret before you
claim, and cannot pass the hash gate without the correct preimage. You still rely on the backend
to **honor** that gate (and, for Loop reverse, to hold/return custodied CBTC).

**What stays safe even if the solver misbehaves (both modes):**

- Your locked **WBTC on EVM** is only taken by a valid on-chain `claim(preimage)` or returned
  by `retake` after your timelock.
- Staggered timelocks + server-side **EVM claim-margin checks** prevent "reveal late, steal both
  legs" attacks against solver float.

We deliberately **do not** store your secret on the server pre-claim. See [§5](#5-the-htlc-secret).

---

## 5. The HTLC secret

Every swap starts in the browser with `generateSecret()` (`lib/htlc-client.ts`):

- Random 32-byte secret `s`
- `hashLock H = keccak256(s)` committed in the order and both locks
- **`s` must survive refresh, tab close, and navigation to `/orders`**
- **`s` must not reach the solver or our DB before claim** — otherwise the solver could front-run

### Encrypted browser vault (v3)

Storage: `lib/secret-vault.ts` → `localStorage` key `oranj.htlc.secrets.v3` (AES-GCM).

| Anchor | When | Unlock |
| --- | --- | --- |
| **`managed-session`** | Email / `counterMode: managed` | Active Supabase session + matching Canton party |
| **`loop-wallet`** | Loop / `counterMode: loop` | Connected Loop party + matching `public_key`; one-time **`signMessage`** unlock gate per 30 min |

**Design choices (vs server-side secret recovery):**

- ✅ Secret stays **client-only** until you POST it at claim time
- ✅ Bound to identity — wrong account / wrong Loop wallet / wrong MetaMask cannot decrypt
- ✅ TTL purge after timelock; cleared after successful claim or retake
- ✅ Manual **paste fallback** on `/orders` if storage is missing (honest cross-device limit)
- ⚠️ Same-origin XSS can still decrypt — this is a browser ceiling; see
  [`docs/HTLC-SECRET-VAULT.md`](./docs/HTLC-SECRET-VAULT.md) for Tier 2 ideas

**Loop v3 fix:** an earlier vault derived AES keys from **non-deterministic** `signMessage`
signatures, which broke recall after refresh. v3 uses a deterministic key from `party_id +
public_key`; `signMessage` is only a **consent gate**, not key material.

---

## 6. Swap page vs Orders page

Both pages call the same claim protocol (`claimSwap` in `lib/htlc-client.ts`). Only **storage
recall and UX** differ.

### `/swap` — live swap flow

- Generates the secret, **persists to vault before locking** (swap aborts if vault save fails)
- Walks you through lock → wait for solver → claim with step UI
- **Resume after refresh:** detects an in-progress claimable swap; shows **"Unlock saved secret"**
  (does **not** auto-trigger Loop `signMessage`)
- Clears vault entry after claim / retake

### `/orders` — history & recovery

- Lists swaps from **session party + Loop party** (merged history when you have both)
- Hides abandoned drafts (`accepted` forward orders that never locked WBTC)
- **Claim drawer** for `counter_locked` (and Loop forward at `main_locked`)
- Recalls secret from vault, or **paste secret manually**
- Loop users may see one **`signMessage`** popup to unlock the vault before claim
- Email forward claim needs **no MetaMask** — only Supabase session + recalled secret

| Scenario | Wallet | Claim from `/orders` needs |
| --- | --- | --- |
| Forward EVM→Canton | Email | Supabase session + vault (no MetaMask) |
| Forward EVM→Canton | Loop | Loop connected + vault unlock + maybe Accept popup |
| Reverse Canton→EVM | Either | MetaMask on the order's EVM address + vault or paste |

---

## 7. Order lifecycle & the solver daemon

### Statuses

```text
open → accepted → main_locked → counter_locked → counter_claimed → main_claimed
                                                      ↘ refunded / cancelled / failed
```

| Status | Meaning (user-facing) |
| --- | --- |
| `main_locked` | Your leg is locked (WBTC or CBTC depending on direction) |
| `counter_locked` | Both legs locked — **you can claim** |
| `counter_claimed` | You revealed; solver finishing the other leg (**Settling**) |
| `main_claimed` | Done (**Completed**) |

### Independent solver daemon (required in production)

The browser **never** holds solver keys. A standalone worker polls the app API and completes
the solver's on-chain steps:

```bash
npm run solver:htlc   # swap-solver/src/htlc-solver-daemon.mts
```

**Not** `npm run solver:watch` — that is the legacy mainnet OIF settler (Arbitrum), not HTLC.

The daemon:

1. On `main_locked` (forward) → verify EVM lock → lock CBTC counter
2. On `counter_claimed` (forward) → read revealed `s` → claim WBTC on EVM
3. On `main_locked` (reverse) → lock WBTC on EVM
4. On `counter_locked` (reverse) → watch EVM `Claimed` event for `s` → claim CBTC on Canton
5. Periodically calls `/api/htlc/auto-refund` for expired swaps

If the daemon stops, swaps can stall at **Settling** (you already received CBTC; solver hasn't
book-kept the EVM claim yet).

---

## 8. On-chain / on-ledger building blocks

| Component | Location | Role |
| --- | --- | --- |
| **EVM HTLC** | `contracts/src/HTLCEscrow.sol` | `lock` / `claim` / `retake` — 13/13 Foundry tests |
| **Canton HTLC DAR** | `canton-htlc/daml/CbtcHtlc.daml` | `HtlcLock` wraps Allocation with hash + timelock |
| **Swap service** | `lib/htlc-service-singleton.ts` | Order lifecycle, reveal gates, on-ledger ops |
| **API** | `app/api/htlc/*` | Create, accept, lock, claim, refund, history |
| **UI** | `app/swap/page.tsx`, `app/orders/page.tsx` | MetaMask + Loop + email flows |
| **Daemon** | `swap-solver/src/htlc-solver-daemon.mts` | Solver automation |

### DevNet references (Base Sepolia + WarpX)

| Thing | Value |
| --- | --- |
| EVM HTLCEscrow | `0x1b19a764ab35db1833ae2137544dd84ba5bf8cf1` |
| Mock WBTC (testnet) | `0x8d587e55236d1d4898e85711f709e53e657413ee` — set as `NEXT_PUBLIC_WBTC_ADDRESS` |
| CBTC HTLC DAR | `cbtc-htlc-hardened v0.1.0` — pkg `1b2397fd…faf2d28` → `CBTC_HTLC_PKG_ID` |
| Solver Canton party | `warpx-devnet-1::1220231c1885f289…` |

---

## 9. Running locally

```bash
# Terminal 1 — Next.js app (UI + /api/htlc)
cp .env.example .env.local   # fill in Supabase, Keycloak, HTLC vars
npm install
npm run dev

# Terminal 2 — HTLC solver daemon (required for swaps to complete)
npm run solver:htlc
```

Copy solver secrets from `swap-solver/.env` (`PRIVATE_KEY`, `HTLC_ESCROW_ADDRESS`, etc.).
The daemon reads `swap-solver/.env` + `.env.local` via the npm script.

**Supabase migration 010 (HTLC RLS lockdown):** before mainnet, paste
`supabase/migrations/010_htlc_orders_rls_lockdown.sql` into the Supabase SQL Editor
so `htlc_orders` and `solver_orders` are not readable via the anon REST key.
RLS enabled with no policies is intentional — only the service-role key (server) retains access.

**Legacy (mainnet OIF path only — not HTLC):** `npm run dev:all` starts solver API + watch +
app; HTLC swaps do **not** need this.

---

## 10. Deploying on Railway

Use **two services** in one project:

| Service | Build | Start |
| --- | --- | --- |
| **Web app** | `npm ci && npm run build` | `npm run start -- -p $PORT` |
| **HTLC solver** | `npm ci --prefix swap-solver` | `npx tsx swap-solver/src/htlc-solver-daemon.mts` |

Do **not** run `npm run build` on the solver service.

### Web app env (required)

```bash
NODE_ENV=production

# Supabase — must exist at BUILD time (NEXT_PUBLIC_* are baked into the client)
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# Canton JWT (Authentik / WarpX m2m)
KEYCLOAK_TOKEN_URL=
KEYCLOAK_CLIENT_ID_DEVNET=
KEYCLOAK_CLIENT_SECRET_DEVNET=

# Network + HTLC
NEXT_PUBLIC_NETWORK=devnet
CBTC_HTLC_PKG_ID=
NEXT_PUBLIC_HTLC_ESCROW=0x1b19a764ab35db1833ae2137544dd84ba5bf8cf1
NEXT_PUBLIC_WBTC_ADDRESS=0x8d587e55236d1d4898e85711f709e53e657413ee
NEXT_PUBLIC_SOLVER_EVM=
NEXT_PUBLIC_SOLVER_CANTON=
SOLVER_EVM=
SOLVER_CANTON_PARTY=

# Daemon + cron auth (generate long random strings)
HTLC_DAEMON_SECRET=
CRON_SECRET=
```

Also configure Supabase Auth redirect URL: `https://<your-domain>/auth/callback`.

**WBTC balance in the UI** uses MetaMask `eth_call` in the browser — it does **not** use
`ORIGIN_RPC_URL`. That var is solver-only.

### HTLC solver worker env

```bash
API_BASE=https://<web-app-url>          # or Railway private networking URL
HTLC_DAEMON_SECRET=<same as web>
SOLVER_EVM_PK=<same as PRIVATE_KEY in swap-solver/.env>
ORIGIN_RPC_URL=https://sepolia.base.org
HTLC_ESCROW_ADDRESS=0x1b19a764ab35db1833ae2137544dd84ba5bf8cf1
```

Optional: `ALERT_WEBHOOK_URL`, `SOLVER_POLL_MS`.

---

## 11. Repo layout & deeper docs

| Path | What |
| --- | --- |
| `contracts/` | EVM HTLC + Foundry tests + reference contract |
| `canton-htlc/` | Daml `HtlcLock` DAR + tests |
| `lib/htlc-onledger.ts` | Allocate, createHtlcLock, claim, refund |
| `lib/htlc-service-singleton.ts` | Swap order service |
| `lib/secret-vault.ts` | Encrypted browser secret storage |
| `lib/htlc-client.ts` | Frontend API client + `claimSwap` |
| `app/api/htlc/*` | REST routes |
| `swap-solver/src/htlc-solver-daemon.mts` | Production solver worker |

| Doc | Topic |
| --- | --- |
| [`docs/HTLC-SECRET-VAULT.md`](./docs/HTLC-SECRET-VAULT.md) | Secret vault threat model & v3 design |
| [`docs/HTLC-SECURITY-AUDIT-2026-06-12.md`](./docs/HTLC-SECURITY-AUDIT-2026-06-12.md) | Security audit & hardening |
| [`docs/canton-to-evm-design.md`](./docs/canton-to-evm-design.md) | Reverse-direction design (Canton→EVM) |

### Operational env vars (quick reference)

| Var | Service | Purpose |
| --- | --- | --- |
| `CBTC_HTLC_PKG_ID` | Web | On-ledger HTLC package — app fails closed if missing |
| `HTLC_DAEMON_SECRET` | Web + solver | Bearer auth for daemon-only API routes |
| `CRON_SECRET` | Web | Auto-refund / cleanup cron routes |
| `NEXT_PUBLIC_WBTC_ADDRESS` | Web (build) | Testnet WBTC contract for balance display |
| `ORIGIN_RPC_URL` | Solver only | Base Sepolia RPC for daemon on-chain reads/txs |
| `ALERT_WEBHOOK_URL` | Web + solver | Slack/Discord ops alerts (optional) |

---

## 12. Fees & swap parameters

Swaps involve **three separate cost types**. Only the **platform fee** is OranjSwap revenue;
network fees go to Canton (CC) and EVM (gas) infrastructure.

### Platform fee (OranjSwap / solver)

**Model:** user ↔ **solver** (us), not P2P. We take **one fee on the quoted output** — not
1% from each side like P2P venues that match two independent users.

| Config | Default | Where enforced |
| --- | --- | --- |
| `PLATFORM_FEE_BPS` | `100` (1%) | Server quote (`lib/htlc-quote.ts`) |
| `NEXT_PUBLIC_FEE_BPS` | `100` | UI pre-quote estimate (`app/swap/page.tsx`) |
| `SOLVER_FEE_BPS` | `100` | Legacy OIF solver only (`swap-solver/`) |

**Quote math** (live WBTC/BTC price `P`, 8dp units):

- **EVM → Canton:** `cbtcOut = wbtcIn × P × (1 − fee)`
- **Canton → EVM:** `wbtcOut = cbtcIn ÷ P × (1 − fee)`

**How it is collected:** there is no separate on-chain “fee transfer.” The fee is embedded in
the quoted amounts bound into the HTLC locks. The solver locks **less** on its leg than the
fair mid-price amount and receives **more** on the user leg — the spread is the platform fee.

**Example (Canton → EVM, P = 1.0, 1% fee):**

| Party | Locks | Receives |
| --- | --- | --- |
| User | 1.00000000 CBTC | 0.99000000 WBTC |
| Solver | 0.99000000 WBTC | 1.00000000 CBTC |

Solver gross ≈ **0.01 BTC notional** minus network costs. Order creation re-validates amounts
against a fresh quote (`assertOrderAmounts` in `lib/htlc-quote.ts`) so clients cannot bypass
the fee.

The review modal shows **Platform fee** with the exact deduction before confirm.

### Canton network fee (CC / Amulet)

Every Canton ledger submission burns **CC (Amulet)** from the party in `actAs`. This is
**not** platform revenue — it pays Canton synchronizer / validator infrastructure.

**Who pays which leg (typical email / participant-managed flow):**

| Direction | User party CC | Solver party CC |
| --- | --- | --- |
| **Canton → EVM** | Lock path (~2 ledger txs: allocate + `HtlcLock`) | Claim CBTC after EVM reveal |
| **EVM → Canton** | Usually none for the user’s lock (user signs EVM only) | Lock + claim CBTC counter |

Amount is **variable** (small fractions of CC per tx), not a fixed per-swap line item in the app.

**UI & guardrails:**

- CC balance shown in the header for email users (`/api/parties/balance` → `useBalance`).
- **Review swap** blocked when `ccReady === false` and balance &lt; `MIN_CC_BALANCE` (0.001).
- **DevNet bypass:** when `ccSubsidizedOnDevnet` is true, the guard is off — WarpX often
  subsidizes hosted parties so swaps succeed with **0 CC visible**. On testnet/mainnet the
  guard applies.
- **EnableCC** (one-time CC opt-in: `ValidatorRight` + `TransferPreapproval`) runs on
  participant provision (`lib/enable-cc.ts`).

CC burn does not appear as a separate row in the swap UI; inspect ledger transaction history
(Splice meta keys such as `splice.lfdecentralizedtrust.org/burned`) to verify per-tx cost.

### EVM network fee (gas)

Paid in **ETH** on the swap chain (Base Sepolia today) to Ethereum validators — not OranjSwap.

| Step | Who pays gas |
| --- | --- |
| User locks WBTC (EVM → Canton) | User (MetaMask) |
| User claims WBTC (Canton → EVM) | User (MetaMask) |
| Solver locks WBTC counter (Canton → EVM) | Solver hot wallet |
| Solver claims / retake on EVM | Solver |

### Other swap parameters

- **Timelocks:** maker ≥ order expiration; taker shorter; min **2h** for Canton swaps; default **4h**
- **Gap:** ~20m minimum between legs (Canton skew + EVM finality + execution buffer)
- **Refunds:** Canton auto-refund sweep + manual; EVM `retake(hashLock)` via MetaMask
- **Cancel:** maker can cancel before any lock (no on-chain activity)

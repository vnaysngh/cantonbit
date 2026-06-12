# OranjSwap — Trustless Atomic Cross-Chain Swaps (EVM ↔ Canton)

> **Single source of truth for this repo.** What we're building, how it works, and
> what's proven. Task list lives in [`TASKS.md`](./TASKS.md). Project/runtime
> instructions live in [`CLAUDE.md`](./CLAUDE.md).

---

## 1. What we're building

A **Cancore-equivalent** trustless atomic swap between **EVM tokens** (WBTC/USDC on
Base/Arbitrum) and **Canton tokens** (cBTC, CC). Priority direction: **EVM → Canton**.

The swap is bound by a single secret (HTLC). Reveal the secret → both legs settle.
Timeout without reveal → both sides refund. Neither party can take the other's funds
without giving up their own.

Modeled on **Cancore** (cancore.io — a live production EVM↔Canton HTLC swap), whose
design we reverse-engineered from their verified contract + app bundle + docs.

---

## 2. How it works — the HTLC flow (EVM → Canton)

```
1. Create Order   (user)    publish order, commit to hashLock H = keccak256(secret)
2. Accept Order   (solver)  solver takes the order
3. HTLC Proposal  (user)    user APPROVES + LOCKS WBTC on the EVM HTLC under H   ← MetaMask
4. Counter HTLC   (solver)  solver LOCKS cBTC on Canton (Allocation + HtlcLock under H)
5/6. Claim Counter(user)    user CLAIMS the cBTC → reveals the secret             ← see §4
7. Claim Main     (solver)  solver reads the revealed secret, CLAIMS the WBTC on EVM
8. Completed
```

**One secret `s`, one hash `H = keccak256(s)`** binds both legs. Staggered timelocks:
EVM (user) timelock **longer** than Canton (solver) timelock, so the solver always has
time to claim after seeing the reveal.

### keccak256 parity (critical)
- EVM: `keccak256(rawSecretBytes)`
- Daml: `DA.Crypto.Text.keccak256(hexString)` — decodes the hex back to the same raw
  bytes, then hashes → **identical H**.
- Canonical test vector: secret `the-cross-chain-secret-32bytes!!`
  (hex `7468652d…2121`) → **H = `0x94277b389401042e35f8709846050797955e2b321bee500555c2fbdc2f4e9903`**.
- (Note: Cancore's *docs* say SHA-256, but their *deployed contract* uses keccak256.
  We use keccak256 — proven parity on both legs.)

---

## 3. The two wallet modes (Cancore's model, confirmed from their docs §6)

| Mode | Who | Canton party hosted on | Canton signing |
|---|---|---|---|
| **Participant-managed (DEFAULT)** | email/password users | **our node** (warpx) | the platform/backend signs for them — **no popup** |
| **Loop / browser-extension** | self-swap ("Loop mode") | external Loop participant | user signs in the Loop wallet popup |

**Key insight:** "Loop mode" in Cancore means a **self-swap** (sender = recipient), NOT
"normal external users". The **mainline product is participant-managed** — the user's
Canton party lives on our node, and the backend signs the on-ledger claim for them.
**This is the fully-trustless on-ledger path we built and proved.**

---

## 4. The cBTC leg — fully on-ledger trustless (PROVEN)

cBTC has **no native on-ledger hashlock** (proven: Allocation/TransferInstruction are
not hash-aware). So we wrap a standard Splice **Allocation** in our **custom Daml HTLC
template** (`canton-htlc/daml/CbtcHtlc.daml`, `HtlcLock`) that enforces the hash:

```
LOCK   solver allocates cBTC (AllocationFactory_Allocate, solver = sender = executor)
       + creates HtlcLock wrapping it (records hashLock + timelock)
CLAIM  receiver exercises HtlcLock.Claim(preimage)
       → the Daml LEDGER checks keccak256(preimage) == hashLock   ← ON-LEDGER HASH GATE
       → fires Allocation_ExecuteTransfer → cBTC delivered to the receiver
       → the preimage is now public on-ledger (drives the EVM claim)
REFUND after timelock, locker exercises HtlcLock.Refund → Allocation_Withdraw
```

### Why the claim works for hosted (participant-managed) users — the three keys
1. **DAR `observer receiver`** (v0.1.4): the receiver is a LOCAL party on our node where
   the DAR is vetted, so they can observe + exercise the choice. (A *cross-participant*
   observer would fail with `NO_SYNCHRONIZER_FOR_SUBMISSION` — which is why Loop-wallet
   users need a different path.)
2. **`CanActAs` grant**: the backend's ledger user is granted `CanActAs` over the hosted
   receiver party, so it can sign the claim for them (exactly Cancore's participant-managed).
3. **Disclose the Allocation** to the receiver in the claim submission (the receiver
   must see the Allocation that `HtlcLock.Claim` fetches).

### ✅ PROVEN on the live WarpX DevNet node
Full on-ledger claim succeeded: receiver exercised `HtlcLock.Claim` → ledger verified
the keccak hash → `Allocation_ExecuteTransfer` fired → cBTC delivered (updateId
`12203ce0…`). Server log: *"HtlcLock.Claim by receiver — on-ledger keccak check passed,
cBTC released."*

### Loop-wallet users (self-swap edge case)
Their party is on an external participant that doesn't have our DAR. For them, Cancore
uses a **standard `TransferInstruction_Accept`** (no custom template) with the hash
checked **backend-side** (`encryptedPreimage` off-chain). Trust-minimized, not on-ledger.

---

## 5. The EVM leg — fully trustless on-chain HTLC

`contracts/src/HTLCEscrow.sol` — aligned to Cancore's verified `HTLC.sol` + hardened:
- `lock(hashValue, unlockTime, amount, token, receiver)` — locks ERC20 under the hashlock.
- `claim(bytes preImage)` — receiver-only, before unlockTime; on-chain
  `keccak256(preImage) == hashValue` check; reveals preImage in the `Claimed` event.
- `retake(bytes32 hashValue)` — sender-only refund after unlockTime.
- Hardened: SafeERC20, ReentrancyGuard, delete-before-transfer, custom errors, events.
- **13/13 Foundry tests.** Deployed Base Sepolia: `0x1b19a764ab35db1833ae2137544dd84ba5bf8cf1`.

---

## 6. Trust model (honest)

| Leg | Trust |
|---|---|
| **EVM** | ✅ **Fully trustless** — real on-chain HTLC, hash enforced by the contract |
| **cBTC — participant-managed users** | ✅ **Fully trustless** — hash enforced **on the Daml ledger** (our DAR) |
| **cBTC — Loop-wallet (self-swap) users** | ⚠️ Trust-minimized — standard accept + **backend** hash gate (same as Cancore's Loop users) |

For users we host (the mainline), **both legs are fully trustless.** User funds are
always protected by the EVM HTLC + timeout refunds even if the solver misbehaves.

---

## 7. Repo layout

| Path | What |
|---|---|
| `contracts/` | EVM HTLC (`HTLCEscrow.sol`) + Foundry tests + Cancore reference |
| `canton-htlc/` | Daml HTLC DAR (`CbtcHtlc.daml`, `HtlcLock`) + tests |
| `lib/htlc-onledger.ts` | on-ledger cBTC: allocate, createHtlcLock, claim, refund (the DAR path) |
| `lib/htlc-service-singleton.ts` | swap order lifecycle service (open→…→completed) |
| `lib/htlc-client.ts`, `lib/htlc-evm-encode.ts` | frontend client + EVM calldata encoders |
| `app/api/htlc/*` | swap API routes (create/accept/lock/claim-prepare/claim-record/preimage) |
| `app/swap/page.tsx` | the swap UI (MetaMask lock, claim, timeline) |
| `swap-solver/src/htlc-*.ts(.mts)` | solver daemon, settler, e2e scripts, the on-node spike |

---

## 8. Key on-chain / on-ledger references

| Thing | Value |
|---|---|
| EVM HTLCEscrow (Base Sepolia) | `0x1b19a764ab35db1833ae2137544dd84ba5bf8cf1` |
| cBTC HTLC DAR (current) | `cbtc-htlc v0.1.4` — pkg `0020dac262caab99659564f3e3057ec039a79d36fb31a544974f8ff5fe4410cd` |
| Canonical hashLock H | `0x94277b389401042e35f8709846050797955e2b321bee500555c2fbdc2f4e9903` |
| Solver Canton party (devnet) | `warpx-devnet-1::1220231c1885f289…` |
| Hosted test receiver (devnet) | `oranjswap::1220231c1885f289…` |

### Operational env vars

| Var | Purpose |
|---|---|
| `CRON_SECRET` | Bearer token gating the scheduled `GET /api/htlc/auto-refund` sweep (Vercel cron). Daemon's `POST` path needs no auth. |
| `ALERT_WEBHOOK_URL` | Slack/Discord incoming-webhook for operational alerts (failed claims, solver insolvency, stuck-swap refund failures). Unset → alerts log to console only. |

---

## 9. Cancore parameters we adopt (from their docs)

- **Timelocks:** maker ≥ order expiration, taker shorter; **min 2h for Canton swaps**.
  Expiration options: 30min / 1h / 2h / 4h / 8h / 24h / 48h / 72h. We use 4h/3h default.
- **Fee:** 1% per side, in the token being sent (optional to implement).
- **Canton network fee:** paid in CC (Amulet) — hosted user parties need CC funded.
- **EnableCC:** one-time onboarding so a Canton account can hold/use CC (needed per party).
- **Order lifecycle:** `open → accepted → htlc_proposal_sent → htlc_active →
  both_claimed` / `refunded` / `cancelled`.
- **Refund/Retake:** Canton auto-refunds after timeout (or manual Refund); EVM via
  `retake(hashLock)` in MetaMask (or directly on Etherscan as a fallback).
- **Cancel:** maker can cancel before any HTLC locks (no on-chain activity).

# HTLC Secret Vault — Problem, Options, and Implementation Plan

This document explains why the app persists HTLC swap secrets in the browser, what is wrong with the current approach, how other venues compare, and what we are implementing instead.

Related: [HTLC Security Audit (2026-06-12)](./HTLC-SECURITY-AUDIT-2026-06-12.md)

---

## Background: what the secret is

Every HTLC swap uses a random 32-byte **secret** (preimage) generated in the browser. Its hash (**hashLock**) is committed in the order and on-chain locks. The user reveals the secret only at **claim** time. Until then:

- The solver must not learn the secret (or they could claim the user's locked funds).
- Our server must not learn the secret pre-claim (same reason — we host claims for email users via `CanActAs`, but the user still controls _when_ to reveal).

The secret is created in `generateSecret` (`lib/htlc-client.ts`) and must survive long enough for the user to complete the swap after refresh, tab close, or navigation to `/orders`.

---

## The problem

### 1. Plaintext localStorage

The current vault (`lib/secret-vault.ts`, key `oranj.htlc.secrets.v1`) stores:

```text
{ [swapId]: "0x<64 hex chars>" }
```

That works for recovery UX but has real weaknesses:

| Risk | What v1 plaintext did | What v3 improves |
| -------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------- |
| DevTools / unlocked device | Anyone reads all secrets | Wrong session/wallet cannot decrypt; paste fallback remains |
| No identity binding | Any same-origin code with swap id reads secret | Bound to Supabase session + party, or Loop party + public_key, or EVM address (reverse) |
| No expiry | Secrets linger after timelock | Purged after timelock (+ buffer); direction-aware on reverse |
| Incomplete cleanup | Partial `forgetSecret` coverage | Cleared after claim/retake on swap + orders |

**Honest ceiling (Tier 1):** v3 is **identity-bound obfuscation + UX gates**, not at-rest crypto against same-origin script. KDF inputs for both anchors live beside the ciphertext in `localStorage` (managed: user id from the auth session; loop: `public_key` stored in the entry). A content script or XSS on our origin can derive the key and decrypt without user interaction. The Loop `signMessage` step is a **consent gate before recall**, not key protection — and we do not verify the signature bytes.

What v3 **does** deliver vs v1:

- Wrong Supabase account / wrong Loop wallet / wrong MetaMask account cannot unlock
- TTL + metadata binding + v1 lazy migration (no plaintext bypass on recall)
- Server still never receives the secret pre-claim

**Tier 2 (future):** non-extractable `CryptoKey` in IndexedDB so key bytes cannot be read from JS.

### 2. Two wallet models, one naive vault

This app has **two Canton identity paths**, not one:

| Model | Party | Auth | `counterMode` | Typical claim |
| ------------------------------- | ----------------------------------------- | -------------------------------- | ------------- | ------------------------------------------------------------------------------- |
| **Email / participant-managed** | warpx-hosted party from `/api/parties/me` | Supabase OTP session | `managed` | Forward: backend `claim-managed` (POST preimage only). Reverse: MetaMask claim. |
| **Loop wallet** | External Loop party | Loop JWT (Exchange API Key sign) | `loop` | Forward: `claim-counter` + optional Loop accept. Reverse: MetaMask claim. |

A vault design that derives its encryption key from **only MetaMask** or **only Loop** breaks one of these paths:

- **Managed forward claim** from `/orders` needs **no wallet connected** — only Supabase session + recalled secret.
- **Loop sessionless users** have no Supabase `userId` for a session-derived key.

Any “Tier 1” fix must respect both models or claim will fail in production.

### 3. Orders page identity (dual Canton parties)

Users may have **two** Canton parties: warpx-hosted (email session) and Loop (external wallet). History must include swaps from **both** when they differ — otherwise a pure-Loop swap disappears after the user later signs in by email (session party M hides Loop party L orders).

**Fix:** `fetchMergedSwapHistory` loads session history and Loop `?party=` history when both exist, merges by swap id, newest first (`lib/htlc-client.ts`, `app/orders/page.tsx`).

---

## What some venues do (and why we do not copy it)

’s current app (bundle inspected 2026-06) tends toward **server-assisted recovery**:

- Secret may be sent at order creation as `encryptedPreimage` (name suggests encryption; inspected paths often pass the raw secret).
- `/htlc/{id}/preimage` returns `senderPreimage` so the claim form auto-fills after reload.
- `localStorage` is used for auth/wallet/UI settings; swap state is more session/server oriented.

**Tradeoff:** smoother cross-tab and cross-session UX, but **weaker pre-claim confidentiality** unless encryption uses a key the server cannot derive.

**Our choice:** keep **client-only pre-claim storage** (server never receives the secret until claim). Harden **how** the browser stores it — do not move plaintext to the server.

---

## Solution options considered

### Option A — Plaintext localStorage (status quo)

- ✅ Simple; works for same-browser recovery
- ❌ Plaintext at rest; no binding; poor housekeeping

### Option B — Server-stored secret / preimage (standard HTLC)

- ✅ Cross-device recovery
- ❌ Server sees secret before claim (unless truly client-wrapped ciphertext)
- ❌ Conflicts with our audited “reveal at claim” model

### Option C — Single wallet-derived key (e.g. EVM `personal_sign` only)

- ✅ Encrypts at rest
- ❌ **Breaks managed forward claim** (no EVM required at claim)
- ❌ **Breaks Loop sessionless** users

### Option D — Multi-anchor identity-bound vault (**chosen — Tier 1**)

Encrypt each secret with AES-GCM. Choose an **anchor** at store time based on `counterMode`:

| Anchor | Used when | Key material | Unlock at recall |
| ----------------- | --------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `managed-session` | `counterMode === "managed"` | `SHA-256(domain + supabaseUserId + cantonParty)` | Active Supabase session; party must match entry |
| `loop-wallet` | `counterMode === "loop"` | `SHA-256(domain + party_id + public_key)` — **deterministic** | Connected Loop party + `public_key` match; explicit `signMessage` unlock gate (30 min cache) |

**Threat-model note:** KDF inputs are stored alongside the ciphertext (or derivable from the same `localStorage`). This binds secrets to the correct identity and prevents casual DevTools copy-paste, but **does not** stop a same-origin extension or XSS from calling the exported `derive*VaultKey` helpers. Treat as obfuscation + UX gate; see Tier 2 for extractable-key-free storage.

Additional rules:

- Store metadata: `direction`, `counterMode`, `userCantonParty`, `userEvmAddress`, `expiresAt` (from timelock + buffer; reverse uses `min(userTimelock, solverTimelock)`).
- **Reverse (`canton-to-evm`)**: require `evm.account === userEvmAddress` before decrypt/claim (claim already needs MetaMask; escrow `claim` also requires `msg.sender == receiver`).
- **TTL**: purge entries after `expiresAt` or terminal order status.
- **Migration**: v1 plaintext is **never** returned directly; lazy migrate to v3 on recall when order metadata is available (same gates apply).
- **Manual fallback**: paste secret in `/orders` if device storage missing (honest cross-device limit).
- **Resume on /swap**: detect claimable active swap after refresh but **do not** auto-trigger Loop `signMessage` — user clicks “Unlock saved secret”.
- **No claim protocol changes**: same `claimSwap`, `claim-managed`, `claim-counter`, EVM `claim`.

What this does **not** fix (inherent browser ceiling):

- **Same-origin script (XSS, malicious extension with storage access)** — attacker has KDF inputs and exported derive helpers. Mitigate with CSP/hygiene; Tier 2 uses non-extractable keys.
- **Cross-device** — without server storage or user backup, secret stays on the creating device.

---

## What we are implementing

### Files touched

| File | Change |
| --------------------------- | ---------------------------------------------------------------------------- |
| `docs/HTLC-SECRET-VAULT.md` | This document |
| `lib/secret-vault.ts` | v3 vault, dual anchors, TTL, v1 lazy migration, test-only Loop unlock bypass |
| `lib/secret-vault.test.ts` | Crypto round-trip + anchor selection + v1 migration tests |
| `lib/htlc-order-logic.ts` | `isSwapClaimable` (Loop forward at `main_locked`) |
| `lib/htlc-claim-http.ts` | Claim-route HTTP status mapping (400/409 vs 500) |
| `hooks/useVaultContext.ts` | Shared vault recall context for swap + orders |
| `app/swap/page.tsx` | Persist throws if vault save fails; resume without auto Loop sign |
| `app/orders/page.tsx` | Merged history fetch; claim UI + paste fallback |

### Vault entry shape (v3)

```ts
{
 v: 3,
 iv: string, // AES-GCM nonce (base64)
 ct: string, // ciphertext (base64)
 anchor: "managed-session" | "loop-wallet",
 direction: "evm-to-canton" | "canton-to-evm",
 counterMode: "managed" | "loop",
 userCantonParty: string,
 userEvmAddress: string, // lowercase
 loopPublicKey?: string, // loop anchor only — binds to wallet
 expiresAt: number // unix seconds
}
```

Storage key: `oranj.htlc.secrets.v3` (v2 signature-based loop entries are cleared on next write)

---

## Production security issues and fixes

### Issue A — Loop-wallet anchor broke refresh (v2 blocker)

**Problem:** The first encrypted vault (v2) derived Loop AES keys from `signMessage` **signature bytes** with a **timestamp in the signed message**. Wallet signatures are non-deterministic and the message changed every call, so after a browser refresh the derived key no longer matched the stored ciphertext. Loop users could not unlock secrets from `/orders` unless they pasted manually.

**Why it was the main Tier 1 blocker:** A single EVM- or session-only key could not work for Loop users; Loop needed its own anchor — but that anchor had to survive refresh without server storage.

**Implemented solution (v3):**

1. **Deterministic key:** `SHA-256("oranj-htlc-vault-v1:loop:" + party_id + public_key)` — same key after refresh.
2. **Auth gate (not key material):** Fixed message `Oranj HTLC Vault Unlock for {party}` via `signMessage` once per 30-minute browser session before decrypt.
3. **Binding:** Store `loopPublicKey` in the vault entry; recall rejects mismatched wallets.
4. **Tests:** `lib/secret-vault.test.ts` — loop cold recall with different signature bytes still decrypts.

See `lib/secret-vault.ts` (v3) and `clearLoopVaultSession` on Loop logout.

---

### Issue B — Managed reveal missing EVM claim-margin gate (solver robbery)

**Problem:** Forward **managed** swaps (`POST /api/htlc/{id}/claim-managed`) exercised on-ledger CBTC claim via `claimCounterAsBackend` **without** calling `verifyEvmLock`. The Loop path (`claimCounter`) already checked that the WBTC lock exists, matches amount/receiver, and has at least **10 minutes** left before `userTimelock`.

**Attack:** User waits until ~1 minute before `userTimelock`, reveals preimage → receives CBTC → solver cannot claim WBTC in time → user `retake`s WBTC after timelock. Both legs taken; solver float drained.

**Implemented solution:** Call `verifyEvmLock(o)` at the start of `claimCounterAsBackend` when `direction === "evm-to-canton"` — same guard as `claimCounter`. Late reveals are rejected with `"EVM lock expires too soon for the solver to claim safely"`.

See `lib/htlc-service-singleton.ts` (`claimCounterAsBackend`, `verifyEvmLock`).

**Note:** This is a **server-side** reveal gate, separate from the client secret vault. The vault keeps the preimage client-side until claim; the margin check ensures claim timing cannot rob the solver.

---

These flows must keep working after the change:

1. Email managed, evm→canton — claim from `/orders`, **no MetaMask**
2. Loop, evm→canton — claim after refresh (optional one-time Loop unlock sign)
3. Email managed, canton→evm — claim with MetaMask (same address as order)
4. Loop seller, canton→evm — claim with MetaMask

The claim **API and on-chain steps are unchanged**. Only storage/recall/gating changes.

### Out of scope (Tier 2+)

- Server-held ciphertext blob for cross-device (client-wrapped DEK)
- One-click “export backup” at swap creation (can add later)
- WebAuthn / passkey-wrapped keys

---

## Implementation status (2026-06-12)

Implemented in this repo (2026-06-12, v3 loop key fix):

| Item | Location |
| --------------------------------------------------------- | ---------------------------------------------------------- |
| v3 encrypted vault (dual anchors, TTL, v1 migration) | `lib/secret-vault.ts` |
| Integration tests (managed + loop cold recall, EVM gate) | `lib/secret-vault.test.ts` |
| Persist throws if vault save fails (before lock proceeds) | `app/swap/page.tsx` |
| `forgetSecret` after claim / retake | `app/swap/page.tsx` |
| Session + Loop merged orders history | `fetchMergedSwapHistory` in `lib/htlc-client.ts` |
| Claim UI for `counter_locked` + Loop `main_locked` | `isSwapClaimable` in `lib/htlc-order-logic.ts` |
| Paste fallback always visible on claim drawer | `app/orders/page.tsx` |
| v1 lazy migration (no plaintext bypass) | `recallSecret` + `orderMeta` in `lib/secret-vault.ts` |
| Resume claim without auto Loop sign | `htlc-resume` / `rev-resume` stages in `app/swap/page.tsx` |
| Claim API 409 for EVM margin / state errors | `lib/htlc-claim-http.ts`, claim-\* routes |
| Managed EVM claim-margin on reveal | `lib/htlc-service-singleton.ts` (`claimCounterAsBackend`) |

Legacy v1 plaintext (`oranj.htlc.secrets.v1`) is migrated on recall when order metadata is available; it is never returned without passing v3 gates. v2 loop entries used a broken signature-based KDF and are cleared when v3 writes.

---

## References

- 
- Our captured reference contract: `contracts/reference/ReferenceHTLC.sol`
- Preimage route (daemon-only, post-reveal): `app/api/htlc/[id]/preimage/route.ts`

# Loop Wallet Integration

The app's Canton identity now comes from the user's **connected Loop wallet**,
not a party created on our validator.

## What changed

| Before | After |
|---|---|
| Login (Supabase OTP) → `/api/parties/allocate` creates a party on our validator | Login (Supabase OTP) for session only; user connects Loop → that party is the identity |
| `party_mappings.canton_party_id` = validator-created party | `party_mappings.canton_party_id` = the user's Loop wallet party |
| Swap delivered to a hardcoded devnet party | Swap delivered to the connected Loop party |
| User never touched Canton | User accepts transfers in their own Loop wallet |

## Architecture

- **`hooks/useLoopWallet.tsx`** — wraps `@fivenorth/loop-sdk` (browser-only,
  dynamically imported). `loop.init({appName, network:'devnet', onAccept})` then
  `connect()` opens the wallet popup; `onAccept(provider)` yields the connected
  `Provider` with `.party_id`. Exposes `connect/logout/connected/party/provider`.
  Network `devnet` → the SDK targets `https://devnet.cantonloop.com`.
- **`hooks/useWallet.tsx`** — unchanged shape (`isConnected/partyId/email/…`) so
  every screen keeps working, but `partyId` now comes from Loop. On connect it
  POSTs the party to `/api/parties/register-loop` to bind it to the session.
- **`/api/parties/register-loop`** — validates the Supabase session, upserts the
  Loop party into `party_mappings` for this user. Rejects a party already bound
  to another account (unique constraint).
- **`/api/parties/allocate`** — DEPRECATED (returns 410). No longer creates
  validator parties.
- **Server routes** (mint/redeem/transfer/balance) — unchanged. They still call
  `resolveSessionParty()`, which reads `party_mappings` — now holding the Loop
  party. So the whole app acts on the Loop party automatically.

## Security model (unchanged anchor)

- Identity still comes from the **Supabase session** server-side; the client
  can't claim an arbitrary party for server-side `actAs` routes — the server
  reads `party_mappings` for the session user.
- The Loop party is accepted from the client only to bind it to *that user's own*
  row. User-authorized Canton actions (transfers, accepting a swap delivery) are
  signed in the **Loop wallet itself**, so no server trust is needed for those.

## Live test runbook (devnet)

Prereq: the three swap processes running (API :8787, solver loop, app :3000) —
see `docs/SWAP-UI-RUNBOOK.md`.

1. Open http://localhost:3000, **log in** (Supabase OTP) for the app session.
2. Click **Connect Loop** (TopNav, or the destination row on /swap). A
   `devnet.cantonloop.com` wallet popup opens — approve the connection.
3. The TopNav badge + swap "Canton (destination)" now show your **Loop party**.
4. Run a swap: connect MetaMask (Base Sepolia), enter `0.0001`, Get quote →
   Confirm → sign Permit2.
5. The solver delivers cBTC to your Loop party. **Accept the incoming transfer
   in your Loop wallet** (the app does not auto-accept).
6. The solver captures the accept, attests + finalises → "Complete ✓".

## Network matching — the ONE thing that must line up

Canton is per-network: **devnet, testnet, and mainnet are separate ledgers.** A
party on one network cannot receive a transfer from a sender on another — that is
what the earlier `UNKNOWN_INFORMEES` actually was (the Oranj app runs on
**mainnet** per `NEXT_PUBLIC_NETWORK=mainnet`, so its login party was a mainnet
party, but the swap solver runs on **devnet** — cross-network, impossible).

Cross-**participant** delivery WITHIN a network works fine — the solver already
delivers to `8f5ca108…` (a different participant than the warpx float) every
swap. Sender/receiver participant location does not matter.

So the only requirement: **the Loop wallet must connect to the same network as
the solver (devnet).** The hook hardcodes `network: devnet` (override via
`NEXT_PUBLIC_LOOP_NETWORK`) precisely so it doesn't accidentally inherit the
app's mainnet setting. A devnet Loop party + a devnet solver = same ledger =
delivery works regardless of which participant hosts each party.

## Not done / future

- `provider.submitTransaction` is wired/available but the app does NOT build an
  in-app accept UI — the user accepts in their Loop wallet by design.
- BTC-address ↔ party mapping (mint deposit accounts) now keys off the Loop
  party via `party_mappings`; existing deposit_accounts rows tied to old
  validator parties are orphaned (acceptable on devnet).

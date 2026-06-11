# OranjSwap — TASKS (single source of truth)

> The ONE task file for the repo. See [`README.md`](./README.md) for how it all works.
> Trust target: fully trustless for participant-managed (our-node) users — both legs.

---

## ✅ DONE (built, tested, proven)

- [x] EVM HTLC `HTLCEscrow.sol` — keccak, lock/claim/retake, hardened. 13/13 tests.
      Deployed Base Sepolia `0x1b19a764…8cf1`.
- [x] On-ledger cBTC HTLC DAR `CbtcHtlc.daml` (HtlcLock) — on-ledger keccak gate +
      Allocation. v0.1.4 (`0020dac2…`) uploaded. Tests pass.
- [x] keccak256 parity EVM↔Daml proven (`0x9427…9903`).
- [x] On-ledger LOCK: allocate cBTC + create HtlcLock (lib/htlc-onledger.ts).
- [x] **On-ledger CLAIM PROVEN on node**: receiver exercised HtlcLock.Claim → ledger
      verified keccak == hashLock → Allocation_ExecuteTransfer → cBTC delivered
      (updateId `12203ce0…`). Required: DAR observer=receiver + m2m CanActAs over the
      hosted receiver + disclose the Allocation to the receiver.
- [x] Order lifecycle service + `/api/htlc/*` (create/accept/lock/claim-prepare/
      claim-record/preimage).
- [x] HTLC-native quote `/api/htlc/quote` (no old-solver dependency).
- [x] Frontend in `/swap`: MetaMask approve+lock (approve-wait fix), Base-Sepolia chain,
      split Claim button, real error messages.
- [x] Solver daemon (htlc-solver-daemon.mts): watch lock → lock counter → on reveal,
      claim WBTC on EVM.
- [x] EVM settle/retake + watchtower; reverse-direction + recovery e2e scripts.

---

## ✅ DONE — participant-managed product (the mainline) is built end-to-end

- [x] **R2. Participant-managed onboarding** — allocate party on warpx + grant backend
      CanActAs (lib/party-onboarding.ts, /api/parties/provision). Proven: fresh party →
      swap → cBTC delivered. (No EnableCC needed — backend co-signs as receiver.)
- [x] **R3. Solver daemon end-to-end** — user locks WBTC → daemon locks cBTC (HtlcLock)
      → backend claims cBTC (claim-managed, CanActAs) → daemon claims WBTC. PROVEN LIVE
      (htlc-e2e-managed.mts: real WBTC + real cBTC moved, user signed ONE thing).
- [x] **R4. Refund / Retake both legs** — cBTC HtlcLock.Refund → Allocation_Withdraw
      (timelock-gated, PROVEN), EVM retake(hashLock) button, auto-refund sweep in the
      daemon, orphan-allocation cleanup. Fixed allocateBefore ≤ settleBefore bug.
- [x] **R5. Orders persisted to Supabase** (htlc_orders, migration 007 applied) +
      Cancel (maker, before lock) + cancelled status. Service fully async/durable.
- [x] **R6. Timelocks from order expiration** — lib/htlc-timelock.ts (30min–72h, min 2h
      Canton, maker > taker, gap dominates skew+finality). Expiration dropdown in /swap.
- [x] **R7. Login/signup** — /login has BOTH email-OTP AND Loop wallet; both create the
      Canton-party identity. Provisions the warpx party on email login.
- [x] **R8. /swap wired to the identity model** — recipient = the logged-in user's party
      (warpx for email, Loop for Loop); EVM wallet is a subset (EVM-only header dropdown);
      Canton party = identity (AccountControl + Log out → /login); no-party → /login gate.

## ⏸ PAUSED — waiting on the Loop team

- [ ] **R1. Loop-wallet on-ledger claim.** A Loop user's EXTERNAL participant can't
      EXERCISE our custom HtlcLock.Claim (TEMPLATES_NOT_FOUND — disclosure shows the
      contract but the controller's participant needs our package to interpret the
      choice). Asked the Loop team: can a Loop wallet exercise a custom-package choice
      via disclosure, or must our DAR be vetted on Loop — and how does Cancore do it?
      Until then, Loop users are on hold; **participant-managed (email) is the working,
      fully-trustless mainline.**

## 🔵 NEXT (real, not blocked)

- [ ] Real two-party UI click-through (distinct EVM wallets + hosted user party) — prove
      WBTC user→solver AND cBTC solver→user end to end in the browser, not just scripts.
- [ ] Canton → EVM direction (reverse) in the UI.
- [ ] cBTC balance for the SESSION party in /swap (currently reads Loop wallet).
- [ ] Order history / tracking view from Supabase (htlc_orders).

---

## ⚪ Before mainnet (process / ops, not protocol)

- [ ] Fee model: 1% per side in the sent token (optional but Cancore-standard).
- [ ] External audit of both HTLC contracts (HTLCEscrow.sol + CbtcHtlc.daml).
- [ ] Mainnet deploy: deploy EVM HTLC on a real chain, real WBTC, mainnet cBTC DAR;
      monitoring + alerting; admin/key rotation. **Rotate the devnet creds shared in chat.**
- [ ] Delete the old OranjAttestorOracle path at cutover (the new path is proven).
- [ ] (Optional) Dutch auction + partial fills (Merkle-tree-of-secrets).

---

## Key facts to not re-litigate (settled, on-node evidence)

- cBTC has NO native on-ledger hashlock → we wrap an Allocation in our custom HtlcLock
  DAR. The hash IS enforced on the Daml ledger via that DAR. PROVEN.
- The on-ledger claim works for **local (participant-managed) receivers** where the DAR
  is vetted + the backend has CanActAs. Cross-participant (external Loop) receivers
  can't use the custom DAR (NO_SYNCHRONIZER) → they use standard TransferInstruction_Accept.
- "Loop mode" in Cancore = **self-swap**, not "external users". The default is
  participant-managed = our proven on-ledger path.
- EVM leg is a real on-chain HTLC (keccak). Docs say SHA-256 but the deployed contract
  is keccak256 — we use keccak256.

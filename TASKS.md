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

## ✅ DONE — Loop / external-wallet flow (R1 RESOLVED + tested in browser)

Loop team confirmed (2026-06-11): Loop will NEVER vet our DAR; a Loop user can't
exercise OR even be an informee on our custom contract. Proven on-node 3×. Their
Option 1 = Loop user signs ONLY standard Splice choices; all secret/claim logic on
our node. We reverse-engineered Cancore's production bundle: their Loop mode is
EXACTLY this — transfer-to-venue, venue runs the HTLC, custody-during-swap. We match it.

- [x] **R1. Loop external-wallet swap — BUILT + TESTED in browser.** counterMode="loop"
      (derived server-side from the receiver's namespace). Custody ordering: user clicks
      Claim → REVEAL secret first → backend verifies preimage + the real on-chain WBTC
      lock (verifyEvmLock) → flips counter_claimed (solver can now claim WBTC) → delivers
      cBTC via a STANDARD TransferFactory_Transfer. With the mandatory cBTC auto-accept
      (preapproval) ON, the transfer SELF-COMPLETES — no wallet popup (delivered=true).
      Fallback: standard TransferInstruction_Accept the user signs. NO custom DAR touches
      the Loop user. **Trust: trust-minimized on the Canton leg (atomicity = EVM HTLC +
      solver ordering + timelock), NOT a Canton on-ledger gate — forced by Loop policy.**
      Files: lib/htlc-service-singleton.ts (claimCounter), lib/transfer.ts
      (prepareAcceptCommand, findOfferFromSender, transferKind), app/api/htlc/[id]/
      {claim-counter,prepare-accept}, migration 008. Docs: LOOP-CONSTRAINTS-LOCKED.md.

## 🟡 LOOP TRUST UPGRADES (researched 2026-06-12 — both concrete, both need decisions)

- [ ] **Utility Settlement App Dvp** — the standard pre-delegation we proved bare
      allocations lack: `Dvp` signed by operator+buyer+seller, `Dvp_Settle` controller=
      operator alone (carries buyer+seller authority). In the Utility DARs Loop lists as
      supported. Upgrades Loop sellers custody → NON-CUSTODIAL (terms-bound allocation;
      settle-per-terms or expire-back; residual trust = DA-run Utility operator).
      Needs: Settlement Utility onboarding (operator/commercial conversation), confirm
      Loop passes UserService/DvpProposal choices, confirm one-Canton-leg DvP works.
- [ ] **"Pro mode": externally-signed party on OUR node** (/v2/interactive-submission
      prepare→execute) — FULL trustlessness with user-held keys (our vetted HtlcLock,
      user signs client-side, we can censor but never move funds). User creates a new
      party + moves funds off Loop. Real UX cost; best trust available.

## 🔵 NEXT (real, not blocked)

- [x] cBTC balance for the SESSION party in /swap — /api/parties/balance + useBalance
      branch (Loop provider → Loop wallet; else session party server-read). DONE.
- [x] **Canton → EVM (reverse) — BUILT (email users, fully trustless), needs browser
      test.** Cancore-mirrored design (docs/canton-to-evm-design.md): backend locks the
      USER's cBTC on-ledger (Allocation sender=user + HtlcLock locker=user via CanActAs,
      LONG timelock) → daemon locks WBTC on EVM (SHORT, receiver=user) → user claims
      WBTC in MetaMask (= the reveal) → daemon claims cBTC via the on-ledger keccak gate.
      Daemon has its own EVM Claimed-event watchtower (never trusts only the browser) +
      WBTC retake after solverTimelock. UI: direction toggle on /swap (managed users
      only; Loop sellers = phase 2). Migration 009 (counter_lock_tx) — NEEDS APPLYING.
      Reverse refunds are manual in v1 (UI button + refund-main route); auto-refund
      sweep doesn't cover reverse yet.
- [ ] Order history / tracking view from Supabase (htlc_orders).
- [x] **Auto-refund BOTH directions** — /api/htlc/auto-refund (daemon calls every 60s)
      now sweeps: forward solver-cBTC refunds, REVERSE user-cBTC refunds (refund-main,
      CanActAs — fully automated), and stale forward main_locked bookkeeping.
- [x] **Order history** — /orders page (nav link added) + GET /api/htlc/history
      (email session → warpx party; Loop → ?party=). Status chips + explorer links.
- [x] **RFQ quote engine, both directions** — lib/htlc-quote.ts + quote route: LIVE
      WBTC/BTC price (CoinGecko, 30s cache, ≤10min stale, else refuse), applied
      directionally (×P forward, ÷P reverse — cBTC is 1:1 BTC, WBTC is NOT), 20bps fee
      on output, 60s quote TTL, 2% de-peg breaker → 503. Reverse UI now server-quotes.
- [x] **Hygiene sweep** (swap-solver/src/hygiene-sweep.mts) — chunked Locked-event scan
      (RPC 2000-block cap; also fixed the daemon watchtower the same way), retakes
      expired solver-sent locks, then auto-refund + cleanup-allocations via API.
      Ran 2026-06-12: recovered 0.00611 WBTC (8 old probe locks). PENDING: re-run
      after ~2h for 0x0c9def/0x7c91 (timelocks not yet expired) + the API steps
      (dev server was down mid-run).
- [x] **LOOP SELLERS (canton-to-evm, external wallet) — Variant A custody (= Cancore),
      needs browser re-test.** HISTORY (settled 2026-06-12, never revisit): Variant B
      (AllocationFactory_Allocate escrow) was built + browser-tested first. The Loop
      wallet DID sign the allocate (proven!) and the lock landed — but settlement is
      IMPOSSIBLE: the cBTC DvpLegAllocation's ExecuteTransfer demands sender+receiver+
      executor (ALL THREE) live at execute time, no pre-delegation (proven on-node in
      BOTH directions: buyer probe missing receiver; seller execute missing sender).
      A bare cross-participant allocation locks but settles for NO ONE. Our HtlcLock
      settles only because the CONTRACT aggregates authorities — email-only. Cancore's
      transfer-to-venue custody is FORCED by Canton's authority model, not laziness.
      VARIANT A FLOW: user signs ONE standard TransferFactory_Transfer (their cBTC →
      venue); backend finds + ACCEPTS the offer as the venue (custody, main_locked);
      daemon locks WBTC (short timelock); user MetaMask-claims (reveal); claim-main
      just records (cBTC already custodied). Refunds FULLY AUTOMATED on our side
      (sweep + button → we send the custodied cBTC straight back; guarded on
      preimage-not-revealed). recordMainClaim now hard-rejects reverse orders (the
      stale-daemon false-main_claimed bug). Legacy: test order 0xa817… marked failed;
      its 0.001 cBTC sits in the user-withdrawable allocation (prepare-withdraw-loop
      route kept for recovery).
- [ ] Cleanup: delete the DEAD legacy Loop on-ledger claim path (app/api/htlc/[id]/
      claim-prepare route, prepareClaim in service + client, prepareClaimCommand usage
      for Loop) — superseded by claim-counter; UI no longer references it.
- [ ] (PARKED — analysed 2026-06-11, NOT a real trust upgrade for EVM→Canton) Allocation
      escrow for external-wallet buyers: a standard Allocation has NO hash gate, so either
      the user can execute it (→ takes cBTC without revealing the secret → SOLVER ROBBED)
      or only the solver executes (→ user still trusts the solver, ≈ today; solver also
      keeps sender-alone Allocation_Withdraw). Real benefits shrink to solvency-proof +
      audit trail — transparency, not trust. Keep parked.
      WHERE THE IDEA IS REAL: Canton→EVM LOOP SELLERS — user signs standard
      AllocationFactory_Allocate (user=sender, Allocation_Withdraw = their own on-ledger
      refund) instead of naked transfer-to-venue custody. Revisit there (phase 2 of the
      reverse direction), gated on Loop signing the Allocation choices.

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
  can't use the custom DAR (NO_SYNCHRONIZER) → they use a standard transfer they
  accept (or which auto-accepts via preapproval).
- Cancore's ACTUAL Loop mode (reverse-engineered from their prod bundle, 2026-06-11) =
  **transfer-to-venue custody**: Loop user signs ONE standard transfer to the venue, the
  venue runs the HTLC on its own node. NOT a trustless on-ledger HTLC for external wallets.
  Their on-node ("browser-extension") users get the full custom HTLC = our managed path.
  See docs/LOOP-CONSTRAINTS-LOCKED.md + the htlc-swap-mental-model memory.
- EVM leg is a real on-chain HTLC (keccak). Docs say SHA-256 but the deployed contract
  is keccak256 — we use keccak256.

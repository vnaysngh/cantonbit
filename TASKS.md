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

## 🔴 REMAINING — to ship the real product

Ordered. The mainline is **participant-managed** (Cancore's default = our proven path).

- [ ] **R1. Two-mode wiring (participant-managed vs Loop).**
      Branch the claim by user type:
      - participant-managed (party hosted on warpx): on-ledger HtlcLock.Claim, backend
        signs (CanActAs). The proven path — make it the default.
      - Loop-wallet (self-swap): standard TransferInstruction_Accept, backend hash gate.
      Detect mode from how the user's party is hosted / how they signed up.

- [ ] **R2. Participant-managed user onboarding.**
      Create the user's Canton party on warpx, grant the backend CanActAs over it, and
      run **EnableCC** (one-time, so the party can hold/pay CC). Needed before any swap.
      Hosted parties also need a little CC funded for Canton network fees.

- [ ] **R3. Connect the solver daemon to the on-ledger path end-to-end.**
      Daemon already exists; wire it so: user locks WBTC → daemon allocates+locks cBTC
      (HtlcLock) → user (or backend, for participant-managed) claims cBTC → daemon reads
      the revealed preimage → claims WBTC on EVM. Full auto, both legs.

- [ ] **R4. Refund / Retake (both legs) + UI.**
      - cBTC: after timelock, HtlcLock.Refund → Allocation_Withdraw (wire + button).
      - EVM: retake(hashLock) via MetaMask (button) + the Etherscan fallback path.
      - Canton-side auto-refund after timeout (Cancore parity).
      - Cover stuck swaps (e.g. WBTC locked but cBTC claim failed).

- [ ] **R5. Order lifecycle + statuses to match Cancore.**
      open → accepted → htlc_proposal_sent → htlc_active → both_claimed / refunded /
      cancelled. Add **Cancel** (maker, before any lock). Persist orders (Supabase)
      instead of in-memory.

- [ ] **R6. Timelock ladder from order expiration (Cancore params).**
      Expiration dropdown 30min–72h; min 2h for Canton; maker ≥ expiration, taker shorter.
      Derive userTimelock/solverTimelock from the chosen expiration.

- [ ] **R7. Real two-party UI run on testnet/devnet.**
      Distinct EVM wallets (user vs solver) + a participant-managed hosted user party.
      Prove WBTC moves user→solver AND cBTC moves solver→user, end to end, in the UI.

- [ ] **R8. Canton → EVM direction (reverse) in the UI.**
      User sells cBTC, buys WBTC. Mirror of the EVM→Canton flow.

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

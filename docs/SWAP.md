# WBTC (Base) → cBTC (Canton) Cross-Chain Swap

> Detailed technical reference for the single-solver cross-chain swap built in
> `contracts/` (Foundry) and `swap-solver/` (TypeScript). Written to be a
> durable record — readable cold, with no prior session context.

---

## 1. What this is

A **one-directional, single-solver, custodial cross-chain swap**: a user gives
**WBTC on Base** and receives **cBTC on Canton**. One solver (you) sits in the
middle, fronts the cBTC liquidity, and collects the WBTC.

**Direction:** WBTC (Base) → cBTC (Canton) **only**. The reverse
(cBTC → WBTC) is **not built** — see `SWAP-ROADMAP.md` (it needs a Daml-side
lock contract and is a separate project).

It is built on the **OpenIntents Framework (OIF)** *input* contracts: we reuse
the OZ-audited `InputSettlerEscrow` unchanged, add one small custom oracle, and
deliver the output (cBTC) on Canton with our own off-chain solver. We do **not**
use OIF's EVM `OutputSettler` or its Rust reference solver (both are
EVM-hardcoded; Canton is not EVM).

---

## 2. Settlement model — READ THIS FIRST

This is **two-legged, optimistic / trust-based settlement. It is NOT atomic.**

```
1. User locks WBTC in InputSettlerEscrow on Base.
2. Solver delivers cBTC to the user on Canton (transfer offer + user accept).
3. Solver attests the fill on a custom oracle (Base).
4. Solver calls finalise() → escrow staticcalls the oracle → WBTC released to solver.
```

There is a gap between legs 2 and 4. **The solver bears the completion risk.**

- **User protection:** if the solver never delivers, the user calls `refund()`
  on the escrow after `order.expires` and reclaims their WBTC. Proven on-chain.
- **Solver protection:** deliver cBTC only after the Base lock is final and with
  margin to attest + finalise before `fillDeadline`. Enforced by guards in
  `delivery.ts`.
- **Trust:** the oracle's attestor key can mark *any* fill proven and release the
  locked WBTC — with or without a real Canton delivery. It is **treasury-grade**.
  This is an explicit, accepted property of a custodial v1; it is **not
  trustless**. Whoever holds that key (and the Canton credentials) can move funds.

Why not atomic? Two independent chains can't share one transaction. *Any*
cross-chain transfer is ≥2 txs on 2 ledgers; something bridges the gap. Stock OIF
bridges it with a messaging-layer oracle (Wormhole/Hyperlane); we bridge it with
a **trusted off-chain attestor** (our agent). Same two-legged shape, simpler
trust source.

---

## 3. On-chain components (`contracts/`, Foundry)

### `InputSettlerEscrow` (OIF, unchanged, vendored)
The audited escrow that locks the user's WBTC. Key paths:
- `openFor(order, sponsor, signature)` — pulls WBTC via a **Permit2** signature
  (one user signature, no separate approve). `open(order)` is the self-deposit
  variant.
- `finalise(order, solveParams, destination, call)` — the release. Internally:
  `finalise → _validateFills → IInputOracle(order.inputOracle).efficientRequireProven(proofSeries)`.
  If the oracle says the fill is proven, the locked WBTC transfers to
  `destination` (the solver). Gated so only the solver (order owner) can call it.
- `refund(order)` — after `order.expires`, anyone can call it; returns the
  inputs to `order.user`. The user safety valve.

### `OranjAttestorOracle.sol` (our only custom contract, ~80 lines)
`contracts/src/OranjAttestorOracle.sol`. Extends OIF's `BaseInputOracle`
(inherits `isProven` / `efficientRequireProven` unchanged — the read path the
escrow staticcalls). Adds:
- `attest(remoteChainId, remoteOracle, application, dataHash)` — writes the
  `_attestations` slot, gated to a single **attestor** key. This is the exact
  write `WormholeOracle.receiveMessage` performs, but authorized by our key
  instead of a verified VAA.
- `attestBatch(...)` — batch version.
- Two-key model: `owner` (admin, can rotate the attestor) is separate from
  `attestor` (the hot signing key), so a compromised hot key can be rotated.

**The proof tuple** (what the escrow checks, per output): `(output.chainId,
output.oracle, output.settler, payloadHash)`. `_isProven` reads
`_attestations[chainId][remoteOracle][application][dataHash]`. Positionally:
`remoteOracle ← output.oracle`, `application ← output.settler`. `attest()` writes
exactly that slot.

### Tests (17/17 passing)
- `OranjAttestorOracle.t.sol` (9) — access control, attest→isProven roundtrip,
  rotation, idempotency.
- `EncodingParity.t.sol` (5) — **differential test**: shells out (FFI) to the TS
  encoder and asserts byte-equality vs the real on-chain
  `MandateOutputEncodingLib` / `StandardOrderType` for several fixtures
  (empty/with-data, max timestamp, the hash, the orderId).
- `EscrowReleasePath.t.sol` (3) — full on-chain loop: open → attest → finalise →
  WBTC released; wrong-proof stays locked; **refund returns to user after expiry**.

### Deps
Vendored in `contracts/lib/` (gitignored — restored with
`forge install foundry-rs/forge-std openintentsframework/oif-contracts`). We use
only `openzeppelin-contracts`, `permit2`, `the-compact`; the unused
`broadcaster`/arbitrum tree was dropped.

---

## 4. Off-chain solver (`swap-solver/`, TypeScript + viem)

The runtime pipeline (status machine in `store.ts`):

```
Open event (Base) → [seen]
   ↓ delivery.ts  (guard: lock final + deadline margin; verify party; check float)
createOffer cBTC (Canton, float→user) → [delivering]
   ↓ accept-watch.ts  (user accepts on Canton; capture accept record-time)
[delivered]   ← fillTimestamp = accept record-time, must be ≤ fillDeadline
   ↓ settle.ts  (attest on oracle, then finalise on escrow)
WBTC released (Base) → [finalised]
```

Other terminal states: `refunded`, `failed`.

### Component map (`swap-solver/src/`)
| File | Role |
|---|---|
| `index.ts` | Main loop: backfill watcher → live follow → each tick deliver/accept/settle + health check. |
| `env.ts` | The single validated secrets boundary. Loads agent key + Canton creds; rejects `NEXT_PUBLIC_*`; gates mainnet behind `ALLOW_MAINNET`; masks secrets. |
| `config.ts` | Per-network config + identifiers (Canton chainId sentinel, settler id). Enforces `inputOracle == output.oracle`. |
| `order.ts` | Builds the `StandardOrder`/`MandateOutput`; binds the Canton recipient as `keccak256(party)`; `verifyCantonParty` (security-critical preimage check). |
| `encoding.ts` | Byte-exact `encodeFillDescription` / `fillDescriptionHash` / `orderId` — proven equal to the on-chain lib via the FFI differential test. |
| `abi.ts` | Escrow + oracle ABI fragments (Open event, open/openFor/finalise/orderStatus, attest/isProven). |
| `watcher.ts` | Subscribes to `Open` events on Base; decodes + persists; resumable via block cursor. |
| `canton.ts` | Solver-local Canton client (port of the app's `lib/transfer.ts`): JWT, `getHoldings`/`getFloatSats`, `createOffer` (Phase-1 transfer), `isOfferActive`, `resolveOffer` (accept vs expiry + record-time). Reads use `retry`. |
| `delivery.ts` | Leg 7a: guards + float check → createOffer → `delivering`. |
| `accept-watch.ts` | Leg 7b: resolve offer (accepted/expired), capture record-time → `delivered`, or fail past deadline. |
| `settle.ts` | Leg 8: compute payloadHash → `attest` → `finalise` → `finalised`. Idempotent (skips if already proven / already Claimed). |
| `open-for.ts` | Permit2 witness signing + `openFor` assembly (the user-deposit leg). |
| `store.ts` | Crash-safe JSON order store (atomic write+rename), block cursor, status machine. |
| `convert.ts` | Serialized↔typed order conversion. |
| `retry.ts` | Exponential backoff; retries transient errors, fails fast on deterministic ones. |
| `log.ts` | Leveled structured logger; redacts secrets. |
| `monitor.ts` | Health report: at-risk (delivered-not-finalised), stuck, stale, failed, reconciliation gaps; ok/warn/critical. |
| `cli.ts` | Operator CLI: `status` / `list` / `show`. |
| `deploy.ts` | Deploys MockWBTC + escrow + oracle to a testnet, writes addresses to `.env`. |
| `e2e-full.ts` / `e2e-base.ts` / `live-canton.ts` / `check-float.ts` | Live E2E + diagnostic scripts. |

### Tests (45/45 unit passing)
`order`, `delivery`, `accept-watch`, `env`, `retry`, `monitor` test files, plus
live integration scripts (`watcher`/`settle`/`open-for`.integration.ts) run
against anvil.

### Key correctness invariants
1. **`payloadHash` must match the on-chain lib byte-for-byte** — proven by the
   FFI differential test. Gotchas baked in: 4-byte uint32 timestamp, two uint16
   length prefixes, packed (not padded) encoding.
2. **`order.inputOracle == output.oracle == our oracle`** — else the escrow asks
   one oracle but the attestation lives in another → `finalise` reverts forever.
   Enforced in config/order.
3. **`fillTimestamp` (the accept record-time) ≤ `fillDeadline`** — else the proof
   is invalid; the order is failed and the user refunds.
4. **Recipient is bound as `keccak256(cantonParty)`** (a party id is ~100 chars,
   doesn't fit in bytes32). The solver gets the preimage off-chain and
   `verifyCantonParty` checks it before delivering.

---

## 5. Liquidity / funding model

The solver pre-holds a **cBTC float** on Canton (currently the `warpx-devnet-1`
party). Each swap transfers cBTC from the float to the user, and the collected
WBTC on Base is the reimbursement. The float **depletes** as orders fill;
replenishing it (mint or rebalance) is an operational concern, not part of the
per-swap flow. `delivery.ts` refuses to deliver (marks `failed`) if the float
can't cover the amount — never half-delivers.

---

## 6. Security model

Two **treasury-grade** secrets, both server-only, never logged, never client-exposed:
1. **The EVM agent key** — signs `attest` + `finalise`; can release the entire
   escrow by attesting.
2. **The Canton credentials** (`KEYCLOAK_*`) — can act on the cBTC float.

Hardening in place: `env.ts` is the only place secrets are read (validated,
masked, NEXT_PUBLIC-rejected, mainnet-gated); `log.ts` redacts by key name;
`.env` is gitignored. Per-route session validation isn't applicable here (this is
a backend service, not the Oranj API) — the solver hardcodes which party/account
it acts as.

**Production recommendation (not yet done):** split the warpx-acting capability
into a dedicated admin token used only by the backend, separate from anything
user-facing, so a single key compromise can't drain the treasury. See roadmap.

---

## 7. Live testnet validation

Deployed + proven on **Base Sepolia** + **Canton DevNet** (real contracts, real txs).

**Deployed contracts (Base Sepolia):**
- MockWBTC: `0xf477e033ee221ca9370afa7595ab594eb3f72066`
- InputSettlerEscrow: `0x08be4b858e061236826aef215b06bb703a25b0aa`
- OranjAttestorOracle: `0x1c25296c7dfdf3cb461cc9328b66a61b0397de14`
- Deploy/start block: `42371722`
- Agent/deployer (owner = attestor): `0x0B95ec21579aee6Ef7b712976bD86689D68b5A08`

**Canton DevNet:**
- Ledger: `https://ledger-api.validator.devnet.warpx.fivenorth.io`
- Registry: `https://api.utilities.digitalasset-dev.com`
- cBTC instrument: `{ admin: cbtc-network::12202a83c6f4082217c175e29bc53da5f2703ba2675778ab99217a5a881a949203ff, id: CBTC }`
- Solver float party: `warpx-devnet-1::1220231c1885f289f90e0d08b448579c31a655b5826802c6d885258a27371039fba9`

**Full cross-chain swap completed end-to-end TWICE** (WBTC locked → cBTC
delivered → attest → finalise → WBTC released). Also: the WBTC-side loop proven
on Base Sepolia, the refund path proven on-chain (Foundry), and DevNet
auth/float-read proven live.

**Note:** the live runs hit the wallet's **auto-accept**, so the delivery
collapsed to one step. The manual two-step accept path (solver waits for the user
to accept, captures the real accept record-time) is coded + unit-tested but not
yet exercised live — disable the wallet's admin-wide auto-accept to validate it.

---

## 8. How to run

```bash
# Contracts
cd contracts
forge install foundry-rs/forge-std openintentsframework/oif-contracts   # restore deps
forge build && forge test                                               # 17 tests

# Solver
cd swap-solver
npm install
cp .env.example .env            # fill in: agent key, deployed addrs, Canton creds
npm run typecheck && npm test   # 45 unit tests

# Deploy fresh contracts to a testnet (writes addrs into .env)
node --import tsx src/deploy.ts

# Run a full live cross-chain swap
node --import tsx src/e2e-full.ts

# Run the solver loop
npm start

# Operator visibility
node --import tsx src/cli.ts status        # health + at-risk/stuck/failed
node --import tsx src/cli.ts list [status]
node --import tsx src/cli.ts show <orderId>
```

Required env (see `.env.example`): `SWAP_NETWORK`, `ORIGIN_RPC_URL`,
`ESCROW_ADDRESS`, `ORACLE_ADDRESS`, `WBTC_ADDRESS`, `ESCROW_START_BLOCK`,
`PRIVATE_KEY`/`AGENT_PRIVATE_KEY`, `CANTON_LEDGER_HOST`, `CANTON_REGISTRY_URL`,
`CANTON_ADMIN_PARTY`, `SOLVER_CANTON_PARTY`, `KEYCLOAK_*` (+
`KEYCLOAK_CLIENT_SECRET_DEVNET` for devnet).

---

## 9. Known gaps / not-done

- **Reverse direction (cBTC → WBTC)** — not built; separate project (Daml lock). See roadmap.
- **Manual two-step accept** — coded + unit-tested, not validated live (auto-accept was on).
- **Live refund/expiry E2E** — proven in Foundry, not on testnet.
- **Token-split hardening** — single all-powerful key; should split for production.
- The DevNet node had a `NOT_CONNECTED_TO_ANY_SYNCHRONIZER` outage during
  testing (a Five North node-ops issue, since recovered) — unrelated to the code.

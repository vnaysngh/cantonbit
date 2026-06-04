# Testnet E2E Runbook (Task 10)

End-to-end swap on **Base Sepolia** (origin) + **Canton DevNet** (destination).
Happy path + the destructive refund path.

## Resources needed from you

### Base Sepolia (EVM origin)
1. **RPC URL** — Base Sepolia (e.g. `https://sepolia.base.org` or your own).
2. **Deployer key** — a funded Base Sepolia account (needs a little testnet ETH
   for gas) to deploy the escrow + oracle. Get ETH from a Base Sepolia faucet.
3. **Agent key (the hot attestor/finaliser)** — a SECOND funded account, separate
   from the deployer. This is the treasury-grade signer that calls `attest()` +
   `finalise()`. Keep it dedicated to the solver.
4. **Admin/owner key** — can be the same as deployer for testnet; on mainnet it
   should be a cold key that can rotate the attestor.
5. **A test WBTC token on Base Sepolia** — either an existing test WBTC address,
   or we deploy the MockWBTC (mintable) we already have. Tell me which.
6. **A user test account** — funded with test WBTC + a little ETH, to play the
   swapper (locks WBTC via Permit2).

### Canton DevNet (destination)
7. **KEYCLOAK_* credentials** — the same client-credentials family the Oranj app
   uses (`KEYCLOAK_TOKEN_URL`, `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_CLIENT_SECRET`,
   `KEYCLOAK_SCOPE`). The solver needs its own JWT to act on Canton.
8. **A solver cBTC party with a FLOAT** — a Canton party the above token can act
   as, pre-funded with enough cBTC to deliver the test amount. This is the
   liquidity the solver fronts. (Provide the party id; ensure it holds cBTC.)
9. **A recipient (user) Canton party** — where the swapped cBTC lands. The USER
   must be able to accept the transfer offer (it's their party). For the test we
   can use a party you control on DevNet.
10. **DevNet ledger host + registry + admin party** — already in the Oranj app's
    `lib/constants.ts` for devnet; confirm they're current.

### Amounts
- Keep everything TINY (e.g. 0.0001 WBTC ↔ 0.0001 cBTC). This is a correctness
  test, not a value transfer.

## What's already prepared (no resources needed)

- `contracts/script/Deploy.s.sol` — deploys escrow + oracle, prints addresses +
  start block for the solver env.
- `swap-solver/.env.example` — every var the solver reads.
- The full solver pipeline (watch → deliver → accept → settle), unit-tested, with
  the watch + settle legs already proven against local anvil.
- Refund-path proven on-chain (test_refund_returnsToUserAfterExpiry).

## Steps (once resources are provided)

1. **Deploy** (Base Sepolia):
   ```bash
   cd contracts
   PRIVATE_KEY=<deployer> ORACLE_OWNER=<admin> ORACLE_ATTESTOR=<agent> \
     forge script script/Deploy.s.sol --rpc-url $BASE_SEPOLIA_RPC --broadcast
   ```
   Note the printed ESCROW_ADDRESS / ORACLE_ADDRESS / ESCROW_START_BLOCK.

2. **Configure the solver**: copy `.env.example` → `.env`, fill in the deployed
   addresses + the agent key + the Canton creds + the solver float party.

3. **Fund the float**: ensure SOLVER_CANTON_PARTY holds enough cBTC on DevNet.

4. **User locks WBTC** (Permit2 `openFor`): the user signs a Permit2 witness over
   the StandardOrder; we submit `openFor`. (Helper script: `scripts/open-for.ts`
   — built next.) The recipient is bound as keccak256(user's Canton party).

5. **Run the solver**: `npm start`. It backfills the Open event, creates the cBTC
   offer to the user's party, waits for the user to accept, then attests +
   finalises → WBTC to the agent.

6. **User accepts** the cBTC offer on DevNet (their party). The solver detects
   the accept, captures the record-time, settles.

7. **Verify**: agent received the WBTC on Base Sepolia; user holds the cBTC on
   DevNet. Record tx hashes + the Canton update ids.

8. **Refund path** (destructive): open a second order, do NOT have the solver
   finalise (or stop it), let `expires` pass, then the user calls `refund()` and
   reclaims their WBTC. Confirm.

---

## Validation scripts (live testnet drills)

Each is a standalone script. **Canton creds live in the Oranj app's
`.env.local`; the EVM addresses + agent key live in `swap-solver/.env`.**

> ⚠️ **ENV LOAD ORDER MATTERS.** Both files define `KEYCLOAK_CLIENT_ID`, but the
> values differ: `.env.local` has the **21-char app/mainnet** id, `.env` has the
> **20-char DevNet** id. DevNet auth needs the **20-char** id + the
> `KEYCLOAK_CLIENT_SECRET_DEVNET` secret. So always load **`.env.local` FIRST,
> `.env` LAST** for any Canton-touching script, so the DevNet id wins. Loading in
> the wrong order pairs the mainnet id with the devnet secret → `invalid_grant`.

Base-only scripts (no Canton) just need `.env`:

```bash
# V1 — refund / expiry (Base only). Locks WBTC, waits past expiry, refunds. ~3 min.
node --env-file=.env --import tsx src/e2e-refund.ts
```

Canton-touching scripts need both, in this order:

```bash
# V3 — insufficient float. Asks for more cBTC than the float; asserts refusal,
#      no offer, float intact. Zero risk (never delivers). ~20s.
node --env-file=../.env.local --env-file=.env --import tsx src/e2e-insufficient-float.ts

# Float check (diagnostic).
node --env-file=../.env.local --env-file=.env --import tsx src/check-float.ts

# V2 / happy path — full swap. Manual two-step accept requires the wallet's
#      admin-wide AUTO-ACCEPT to be OFF; then accept the offer in the wallet
#      when prompted. With auto-accept ON it collapses to one step.
node --env-file=../.env.local --env-file=.env --import tsx src/e2e-full.ts
```

### Status of the drills
- **V1 refund/expiry** — ✅ passed live (Base Sepolia). Validated: lock →
  Deposited, early refund reverts, post-expiry refund returns WBTC → Refunded,
  double-refund reverts.
- **V3 insufficient float** — ✅ passed live (DevNet). Validated: solver refuses,
  status=failed, no offer created, float unchanged.
- **V2 manual two-step accept** — ⏳ needs the wallet auto-accept toggle OFF, then
  a live run + manual accept. Happy path itself already proven (auto-accept ON).

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

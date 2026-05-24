# cBTC Minting App

Frontend app for minting, burning, and transferring cBTC on Canton Network.
Built on WarpX's Five North validator node.

## What this app does

- View cBTC balance
- Send cBTC to another Canton party
- Receive cBTC from another party
- Mint cBTC from Bitcoin (Minter only — pending BitSafe access)
- Redeem cBTC to Bitcoin (Minter only — pending BitSafe access)

## Infrastructure

DevNet Ledger API:
https://ledger-api.validator.devnet.warpx.fivenorth.io

Mainnet Ledger API:
https://ledger-api.validator.warpx.fivenorth.io

Auth system: Authentik
Get JWT from: validator devnet m2m (Application > Provider in Authentik)
Token expires: every 8 hours — always auto-refresh

Party ID (partial): warpx-devnet-1::1220231c1885f28...

## Tech stack

Next.js 14+ (App Router), TypeScript, Tailwind CSS, shadcn/ui
Loop wallet: @fivenorth/loop-sdk (see https://docs.fivenorth.io/)
Canton API: JSON Ledger API (REST) — used server-side for read paths;
  user-side writes go through the Loop provider (provider.submitTransaction).

## cBTC Token Standard Configuration

These are the real confirmed values. Not placeholders.
Token Standard API reference:
https://docs.dev.sync.global/app_dev/token_standard/index.html#api-references

### DevNet (use this for development)

DECENTRALIZED_PARTY_ID (admin):
cbtc-network::12202a83c6f4082217c175e29bc53da5f2703ba2675778ab99217a5a881a949203ff

REGISTRY_URL:
https://api.utilities.digitalasset-dev.com

COORDINATOR_URL:
https://devnet.dlc.link/attestor-2

Instrument ID:
{ admin: "cbtc-network::12202a83c6f4082...", id: "CBTC" }

Metadata endpoint:
https://api.utilities.digitalasset-dev.com/api/token-standard/v0/registrars/
cbtc-network::12202a83c6f4082217c175e29bc53da5f2703ba2675778ab99217a5a881a949203ff
/registry/metadata/v1/instruments

### Testnet

DECENTRALIZED_PARTY_ID (admin):
cbtc-network::12201b1741b63e2494e4214cf0bedc3d5a224da53b3bf4d76dba468f8e97eb15508f

REGISTRY_URL:
https://api.utilities.digitalasset-staging.com

COORDINATOR_URL:
https://testnet.dlc.link/attestor-1

### Mainnet

DECENTRALIZED_PARTY_ID (admin):
cbtc-network::12205af3b949a04776fc48cdcc05a060f6bda2e470632935f375d1049a8546a3b262

REGISTRY_URL:
https://api.utilities.digitalasset.com

COORDINATOR_URL:
https://mainnet.dlc.link/attestor-1

## What is still mocked (pending BitSafe access)

Search for TODO(bitsafe) to find every mocked call.

Mocked calls:

- POST /app/get-account-contract-rules
- POST /app/get-bitcoin-address
- POST /app/get-token-standard-contracts
- Minter credential check

NOT mocked anymore (real values confirmed above):

- DECENTRALIZED_PARTY_ID — confirmed for all networks
- REGISTRY_URL — confirmed for all networks
- Instrument ID — { admin: DECENTRALIZED_PARTY_ID, id: "CBTC" }
- Token standard metadata endpoint — confirmed for all networks

When BitSafe access is ready:

1. Set real NEXT_PUBLIC_BITSAFE_API_URL in .env.local
2. Replace mocks in lib/bitsafe.ts with real calls
3. Remove TODO(bitsafe) comments

## What the Token Standard gives us

The registry URL + registrar party ID unlocks the Token Standard API.
This means transfer, accept, and balance queries work WITHOUT
BitSafe API access. We can build the full transfer and balance
flow today using the Token Standard API directly.

Key Token Standard endpoints (all real, all available now):
GET <REGISTRY_URL>/api/token-standard/v0/registrars/<admin>/
registry/metadata/v1/instruments
POST <REGISTRY_URL>/api/token-standard/v0/registrars/<admin>/
registry/transfer-instruction/v1/<contractId>/choice-contexts/accept

These are the choice context endpoints needed for accepting transfers.
No BitSafe API key needed — these are public registry endpoints.

## Important constraints

UTXO limit: max 10 per party — warn user at 8
Canton speed: a few seconds per transfer, ~500 per 10 minutes
Bitcoin confirmations: 6 required, ~60 minutes
JWT: expires every 8 hours — auto-refresh is non-negotiable
Party IDs: always truncate for display (first 8...last 8 chars)
Amounts: always display in BTC units, never satoshis

## Key resources

Token Standard API docs:
https://docs.dev.sync.global/app_dev/token_standard/index.html#api-references
BitSafe API collection:
https://github.com/DLC-link/api-collections-public
cBTC DAR files:
https://github.com/DLC-link/cbtc-lib/tree/main/cbtc-dars
cbtc-lib examples:
https://github.com/DLC-link/cbtc-lib/tree/main/examples
Five North docs:
https://docs.fivenorth.io/
Canton JSON API:
https://docs.daml.com/json-api/

## Current state

### Completed

- [ ] Task 1: Project scaffold + env setup
- [ ] Task 2: JWT auth with auto-refresh
- [ ] Task 3: Loop wallet connection
- [ ] Task 4: Canton API client (lib/canton.ts)
- [ ] Task 5: BitSafe API client with mocks (lib/bitsafe.ts)
- [ ] Task 6: Token Standard client (lib/tokenstandard.ts)
- [ ] Task 7: useBalance hook
- [ ] Task 8: Dashboard screen
- [ ] Task 9: Send screen + transfer flow
- [ ] Task 10: Receive screen
- [ ] Task 11: Activity screen
- [ ] Task 12: Mint screen (mocked Bitcoin address)
- [ ] Task 13: Redeem screen (mocked flow)
- [ ] Task 14: Shared components polish

### In progress

<!-- e.g. Task 3 — wallet connection working, testing auto-reconnect -->

### Pending (external dependencies)

- [ ] Upload cBTC DARs to warpx node via 5N Dashboard
- [ ] Get Holder/Minter credential from BitSafe
- [ ] Get BITSAFE_API_URL from BitSafe

### Decisions made during build

<!-- record any decisions made beyond this document -->

### Known issues

<!-- e.g. Transfer factory contract ID needs confirming from metadata endpoint -->

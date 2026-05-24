# DLC Yaak Collection — Implementation Reference

Source: https://github.com/DLC-link/api-collections-public (Yaak workspace `CBTC-UserFlow`).
Fetched 2026-05-23. **This is the canonical reference** — when in doubt, the Yaak collection
is ground truth, not cbtc-lib's Rust source, not docs.

## Environments (per-network constants)

| Variable | Devnet | Testnet | Mainnet |
|---|---|---|---|
| coordinator_url | `https://devnet.dlc.link/attestor-2` | `https://testnet.dlc.link/attestor-1` | `https://mainnet.dlc.link/attestor-1` |
| canton_network (chain) | `canton-devnet` | `canton-testnet` | `canton-mainnet` |
| dec_party | `cbtc-network::12202a83c6f4082217c175e29bc53da5f2703ba2675778ab99217a5a881a949203ff` | `cbtc-network::12201b1741b63e2494e4214cf0bedc3d5a224da53b3bf4d76dba468f8e97eb15508f` | `cbtc-network::12205af3b949a04776fc48cdcc05a060f6bda2e470632935f375d1049a8546a3b262` |
| utility_registry_url | `https://api.utilities.digitalasset-dev.com` | `https://api.utilities.digitalasset-staging.com` | `https://api.utilities.digitalasset.com` |
| BTC network used | regtest (`bcrt1p...`) | testnet3 (`tb1...`) | mainnet (`bc1...`) |

These are already in `lib/constants.ts` — only the `chain` value needs adding.

## Template IDs (cBTC DARs)

```
#cbtc:CBTC.DepositAccount:CBTCDepositAccount
#cbtc:CBTC.DepositAccount:CBTCDepositAccountRules
#cbtc:CBTC.WithdrawAccount:CBTCWithdrawAccount
#cbtc:CBTC.WithdrawAccount:CBTCWithdrawAccountRules
#cbtc:CBTC.WithdrawRequest:CBTCWithdrawRequest
```

## Interface IDs (Token Standard)

```
#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding
#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory
#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction
```

## Coordinator endpoints (no auth)

All take `Content-Type: application/json`.

### `POST {coordinator_url}/app/get-account-contract-rules`
Body: `{"chain": "canton-devnet"}`
Returns: `{ da_rules: {contract_id, template_id, created_event_blob}, wa_rules: {...} }`

### `POST {coordinator_url}/app/get-bitcoin-address`
Body: `{"id": "<DepositAccount contract_id>", "chain": "canton-devnet"}`
Returns: `{address: "bcrt1p..."}`

### `POST {coordinator_url}/app/get-token-standard-contracts`
Body: `{"chain": "canton-devnet"}`
Returns: `{ burn_mint_factory: {...}, instrument_configuration: {...}, app_reward_configuration: {...}, featured_app_right: {...}, issuer_credential: {...} }`

## Mint flow (in order)

1. **Get account rules** — `get-account-contract-rules`, capture `da_rules`.
2. *(optional)* List existing deposit accounts — `active-contracts` filter on `CBTCDepositAccount` template.
3. **Create deposit account** — exercise `CBTCDepositAccountRules_CreateDepositAccount` on `da_rules.contract_id` with `{owner: user_party}`. Disclose `da_rules`. Parse response transaction tree for the newly-created `CBTCDepositAccount` contract id.
4. **Get Bitcoin address** — `get-bitcoin-address` with the new deposit account's contract id.
5. **User sends BTC** to the address (out-of-band).
6. **Watch holdings** — poll `active-contracts` for `Holding` interface filtered by user_party until balance increases.

### Choice argument (CreateDepositAccount)
```json
{
  "owner": "<user_party>"
}
```

**NB:** Yaak's basic flow does NOT include `credentialCids`. cbtc-lib's Rust adds it for credentialed scenarios; we don't need it.

## Burn flow (in order)

1. **Get account rules** — same call as mint, capture `wa_rules`.
2. *(optional)* List existing withdraw accounts — `active-contracts` filter on `CBTCWithdrawAccount` template.
3. **Create withdraw account** — exercise `CBTCWithdrawAccountRules_CreateWithdrawAccount` on `wa_rules.contract_id` with `{owner: user_party, destinationBtcAddress: "bcrt1q..."}`. Disclose `wa_rules`.
4. **Get token standard contracts** — `get-token-standard-contracts`, capture all 5 contracts.
5. **List holdings** — `active-contracts` filter on `Holding` interface, capture contract ids of holdings to burn.
6. **Exercise withdraw** — `CBTCWithdrawAccount_Withdraw` on the WithdrawAccount contract id with full extraArgs context. Disclose all 5 token-standard contracts.
7. **Watch withdraw requests** — poll `active-contracts` for `CBTCWithdrawRequest` template; the request transitions through statuses.

### Choice argument (CreateWithdrawAccount)
```json
{
  "owner": "<user_party>",
  "destinationBtcAddress": "bcrt1q..."
}
```

### Choice argument (CBTCWithdrawAccount_Withdraw)
```json
{
  "amount": "0.1",
  "tokens": ["<holding_contract_id>"],
  "burnMintFactoryCid": "<from get-token-standard-contracts>",
  "extraArgs": {
    "context": {
      "values": {
        "utility.digitalasset.com/instrument-configuration": {
          "tag": "AV_ContractId",
          "value": "<instrument_configuration.contract_id>"
        },
        "utility.digitalasset.com/app-reward-configuration": {
          "tag": "AV_ContractId",
          "value": "<app_reward_configuration.contract_id>"
        },
        "utility.digitalasset.com/featured-app-right": {
          "tag": "AV_ContractId",
          "value": "<featured_app_right.contract_id>"
        },
        "utility.digitalasset.com/issuer-credentials": {
          "tag": "AV_List",
          "value": [
            {"tag": "AV_ContractId", "value": "<issuer_credential.contract_id>"}
          ]
        }
      }
    },
    "meta": {
      "values": {
        "splice.lfdecentralizedtrust.org/reason": "CBTC Burn"
      }
    }
  }
}
```

### Disclosed contracts for withdraw (all 5):
- burn_mint_factory
- featured_app_right
- instrument_configuration
- issuer_credential
- app_reward_configuration

## Critical conventions

- **`actAs`** in every submit-and-wait call is `[user_party]`.
- **`commandId`** must be unique per submit (UUID).
- **`synchronizerId`** in disclosed contracts is empty string `""` in the canonical collection.
- **`activeAtOffset`** in active-contracts queries is the integer offset from `/v2/state/ledger-end`.
- Status is determined by **re-querying contracts**, not by polling a coordinator endpoint.

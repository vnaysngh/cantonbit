# Multi-Asset EVM <-> Canton Swap Plan

## Summary

Add v1 executable support for:

- `WBTC <-> CBTC`
- `mock USDC <-> USDCx`

Use the existing EVM test environment instead of moving to Ethereum Sepolia. For
v1 testing, deploy or configure a mock 6-decimal USDC token on the same Arbitrum
Sepolia setup already used for swap testing. Quote `mock USDC <-> USDCx` at
hardcoded 1:1, minus the configured solver/platform fee.

`CC` remains a Canton readiness/fee asset only: show/check CC balance for Canton
transaction readiness, but do not quote CC swaps in v1.

## Key Changes

- Add a shared asset registry:
  - EVM assets: `WBTC` with 8 decimals, `USDC` with 6 decimals.
  - Canton assets: `CBTC`, `USDCx`, `CC`.
  - Each asset stores symbol, decimals, display precision, EVM token address or
    Canton `InstrumentId`, and enabled pair ids.
  - Arbitrum Sepolia `USDC` is configured via env, for example
    `NEXT_PUBLIC_USDC_ADDRESS`, and is treated as mock USDC in non-production.
  - DevNet `USDCx` is configured via env, for example
    `CANTON_USDCX_ADMIN_DEVNET`, until its registrar/admin is confirmed.

- Replace token-specific quote shape with pair-aware quote shape:
  - Request: `{ direction, fromAsset, toAsset, amount, userEvmAddress, userCantonParty }`.
  - Response:
    `{ pairId, fromAsset, toAsset, fromAmountBaseUnits, toAmountBaseUnits, cantonAmountDecimal, evmTokenAddress, cantonInstrumentId, feeBps, price, expires }`.
  - Keep temporary backward compatibility for current `wbtcAmount/cbtcAmount`
    callers during migration.

- Quote logic:
  - `WBTC <-> CBTC`: keep existing WBTC/BTC price logic and depeg guard; CBTC is
    BTC-denominated.
  - `mock USDC <-> USDCx`: hardcode 1:1 value for now.
  - Fee applies to output for both pairs:
    - `WBTC -> CBTC`: `cbtcOut = pricedWbtcValue - fee`
    - `CBTC -> WBTC`: `wbtcOut = pricedCbtcValue - fee`
    - `USDC -> USDCx`: `usdcxOut = usdcIn - fee`
    - `USDCx -> USDC`: `usdcOut = usdcxIn - fee`
  - Use integer base-unit math with token decimals; no `parseFloat`.
  - Server re-quotes on order creation and rejects manipulated or stale outputs
    per pair.

- Generalize settlement:
  - EVM HTLC already supports arbitrary ERC-20 token addresses; pass the selected
    pair's `evmTokenAddress` instead of hard-coded WBTC.
  - Canton allocation/transfer code accepts selected `instrumentId` instead of
    always using `NETWORK.instrumentId`.
  - Order records store generic fields: `evm_token`, `evm_symbol`,
    `evm_decimals`, `evm_amount`, `canton_instrument_admin`,
    `canton_instrument_id`, `canton_symbol`, `canton_amount`.
  - Keep legacy `wbtc_amount/cbtc_amount` readable until existing orders are
    terminal.

- UI behavior:
  - Swap page gets token selectors constrained to enabled pairs.
  - Show balances for selected EVM token and selected Canton token.
  - Show exact fee and final receive amount in review.
  - Show CC fee readiness separately for Canton actions.
  - CC appears in balances/readiness, not in the swap pair selector for v1.
  - Review, progress, history, and recovery copy use selected symbols instead of
    hard-coded WBTC/CBTC.

## Test Plan

- Unit tests:
  - Asset registry resolves `WBTC<->CBTC` and `USDC<->USDCx`.
  - Amount parsing/formatting for WBTC 8 decimals and USDC 6 decimals.
  - `WBTC <-> CBTC` quote still applies WBTC/BTC price and fee.
  - `USDC <-> USDCx` quote is exact 1:1 minus fee.
  - Fee rounding floors in favor of solvency and never outputs negative/zero for
    valid minimums.
  - Order creation rejects wrong pair, wrong EVM token, wrong Canton instrument,
    manipulated output, stale quote, and unsupported CC swap.

- Contract tests:
  - Existing HTLC tests continue passing.
  - Add `MockUSDC` with 6 decimals and prove lock, claim, retake.
  - Keep fee-on-transfer rejection test for all ERC-20 assets.

- Daml/DPM tests:
  - Existing CBTC HTLC tests continue passing.
  - Add instrument-binding tests using `USDCx`.
  - Verify claim/refund reject mismatched amount and mismatched instrument.

- Arbitrum Sepolia + Canton DevNet smoke tests:
  - Deploy/configure mock USDC on Arbitrum Sepolia.
  - Fund user and solver with Arbitrum Sepolia ETH.
  - Mint mock USDC to the user and solver as needed.
  - Fund solver/user Canton DevNet parties with CBTC and confirmed DevNet USDCx.
  - Run email participant flows:
    - `WBTC -> CBTC`
    - `CBTC -> WBTC`
    - `USDC -> USDCx`
    - `USDCx -> USDC`
  - Run Loop flows where supported:
    - `EVM -> Canton Loop` remains reveal-first trust-minimized.
    - `Canton -> EVM Loop` remains custody/reveal design.
  - Negative smoke:
    - Wrong EVM token locked for quote.
    - Wrong Canton instrument allocation.
    - Solver insufficient float after fee.
    - User never reveals, then refund/retake succeeds.
    - User reveals, solver can claim before timeout.

## Assumptions

- We stay on the existing Arbitrum Sepolia-style test environment and use mock
  USDC there.
- `mock USDC <-> USDCx` is hardcoded 1:1 for v1.
- Fee is charged on output for every pair and direction.
- `CC` is only checked for Canton fee readiness in v1.
- DevNet USDCx still needs confirmed `InstrumentId.admin` and registry URL before
  E2E can pass.
- Existing hardened DAR remains usable because it already binds `InstrumentId`;
  app code must pass the selected instrument.

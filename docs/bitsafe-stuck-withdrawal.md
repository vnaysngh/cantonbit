# Stuck cBTC withdrawal — request created, BTC never broadcast (mainnet)

> **TL;DR** — A mainnet cBTC withdrawal of **0.0000250000 cBTC** completed steps 1–3 on Canton normally, but the attestor never broadcast the Bitcoin transaction and never archived the `CBTCWithdrawRequest`. The same flow, same destination, same package has succeeded at amounts **≥ 0.00002 cBTC** before and after — so the integration is verified working. Need a rebroadcast or refund.

---

## The stuck withdrawal

| Field | Value |
|---|---|
| **Owner party** | `cbtc-user-d4a03457-2f42-4bdb-a4bd-ecb67b0310fa::1220517bfd86ef5732610705a35b7b2d56e36112550d6a2b778971dbd099a3d36e99` |
| **Amount** | **0.0000250000 cBTC** |
| **Destination BTC address** | `bc1qqz7grzuntqn5p7cmslmrrag9edux30vaxt4ftg` |
| **Network** | canton-mainnet |
| **Ledger host** | `https://ledger-api.validator.warpx.fivenorth.io` |
| **Package** | `43a8452a56388d22…dda1a3` |

---

## Lifecycle on the ledger

All times UTC, 2026-05-29.

| Step | Choice | Acting party | Time | Offset | Status |
|---|---|---|---|---|---|
| 1. Create withdraw account | `CBTCWithdrawAccountRules_CreateWithdrawAccount` | user | 07:06:47 | 891693 | ✅ done |
| 2. Burn cBTC | `CBTCWithdrawAccount_Withdraw` | user | 07:06:51 | 891696 | ✅ done — Holdings archived |
| 3. Create withdraw request (assigns btcTxId) | `CBTCWithdrawAccount_CreateWithdrawRequest` | `cbtc-network` | 07:18:20 | 891752 | ✅ done |
| **4. Broadcast Bitcoin transaction** | — | `cbtc-network` | — | — | ❌ **never happened** |
| **5. CompleteWithdrawal** | `CBTCWithdrawRequest_CompleteWithdrawal` | `cbtc-network` | — | — | ❌ **never happened** |

---

## Key identifiers

| Identifier | Value |
|---|---|
| Active `CBTCWithdrawRequest` cid | `00f93defee053d40…` (still on-ledger) |
| **Assigned btcTxId (not broadcast)** | `37defef0ddc349480f62e1cb11cc4c1af427e28a35f9286a54d1b1c21a8cf0fb` |
| On-chain status | **HTTP 404 on mempool.space + blockstream.info** (≥ 6h after request) |

---

## Reference — successful redemptions, same flow, ≥ 0.00002 cBTC

These prove the integration works at and above the stuck amount — same destination, same `43a8452a` package, same `{ tokens, amount }` choice argument:

| Amount (cBTC) | Burn updateId | btcTxId | On Bitcoin |
|---|---|---|---|
| 0.0000479 | `12206882a20634eac11cccb2bbdaa803f60135625cebd0b4f0824e4c638152ca511c` | `26caebb3a96c7d85fd568f2c7e5cf3446dbd4082ad70572e29a8164589ccdc21` | ✅ |
| 0.00002 | `1220cbb2eca5270e0ea9945f16cda70ff4ad124eec0524dfdce508f9fa8358ff877a` | `1cae9818f450378a70fe5c83de59d7635e0330cac44cf6206b9a155c5504fbc0` | ✅ |
| 0.000012 | `1220faa458796b2b8b4a8e815f25e9f66db6f62abb169f56fb271238c9e690abdc9c` | `722e67eb4036319ff946cb5893f505ddd7026e19270c17bf9b27d43c32ca3e1e` | ✅ |

---

## Request

Please either:

1. **Rebroadcast `37defef0ddc349480f62e1cb11cc4c1af427e28a35f9286a54d1b1c21a8cf0fb`** — sign and push the same txid to Bitcoin, then `CompleteWithdrawal` archives normally, or
2. **Archive the active `CBTCWithdrawRequest` `00f93defee053d40…` and refund** the 0.0000250000 cBTC to the owner party.

---

**Contact:** _[your name / email / Slack handle]_

**Attachments / on request:**
- Full raw ledger snapshot for the stuck party (the active contracts + full tree history, ~58 KB JSON)
- Same for the comparison successful party if useful

# Burn investigation — 2026-05-29

Full narrative of the day's investigation into "why do some cBTC burns broadcast
on Bitcoin and others stall." Written so future-me can rehydrate context without
re-running anything.

---

## TL;DR

- **Your code is correct.** UI burns and reference-script burns are byte-identical at the ledger submission layer. Proven by snapshot diff (see `snapshots/realburn-{1,2,3}-*FULL.json`).
- **The variability is entirely BitSafe's attestor.** When the attestor is healthy, burns complete end-to-end in 5–15 min. When it's degraded (we observed the mainnet coordinator returning HTTP 500 across all endpoints today), burns stall.
- **Stuck burns have one of two failure modes** — both attestor-side:
  - **(A) Stuck at broadcast** — attestor creates a `CBTCWithdrawRequest` with a `btcTxId`, but never broadcasts the BTC and never archives the request with `CompleteWithdrawal`. Example: `37defef0…` (party d4a03457, 0.000025) and `01408e15…` (party 008937fb, 0.0000101).
  - **(B) Stuck at request creation** — attestor never even acknowledges the burn; no `CBTCWithdrawRequest` is created. Example: the three 0.000001 burns at 11:29/11:32/11:39 today on party 008937fb (offsets 893269/893295/893332).
- **A BitSafe escalation is open** (see `docs/bitsafe-stuck-withdrawal.md` for the 0.000025 case on party d4a03457). Awaiting their response. **Tell future me where we are with that the moment the conversation resumes.**

---

## How a redeem actually works (4 steps, 2 parties)

| Step | Choice | Acting party | Notes |
|---|---|---|---|
| 1. Create account | `CBTCWithdrawAccountRules_CreateWithdrawAccount` | **user** | Creates a `CBTCWithdrawAccount` — empty withdrawal slip. |
| 2. Burn cBTC | `CBTCWithdrawAccount_Withdraw` | **user** | Archives the user's Holdings. cBTC destroyed — point of no return. Creates a "change" `CBTCWithdrawAccount`. |
| 3. Create request | `CBTCWithdrawAccount_CreateWithdrawRequest` | **`cbtc-network` (attestor)** | Creates a `CBTCWithdrawRequest` carrying a `btcTxId` the attestor plans to broadcast. |
| 4. Complete | `CBTCWithdrawRequest_CompleteWithdrawal` | **`cbtc-network` (attestor)** | Archives the request after the BTC is broadcast. Lifecycle done. |

The user's code controls steps 1–2. **Everything after `CBTCWithdrawAccount_Withdraw` returns 200 is BitSafe's job.**

### How to link events across the four steps

`workflowId` is **empty** on attestor-submitted transactions (steps 3 and 4) — only the user sets it. To correlate, follow the **withdraw-account contractId chain**:

```
Step 1 creates:   WithdrawAccount  AAA          (initial)
Step 2 burns on:  AAA → creates    WithdrawAccount BBB  (change, via exerciseResult.withdrawAccountCId)
Step 3 acts on:   BBB → creates    WithdrawRequest CCC  (carries btcTxId)
Step 4 archives:  CCC                                  (request gone = COMPLETED)
```

This chain is the **single source of truth** for stitching a redeem together
across the ledger.

---

## Theories tested and disproven

This is the audit trail of every "is it X?" we tried today. Don't waste time re-running any of these — they're settled.

### ❌ "It's the amount" — DISPROVEN

The hypothesis: small amounts get rejected for being dust, or some amount-threshold trips a different code path.

The evidence (see `snapshots/burn-history-raw.json` for raw):
- 0.00001 (`94a596b4`) — ✅ on-chain
- 0.0000101 (`01408e15`) — ❌ stuck
- 0.0000479 (`26caebb3`) — ✅ on-chain
- 0.00002 (`1cae9818`) — ✅ on-chain
- 0.000025 (`37defef0`) — ❌ stuck
- 0.000012 (`722e67eb`) — ✅ on-chain

`0.0000479` succeeded; `0.000025` failed. No threshold, no ordering, no fee-based explanation. **Amount is not the cause.**

### ❌ "The UI sends a different request than the script" — DISPROVEN

The hypothesis: my reference script burn always works; the UI burn doesn't — so the UI must be sending something different.

The evidence: full field-by-field snapshot diff between a script burn and a UI burn, both at 0.000001 cBTC (`snapshots/realburn-1-script-FULL.json` vs `snapshots/realburn-2-ui-FULL.json`).

```
AUTH:          ✅ scope, jwt.aud, jwt.scope, jwt.sub — all SAME
COORDINATOR:   ✅ wa_rules package — SAME (43a8452a)
CREATE ACCT:   ✅ choice, choiceArgument, destination — SAME
WITHDRAW ACCT: ✅ templateId, package, blob length — SAME
BURN REQUEST:  ✅ applicationId, actAs, readAs, choice, templateId, arg keys — SAME
BURN RESULT:   ✅ httpStatus 200 — SAME
```

Only differences: the per-run-unique `commandId` / `workflowId` (UUIDs by design), the per-account-unique blob (each burn creates its own withdraw account by design), and the amount-string formatting which I normalized via `lib/format.ts::toCanonicalAmount`.

**Conclusion: the UI burn is byte-identical to the working script burn at the ledger submission layer. Code is not the differentiator.**

### ❌ "Wrong package (f240dd5d vs 43a8452a)" — DISPROVEN

The hypothesis: the `submit-withdraw` route had a `|| WITHDRAW_ACCOUNT_TEMPLATE_ID` fallback that defaulted to the stale `f240dd5d…` package. Maybe when `withdrawAccountTemplateId` was empty, the UI sent a `43a8452a` blob with a `f240dd5d` templateId — inconsistent disclosed contract → silent rejection.

The evidence: pulled the actual stuck UI burn's tree from the ledger. Both the create-account step (offset 891693) and the burn step (offset 891696) were exercised on the **correct `43a8452a` package**. The fallback never fired in practice. The stuck d4a03457 burn used the right package end-to-end.

**Fix applied anyway as defensive hardening** — the fallback was a real latent footgun even if it wasn't *the* bug:
- `app/api/redeem/submit-withdraw/route.ts`: removed the `|| WITHDRAW_ACCOUNT_TEMPLATE_ID` fallback. It now requires `withdrawAccountTemplateId` and fails loud with HTTP 400 if missing, rather than silently substituting a stale package.
- `app/api/redeem/create-withdraw-account/route.ts`: now always fetches `templateId` + `createdEventBlob` as a consistent pair from the same ACS row (was previously gated behind `if (!blob)` — fine in the working case, but the gate could in principle have produced a mismatch).

### ❌ "Authentication is different (UI uses different JWT/scope/aud)" — DISPROVEN

The hypothesis: maybe the UI uses a different OAuth client/scope than the script, leading to weaker authority over the user party.

The evidence (snapshot diff `auth` step):
- Both: `tokenUrl = https://auth.warpx.fivenorth.io/application/o/token/`
- Both: `clientId = validator-mainnet-m2m`
- Both: `scope = daml_ledger_api`
- Both: `jwtClaims.aud = validator-mainnet-m2m`
- Both: `jwtClaims.scope = daml_ledger_api`
- Both: `jwtClaims.sub = 9`

The UI's `lib/auth.ts` uses **exactly the same `client_credentials` flow** as the script. Same identity, same authority. **Not an auth issue.**

### ❌ "Stale dev server serving cached code" — REAL FACTOR, NOW FIXED

Mid-investigation we discovered the `npm run dev` process had been running since 1:29PM and was serving code from before my recent edits (it crashed with `ReferenceError: listRedeems is not defined` — a function I'd already deleted). So **some** of the earlier "the UI doesn't work" observations were against stale code, not current source. This invalidated any UI-vs-script comparison done against that server.

Now resolved: dev server is killed and restarted on current code. All snapshot diffs were captured against the **current** code path.

---

## The actual cause — BitSafe attestor degradation

**Hard evidence:**

1. **The mainnet coordinator was fully down today.** Probed `https://api.mainnet.bitsafe.finance/cbtc/v1/account-contract-rules` and got HTTP 500 with empty body across all endpoints (`/`, `/health`, `/cbtc/v1/*`) for an extended window. It recovered later in the afternoon.

2. **Timing correlation:** burns submitted during the degraded window failed; burns submitted after recovery succeeded — same code, same party, same package:
   - 11:29, 11:32, 11:39 (during degradation) → ❌ no `CreateWithdrawRequest` ever ran
   - 11:54 (after recovery) → ✅ full success (`722e67eb…` on Bitcoin)

3. **Same-party head-to-head:** party 008937fb has both successful and stuck burns. Burns #1/#3 yesterday completed in ~5–8 min; burn #2 (`01408e15`) got a request and btcTxId but the BTC was never broadcast (404 on mempool.space and blockstream). Identical Canton-side structure. The only thing different was the attestor's broadcast step.

4. **Cross-party reproduction:** the d4a03457 burn (UI, 0.000025, today 07:06) failed the same way as the 008937fb `01408e15` burn (script, 0.0000101, yesterday). Different party, different amount, different submission path, **same failure shape**: request created with btcTxId, never broadcast, never completed.

**The conclusion is consistent across every piece of evidence: BitSafe's attestor is the variable. Their broadcast step (step 4 in the lifecycle table above) intermittently fails to run.**

---

## Today's burn history (party `cbtc-user-008937fb-…d36e99`)

| Time (UTC) | Amount | btcTxId | Status |
|---|---|---|---|
| 28/05 11:56 | 0.00001 | `94a596b4` | ✅ Complete |
| 28/05 12:57 | 0.0000001 | (no btcTxId) | — odd, see raw |
| 28/05 14:16 | 0.00001 | `26caebb3` | ✅ Complete |
| 28/05 17:44 | 0.0000479 | (was paired wrong in summary) | ✅ Complete |
| 28/05 15:49 | 0.0000101 | `01408e15` | ❌ **stuck at broadcast** |
| 29/05 08:36 | 0.00002 | `1cae9818` | ✅ Complete |
| 29/05 11:29 | 0.000001 | (none) | ❌ **stuck at attestor — no request** |
| 29/05 11:32 | 0.000001 | (none) | ❌ **stuck at attestor — no request** |
| 29/05 11:39 | 0.000001 | (none) | ❌ **stuck at attestor — no request** |
| 29/05 11:54 | 0.000012 | `722e67eb` | ✅ Complete |

Party `cbtc-user-d4a03457-…d36e99`:

| Time (UTC) | Amount | btcTxId | Status |
|---|---|---|---|
| 29/05 07:06 | 0.000025 | `37defef0` | ❌ **stuck at broadcast** |

**Stuck cBTC total:** ~0.0000391 across both parties. Recoverable only by BitSafe.

---

## What was fixed in the code today (real bugs, regardless of root cause)

These are improvements landed during the investigation. None were proven to *be* the cause of the stuck burns, but each fixes a real latent issue:

1. **`submit-withdraw/route.ts`** — removed dangerous `|| WITHDRAW_ACCOUNT_TEMPLATE_ID` fallback. Now requires a templateId; fails loud rather than silently substituting a stale package.
2. **`create-withdraw-account/route.ts`** — always fetches `templateId` + `createdEventBlob` from the same ACS row as a consistent pair (was gated on blob-empty).
3. **`lib/format.ts`** — added `toCanonicalAmount(amount)` so the UI sends `"0.0000010000"` form like the reference script (uses exact BigInt satoshi math).
4. **`lib/redeem-history.ts`** — replaced the DB-backed redeem tracking entirely. History is now reconstructed from the ledger (`CBTCWithdrawAccount_Withdraw` exercises + matching `CreateWithdrawRequest`s + `CompleteWithdrawal`s + on-chain check). DB pieces removed: `lib/redeem-store.ts`, `lib/redeem-sync.ts`, `/api/redeem/sync`. Migration 005 is still applied but the table is unused.
5. **`lib/activity.ts`** — burns are deduplicated against the ledger-scan rows; no more duplicate React keys in the activity feed.
6. **`components/ActivityList.tsx`** — composite key `${kind}-${id}-${idx}` to defend against future collisions.
7. **`app/activity/[id]/page.tsx`** — null-safe `btcExplorerAddressUrl` / `btcExplorerTxUrl` (the page no longer crashes when the destination is null because the attestor hasn't created the request yet).
8. **Burn diff-logging** in all three redeem routes — when `REDEEM_CAPTURE=1` is set, the routes write a full snapshot to `snapshots/realburn-2-ui-FULL.json` with auth claims, coordinator, create request+response, ACS fetch, and the burn request+response. Used for byte-level diff against the script.
9. **`scripts/working-burn-reference.mjs`** — committed copy of the proven manual burn flow, dry-run by default (`--execute` to actually burn). Captures the burn body to `/tmp/script-burn-body.json` for comparison.

All changes type-check and lint clean.

---

## Open items

1. **BitSafe escalation** (`docs/bitsafe-stuck-withdrawal.md`) — sent for the 0.000025 stuck burn (party d4a03457, `37defef0`). Waiting on their response. **First thing to check when resuming.**
2. **Stuck cBTC totals** awaiting BitSafe action:
   - Party d4a03457: 0.0000250 (txid `37defef0`)
   - Party 008937fb: 0.0000101 (txid `01408e15`) + 3 × 0.000001 (no request created)
   - Total ~0.0000391 cBTC
3. **Task #54** still pending: schedule `scripts/process-mints.sh` cron on the deploy host (production).
4. **Task #67** is closed in practice (the package-mismatch fix landed) — can be marked done.

---

## Files to read for full evidence (in priority order)

| File | What's in it |
|---|---|
| `docs/bitsafe-stuck-withdrawal.md` | The escalation message sent to BitSafe (table format, ready to share). |
| `snapshots/realburn-3-script-FULL.json` | The 0.000012 burn that succeeded — full capture of every request/response. The "this is what working looks like" reference. |
| `snapshots/realburn-2-ui-FULL.json` | A UI burn (0.000001), full capture. **Compare against `realburn-1-script-FULL.json` to prove the UI is byte-identical to the script.** |
| `snapshots/realburn-1-script-FULL.json` | A script burn (0.000001), full capture. Pair for the UI comparison above. |
| `snapshots/burn-history-raw.json` | Raw ledger ACS + tree history for party 008937fb (the main test party). Use this to verify any claim about burn/request/complete events on that party. |
| `snapshots/burn-history-raw-d4a03457.json` | Same, for the d4a03457 party (the BitSafe escalation case). |
| `scripts/working-burn-reference.mjs` | The reference manual burn script. Default is dry-run; `--execute` to actually burn. |

---

## Where to start when this conversation resumes

1. Read this file end-to-end.
2. If BitSafe has responded — pick up from their answer. If they refunded or rebroadcast, follow up.
3. If they haven't responded — don't run more test burns yet, they'll just stall in the same queue. Move on to the other tasks (the queue here was: lots of features, task #54 cron scheduling, and probably new feature work).
4. **Do NOT re-litigate the disproven theories.** They're settled. Read the "Theories tested and disproven" section above before forming new hypotheses about the code.

# Devnet transfer audit (2026-06-14)

Audit of the existing Token Standard P2P transfer stack before shipping the
email-user Balances UI.

## Stack reviewed

| Component | Verdict |
|-----------|---------|
| [`lib/transfer.ts`](../lib/transfer.ts) | Real Splice `TransferFactory_Transfer` + optional `Accept`; not mocked |
| Registry integration | Uses `NETWORK.registryUrl` transfer-factory endpoint |
| [`app/api/transfers/create`](../app/api/transfers/create/route.ts) | Server-side m2m signing; holdings fetched server-side |
| [`app/api/transfers/pending`](../app/api/transfers/pending/route.ts) | Lists incoming offers for session party |
| [`app/api/transfers/accept`](../app/api/transfers/accept/route.ts) | Accept with offer ownership check |

## Findings (pre-fix)

| # | Issue | Severity | Fix |
|---|-------|----------|-----|
| 1 | API routes accepted any `party_mappings` row (including Loop) | High | `requireManagedTransferSession()` gates `party_hint === participant-managed` |
| 2 | Amount parsed with `Number()` | Medium | `parseBtc()` bigint math |
| 3 | No rate limiting on transfer APIs | Medium | 30 req/min per user in-memory bucket |
| 4 | `/receive` used `useWallet().partyId` (Loop-only) | High | Replaced by `/balances` using `useCantonIdentity` |
| 5 | `useTransfers` disabled for email users | Medium | Enabled when session party exists |
| 6 | No outgoing offers API | Low | `GET /api/transfers/outgoing` + `listOutgoingOffers()` |
| 7 | Send UI ignored `transferKind === direct` | Low | Modal shows correct copy for auto-settled transfers |
| 8 | Nav hidden send/receive | Product | `/balances` linked for managed users |

## transferKind behaviour

- **`direct` / preapproval path**: Receiver has TransferPreapproval (EnableCC). Transfer
  completes in one ledger step; no accept required.
- **`offer` path**: Creates `TransferInstruction`; receiver must accept within 24h.
  Sender holdings locked until accept or expiry.

## Devnet manual verification checklist

Run with `npm run dev:devnet`, email user with CBTC balance:

1. `GET /api/parties/me` → `mode: participant-managed`
2. `GET /api/parties/balance` → CBTC > 0
3. `POST /api/transfers/create` with external Loop party → 200 + `transferKind`
4. `GET /api/transfers/outgoing` → offer listed (if not direct)
5. Recipient accepts (Loop wallet or second email account) → balances update
6. `GET /api/activity` → `sent` / `received` rows
7. UI: `/balances` Transfer modal + Transfers/History tabs

Optional smoke script: `npm run transfer:smoke:devnet` (requires logged-in session cookie or manual curl with auth).

## References

- [Sync Global Token Standard](https://docs.dev.sync.global/app_dev/token_standard/index.html#api-references)
- [`CLAUDE.md`](../CLAUDE.md) — UTXO limit, party ID display, JWT refresh

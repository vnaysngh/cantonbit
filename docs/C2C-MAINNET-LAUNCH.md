# C2C Mainnet Launch Checklist

Launch **CBTC↔CC same-chain swaps** on mainnet via the web app and public API on branch **`c2c-swaps`**.

Farm bot context (parties, vault funding): [`FARM-OPERATIONS-HANDBOOK.md`](FARM-OPERATIONS-HANDBOOK.md).  
Architecture: [`CANTON-SWAP-INTENT-PLAN.md`](CANTON-SWAP-INTENT-PLAN.md).  
General deploy matrix: [`MAINNET-DEPLOY.md`](MAINNET-DEPLOY.md).

---

## Branch and deploy topology

| Work | Git branch | Railway service |
|------|------------|-----------------|
| **Web + C2C API** | `c2c-swaps` | `oranjswap-web-mainnet` |
| **Farm bot** (keep running) | `cbtc-farming` | `cbtc-farming` |

Do **not** merge farm worker into the web deploy. Same settlement vault and treasury parties; different processes.

---

## 1. Parties (reuse farm mainnet fleet)

| Role | Party |
|------|--------|
| Settlement vault | `oranj-settle-mainnet::1220517bfd86ef5732610705a35b7b2d56e36112550d6a2b778971dbd099a3d36e99` |
| Treasury / HTLC solver Canton | `warpx-mainnet-1::1220517bfd86ef5732610705a35b7b2d56e36112550d6a2b778971dbd099a3d36e99` |

**Vault preapproval: OFF** (required for offer-path C2C).  
**Users / managed parties:** CC + CBTC preapproval ON for smooth counter legs.

Verify vault float:

```bash
npm run fund-swap-vault:mainnet -- --i-understand-mainnet --dry-run   # inspect
npm run party-balances:mainnet -- oranj-settle-mainnet::1220517bfd86ef5732610705a35b7b2d56e36112550d6a2b778971dbd099a3d36e99
```

---

## 2. Required environment (web mainnet)

Add to `.env.mainnet` / Railway **`oranjswap-web-mainnet`**:

| Variable | Purpose |
|----------|---------|
| `NEXT_PUBLIC_NETWORK` | `mainnet` |
| `NEXT_PUBLIC_LOOP_NETWORK` | `mainnet` |
| `KEYCLOAK_*` | WarpX m2m (mainnet pair) |
| `NEXT_PUBLIC_SUPABASE_*` + `SUPABASE_SERVICE_ROLE_KEY` | Order store |
| `CANTON_SWAP_SETTLEMENT_PARTY` | `oranj-settle-mainnet::1220…` |
| `NEXT_PUBLIC_SOLVER_CANTON` / `SOLVER_CANTON_PARTY` | Treasury (HTLC + ops) |
| `HTLC_DAEMON_SECRET` | Auth for daemon routes (`fill`, `pending`, `expire`) |
| `CRON_SECRET` | Optional cron auth |

Optional: `PLATFORM_FEE_BPS`, `CC_REGISTRY_URL`, `TRADECRAFT_API_URL`.

**Build:** `npm run build:mainnet` — `NEXT_PUBLIC_*` baked at build time.

---

## 3. Supabase migrations

Apply migrations **018–021** (canton swap order schema):

- User leg uniqueness, counter reissue, drop inbound holding cid, counter pending cleared

Confirm `canton_swap_orders` table exists in mainnet Supabase project.

---

## 4. API surface (public + authenticated)

Base: `https://<your-mainnet-app>/api/canton/swap`

| Route | Auth | Purpose |
|-------|------|---------|
| `POST /quote` | Public (rate limited) | Indicative CBTC↔CC quote |
| `GET /assets` | Public | MVP asset list |
| `POST /` | Party owner | Create intent order |
| `GET /[id]` | Order owner | Order status |
| `POST /[id]/settle` | Order owner | **Managed** offer + fill |
| `GET /readiness` | Party owner | Loop pre-sign checks |
| `POST /[id]/prepare-user-leg` | Order owner | Loop sell leg |
| `POST /[id]/confirm-user-leg` | Order owner | After Loop sign |
| `POST /[id]/prepare-counter-accept` | Order owner | Loop counter accept |
| `POST /[id]/confirm-counter-accept` | Order owner | After Loop accept |
| `POST /[id]/cancel` | Order owner | Cancel before lock |
| `GET /history` | Party owner | Order history |
| `GET /pending?status=` | Daemon | Poll orders |
| `POST /[id]/fill` | Daemon | Loop atomic fill |
| `POST /expire` | Daemon | Reconcile + expire stale |

Core libs: [`lib/canton-swap-settle.ts`](../lib/canton-swap-settle.ts), [`lib/canton-swap-service.ts`](../lib/canton-swap-service.ts).

---

## 5. Smoke tests

### 5a. Quote (no auth)

```bash
curl -sS -X POST "$APP_URL/api/canton/swap/quote" \
  -H 'Content-Type: application/json' \
  -d '{"fromAsset":"CBTC","toAsset":"CC","amount":"0.0001"}' | jq .
```

Expect: `outAmount`, `feeBps`, `expires`.

### 5b. Managed path (participant-managed party)

Requires authenticated session / party owner cookie or test harness:

1. `POST /quote` → get `outAmount`
2. `POST /` → create order `{ fromAsset, toAsset, inAmount, outAmount, userParty, walletMode: "managed" }`
3. `POST /[id]/settle` → atomic offer + fill
4. `GET /[id]` → status `completed` (or `counter_pending_accept` if counter needs user accept)

Use a **small** amount (e.g. `0.0001` CBTC / `50` CC) on first mainnet test.

### 5c. Loop path

1. `GET /readiness?party=…&fromAsset=…&toAsset=…`
2. Create order (`walletMode: "loop"`)
3. `prepare-user-leg` → sign in Loop → `confirm-user-leg`
4. Daemon `POST /[id]/fill` (or wait for canton-swap-daemon)
5. If counter pending: `prepare-counter-accept` → Loop sign → `confirm-counter-accept`

### 5d. Daemon

Run from `swap-solver/` or Railway sidecar:

```bash
# Devnet: npm run solver:canton-swap
# Mainnet: npm run solver:canton-swap:mainnet
# Env: HTLC_DAEMON_SECRET (from .env.mainnet / .env.devnet); defaults to http://localhost:3000
```

Polls `GET /api/canton/swap/pending` and calls `fill` + `expire`.

---

## 6. Local dev mainnet (careful — real funds)

Same pattern as devnet — only the network stack changes. If `.env.mainnet` is already filled, skip the copy step.

| Path | Terminals |
|------|-----------|
| **Email (managed)** | `npm run dev:mainnet` |
| **Loop wallet** | `npm run dev:mainnet` + `npm run solver:canton-swap:mainnet` |

```bash
npm run dev:mainnet                              # terminal 1 — UI + API
npm run solver:canton-swap:mainnet               # terminal 2 — Loop fill daemon only
```

Optional quote curl against `http://localhost:3000` (§5a).

---

## 7. Railway deploy (`oranjswap-web-mainnet`)

1. Connect Git branch **`c2c-swaps`**
2. Set all §2 env vars in Railway dashboard
3. **Build command:** `npm run build:mainnet` (or project default)
4. **Start:** `npm start` (Next.js)
5. Run Supabase migrations against mainnet project
6. Fund settlement vault if low
7. Deploy canton-swap-daemon (or cron) with `HTLC_DAEMON_SECRET` + `NEXT_PUBLIC_APP_URL` pointing at web service
8. Smoke §5a–5c against production URL

**Keep farm separate:** `cbtc-farming` service unchanged on branch `cbtc-farming`.

---

## 8. Monitoring

| Check | How |
|-------|-----|
| Orders stuck | `GET /api/canton/swap/pending?status=filling` (daemon) |
| Vault float | `npm run party-balances:mainnet -- <vault-party>` |
| Failed settles | Supabase `canton_swap_orders` status + `last_error` |
| Traffic | Lighthouse warpx validator (same as farm) |

---

## 9. Differences from farm bot

| | Farm (`cbtc-farming`) | Web C2C (`c2c-swaps`) |
|--|----------------------|------------------------|
| Users | 5 m2m traders | Any Loop / managed party |
| Orders | Fleet JSON | Supabase |
| Settle | `scripts/farm/lib/settle.ts` | `lib/canton-swap-settle.ts` (+ recovery) |
| API | None | `/api/canton/swap/*` |
| Deploy | `Dockerfile.farm` | Next.js build |

Farm validates that **offer-path 2-tx settle works on mainnet** with the same vault party.

---

## 10. Launch checklist

- [x] `CANTON_SWAP_SETTLEMENT_PARTY` set on web mainnet env (verified locally)
- [ ] Vault funded (CC + CBTC); preapproval **off** on vault
- [ ] Supabase migrations 018–021 applied
- [x] `npm run build:mainnet` succeeds on `c2c-swaps` (verified 2026-06-12 after `/orders` Suspense fix)
- [x] Quote API returns 200 (local smoke 2026-06-12)
- [ ] Managed smoke: create → settle → completed (requires authenticated session)
- [ ] Loop smoke: user leg → daemon fill → (counter accept if needed)
- [x] Daemon routes auth OK (`pending`, `expire` — local smoke 2026-06-12)
- [ ] UI swap page wired to [`lib/canton-swap-client.ts`](../lib/canton-swap-client.ts)
- [x] Farm Railway service still running independently (`cbtc-farming`)

---

## 12. Smoke results (2026-06-12, branch `c2c-swaps`, local `npm run dev:mainnet`)

| Test | Result | Notes |
|------|--------|-------|
| `POST /api/canton/swap/quote` | **PASS** | `0.0001 CBTC → 39.76… CC`, `feeBps: 100`, `quoteSource: tradecraft` |
| `GET /api/canton/swap/assets` | **PASS** | CBTC + CC listed |
| `GET /api/canton/swap/pending?status=user_locked` | **PASS** | Daemon auth OK, empty queue |
| `POST /api/canton/swap/expire` | **PASS** | Reconcile + expire ran |
| Unit tests (`npm test`) | **PASS** | 131/131 |
| Managed create → settle | **Manual** | Requires Supabase session + `requirePartyOwner`; same vault settle validated by farm bot |
| Loop user leg → fill | **Manual** | Requires Loop wallet + daemon fill |
| `npm run build:mainnet` | **PASS** | After `/orders` `Suspense` wrapper for `useSearchParams` |

---

## 13. Railway deploy (`oranjswap-web-mainnet`) — operator steps

Farm stays on **`cbtc-farming`** / service **`cbtc-farming`**. Web deploy is separate:

1. Push `c2c-swaps` (docs + script fixes from this pass).
2. Railway dashboard → **`oranjswap-web-mainnet`** → connect branch **`c2c-swaps`**.
3. Paste §2 env vars; confirm `CANTON_SWAP_SETTLEMENT_PARTY=oranj-settle-mainnet::1220…`.
4. Build: `npm run build:mainnet`; start: `npm start`.
5. Apply Supabase migrations 018–021 on mainnet project.
6. Deploy canton-swap-daemon (same as local: `npm run solver:canton-swap:mainnet` on Railway sidecar) with `HTLC_DAEMON_SECRET` + app URL.
7. Re-run §5 smoke against production URL; complete managed + Loop smokes with real wallet/session.

See [`branch-diff-c2c-swaps.md`](branch-diff-c2c-swaps.md) for cherry-picked script fixes from `cbtc-farming`.

---

## 11. Port from `cbtc-farming` (minimal)

Web swap libs are **already identical** on `c2c-swaps`. Cherry-pick only:

- Docs (this file, handbook, FARM-RAILWAY)
- Script fixes: `scripts/with-env.sh` (repo-local dotenv), `fund-swap-vault.mts` (mainnet party-balances)
- `.gitignore` farm state entries

**Do not** require farm npm scripts on `c2c-swaps` unless you want CLI on the same branch (farm deploy stays on `cbtc-farming`).

See [`docs/branch-diff-c2c-swaps.md`](branch-diff-c2c-swaps.md) for the recorded diff.

# Swap Roadmap & Task History

> Durable record of what's done and what's left for the WBTC↔cBTC cross-chain
> swap. The in-session task tracker does NOT persist across sessions — THIS FILE
> is the source of truth. Update it as work progresses.

See `SWAP.md` for the full technical reference.

---

## ✅ Done — WBTC (Base) → cBTC (Canton), built + proven live

| # | Task | Status |
|---|---|---|
| 0 | Run the OIF local demo end-to-end (understand the lifecycle) | ✅ |
| 1 | Scaffold `/contracts` (Foundry) + `/swap-solver` (TS) | ✅ |
| 2 | Custom oracle (`OranjAttestorOracle`: BaseInputOracle + gated attest) | ✅ |
| 3 | payloadHash encoder, verified byte-equal vs on-chain lib (FFI diff test) | ✅ |
| 4 | Foundry test: full on-chain release path with the custom oracle | ✅ |
| 5 | Order/Mandate construction + identifiers (config layer) | ✅ |
| 6 | Solver: watch Base for `Open` events + persist order state | ✅ |
| 7a | Solver: create cBTC offer on Canton (float → user party) | ✅ |
| 7b | Solver: watch Canton for user-accept + record fill timestamp + expiry | ✅ |
| 8 | Solver: attest on the oracle, then finalise on the escrow | ✅ |
| 9 | Secure the agent key (treasury-grade) + config hygiene | ✅ |
| 10 | End-to-end testnet run (Base Sepolia + Canton DevNet) | ✅ (swap completed twice) |
| 11 | Operational hardening: retries, monitoring, stuck-order recovery, CLI | ✅ |

**Tests:** 17 contract + 45 solver unit, all passing, plus live integration runs.
**Committed** on branch `feat/wbtc-cbtc-swap`.

---

## 📋 Remaining follow-ups (one-way swap polish)

Not blockers; do when convenient.

1. **Validate the manual two-step accept path live.** Disable the wallet's
   admin-wide auto-accept toggle, re-run `e2e-full.ts`. The code/tests exist;
   only the live manual-accept branch is unverified (auto-accept was on during
   testing). NOTE: with Loop, the user accepts in their own Loop wallet — the
   swap UI prompts "Accept the incoming cBTC in your Loop wallet".
2. ✅ **Live refund/expiry E2E.** DONE — proven on-chain (`e2e-refund.ts`) AND
   through the API endpoint (`api-refund.smoke.ts`): lock → expire → POST
   `/orders/:id/refund` → WBTC returned. The swap UI exposes a "Refund my WBTC"
   button when an order is past expiry and unfinalised (X1).
3. **Backport the `getHoldings` fix to the Oranj app.** The solver's
   `getHoldings` falls back to `createArgument` when the interface view fails to
   render (DevNet's `NOT_CONNECTED_TO_ANY_SYNCHRONIZER` state). The app's
   `lib/canton.ts` would return 0 in that state — strictly less robust.
4. **Token-split hardening (production).** Today one ParticipantAdmin-grade
   credential can act as warpx + every user party, and one EVM key can release
   the escrow. For production, split the treasury-acting capability into a
   dedicated backend-only token, separate from anything user-facing, so a single
   key compromise can't drain funds.
5. **Push `feat/wbtc-cbtc-swap` to remote** — only on explicit approval.

---

## 🔮 Future — reverse direction: cBTC (Canton) → WBTC (Base)

**NOT built. A separate project of comparable size — NOT a simple flip.**

### Why it's asymmetric
The OIF architecture we used is input-locks-on-EVM / output-on-Canton. Reversing
it means input-locks-on-CANTON / output-on-Base, with the proof consumed on
Canton. That inverts the hardest part.

### The genuinely new / hard piece
- **No Canton-side escrow exists.** `InputSettlerEscrow` is Solidity-only. The
  reverse needs a **Daml lock/escrow contract** that: locks the user's cBTC,
  releases it to the solver on proof a WBTC delivery happened on Base, and
  refunds the user via a Canton-side timeout. This Daml work is the bulk of the
  effort and has no counterpart in the current build.
- **Reversed proof flow:** the fill happens on Base (WBTC delivered); that proof
  must be verified Canton-side to release the locked cBTC. Decide the Canton-side
  attestation mechanism (trusted attestor again, or read Base state).

### Reusable from the current build
Solver pipeline shape (watch→deliver→attest→finalise), store/status machine,
retry/monitor/CLI hardening, env/security model, the Canton transfer client. The
Base-side WBTC delivery is a plain ERC20 transfer (simpler than the Permit2 lock).

### Net-new
Daml cBTC lock/escrow + release-on-proof + timeout refund; Canton-side proof
verification; reversed solver legs.

### Suggested approach when picked up
Treat like the 13-task roadmap above but front-load the Daml-lock design (riskiest
/ newest). **First**, check with BitSafe / Five North whether a suitable Daml lock
primitive already exists before building one.

---

## Reference facts (so this survives cold)

- **Branch:** `feat/wbtc-cbtc-swap`
- **Deployed (Base Sepolia):** escrow `0x08be4b858e061236826aef215b06bb703a25b0aa`,
  oracle `0x1c25296c7dfdf3cb461cc9328b66a61b0397de14`,
  MockWBTC `0xf477e033ee221ca9370afa7595ab594eb3f72066`, start block `42371722`.
- **Agent/owner/attestor:** `0x0B95ec21579aee6Ef7b712976bD86689D68b5A08`.
- **Canton float party:** `warpx-devnet-1::1220231c1885f289f90e0d08b448579c31a655b5826802c6d885258a27371039fba9`.
- **Full architecture + run instructions:** `docs/SWAP.md`.

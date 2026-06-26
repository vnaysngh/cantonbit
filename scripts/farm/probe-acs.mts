#!/usr/bin/env npx tsx
import { NETWORK } from "../../lib/constants";
import { loadFleet } from "./lib/config";
import {
  ccInstrumentId,
  listCcHoldings,
  listCbtcHoldings,
  runWithLedgerReadSession
} from "./lib/ledger";
import { getLedgerJwt } from "./lib/jwt";

async function main(): Promise<void> {
  const fleet = loadFleet();
  const jwt = await getLedgerJwt();
  const inst = await ccInstrumentId(jwt);

  async function probe(label: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      const r = await fn();
      console.log(`${label}: OK len=${Array.isArray(r) ? r.length : r}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`${label}: FAIL ${msg.slice(0, 140)}`);
    }
  }

  for (const { label, party } of [
    { label: "vault", party: fleet.vault },
    ...fleet.traders.map((t) => ({ label: t.hint, party: t.party }))
  ]) {
    console.log(`\n=== ${label} ===`);
    await runWithLedgerReadSession(jwt, async () => {
      await probe(`${label} CC full`, () => listCcHoldings(jwt, party, inst.admin));
      await probe(`${label} CC limit150`, () =>
        listCcHoldings(jwt, party, inst.admin, 150)
      );
      await probe(`${label} CBTC full`, () => listCbtcHoldings(jwt, party));
      await probe(`${label} CBTC limit150`, () => listCbtcHoldings(jwt, party, 150));
    });
    const url = `${NETWORK.validatorHost}/api/validator/v0/admin/external-party/balance?party_id=${encodeURIComponent(party)}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${jwt}` } });
    console.log(`${label} CC API: status=${r.status} body=${(await r.text()).slice(0, 80)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

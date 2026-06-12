import assert from "node:assert/strict";
import { test } from "node:test";
import { toHex } from "viem";

import {
  HtlcSwapService,
  InMemorySwapStore,
  type SwapOrder
} from "./htlc-swap-service.js";

// A fake CantonClient that records release calls (no real ledger).
function fakeCanton(): any {
  return {
    solverParty: "solver::1220",
    released: [] as any[],
    async getHoldings() {
      return [];
    },
    async createOffer(p: any) {
      (this.released as any[]).push(p);
      return {
        updateId: "u-" + p.commandId,
        offerContractId: "off",
        autoAccepted: true,
        inputHoldingCids: []
      };
    }
  };
}

const PREIMAGE_HEX =
  "7468652d63726f73732d636861696e2d7365637265742d333262797465732121";
const H =
  "0x94277b389401042e35f8709846050797955e2b321bee500555c2fbdc2f4e9903" as const;

function baseOrder(): Omit<SwapOrder, "status" | "createdAt"> {
  return {
    id: "swap-1",
    direction: "evm-to-canton",
    hashLock: H,
    userEvmAddress: "0x0000000000000000000000000000000000000001",
    solverEvmAddress: "0x0000000000000000000000000000000000000002",
    wbtcAmount: "100000",
    userTimelock: 2_000_000,
    userCantonParty: "user::1220",
    solverCantonParty: "solver::1220",
    cbtcAmount: "0.0001",
    solverTimelock: 1_996_400
  };
}

test("full happy path: open→accepted→main_locked→counter_locked→counter_claimed→main_claimed", async () => {
  const store = new InMemorySwapStore();
  const canton = fakeCanton();
  const svc = new HtlcSwapService(store, canton);

  await svc.createOrder(baseOrder());
  assert.equal((await store.get("swap-1"))!.status, "open");

  await svc.accept("swap-1");
  await svc.recordMainLock("swap-1", "0xabc");
  await svc.lockCounter("swap-1");
  assert.equal((await store.get("swap-1"))!.status, "counter_locked");

  // THE REVEAL: claim-counter with the correct preimage releases the CBTC.
  const { order, updateId } = await svc.claimCounter("swap-1", PREIMAGE_HEX);
  assert.equal(order.status, "counter_claimed");
  assert.ok(updateId.startsWith("u-"));
  assert.equal(
    canton.released.length,
    1,
    "CBTC was released exactly once, on the reveal"
  );
  // the preimage is stored for the solver's EVM claim
  const revealed = await svc.getRevealedPreimage("swap-1");
  assert.equal(revealed, "0x" + PREIMAGE_HEX);

  await svc.recordMainClaim("swap-1", "0xdef");
  assert.equal((await store.get("swap-1"))!.status, "main_claimed");
});

test("claim-counter REJECTS a wrong preimage — CBTC is NOT released (the gate)", async () => {
  const store = new InMemorySwapStore();
  const canton = fakeCanton();
  const svc = new HtlcSwapService(store, canton);
  await svc.createOrder(baseOrder());
  await svc.accept("swap-1");
  await svc.recordMainLock("swap-1", "0xabc");
  await svc.lockCounter("swap-1");

  const wrong = toHex(
    new TextEncoder().encode("wrong-secret-wrong-secret-wrong!")
  ).slice(2);
  await assert.rejects(
    () => svc.claimCounter("swap-1", wrong),
    /invalid preimage/
  );
  assert.equal(canton.released.length, 0, "NO CBTC released on a bad preimage");
  assert.equal(
    (await store.get("swap-1"))!.status,
    "counter_locked",
    "still locked"
  );
});

test("cannot skip steps: claim-counter before counter_locked fails", async () => {
  const store = new InMemorySwapStore();
  const svc = new HtlcSwapService(store, fakeCanton());
  await svc.createOrder(baseOrder());
  await assert.rejects(
    () => svc.claimCounter("swap-1", PREIMAGE_HEX),
    /counter not locked/
  );
});

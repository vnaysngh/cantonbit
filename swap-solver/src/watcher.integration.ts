/**
 * Live integration check for the Open watcher (NOT a unit test — needs a local
 * anvil on http://localhost:8545). Run manually:
 *
 *   node --import tsx src/watcher.integration.ts
 *
 * It deploys a fresh InputSettlerEscrow + MockWBTC to anvil, opens one order,
 * runs the watcher's backfill, and asserts the order was decoded + persisted
 * with matching fields. Proves the ABI decoding + store round-trip against a
 * real on-chain Open event.
 */

import {
  createWalletClient,
  createPublicClient,
  http,
  parseAbi,
  getContract,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, rmSync } from "node:fs";
import assert from "node:assert/strict";

import { ESCROW_ABI } from "./abi.js";
import { OrderStore } from "./store.js";
import { OpenWatcher } from "./watcher.js";

const RPC = "http://localhost:8545";
// anvil default account 0
const PK: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const CONTRACTS_OUT = "../contracts/out";

function artifact(path: string): { abi: unknown[]; bytecode: Hex } {
  const j = JSON.parse(readFileSync(`${CONTRACTS_OUT}/${path}`, "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object as Hex };
}

async function main() {
  const account = privateKeyToAccount(PK);
  const wallet = createWalletClient({ account, transport: http(RPC) });
  const pub = createPublicClient({ transport: http(RPC) });
  const chainId = await pub.getChainId();

  // --- deploy MockWBTC + escrow ---
  const mock = artifact("EscrowReleasePath.t.sol/MockWBTC.json");
  const escrowArt = artifact("InputSettlerEscrow.sol/InputSettlerEscrow.json");

  const wbtcHash = await wallet.deployContract({
    abi: mock.abi as never,
    bytecode: mock.bytecode,
    args: [],
    chain: null,
  });
  const wbtc = (await pub.waitForTransactionReceipt({ hash: wbtcHash })).contractAddress as Address;

  const escrowHash = await wallet.deployContract({
    abi: escrowArt.abi as never,
    bytecode: escrowArt.bytecode,
    args: [],
    chain: null,
  });
  const escrow = (await pub.waitForTransactionReceipt({ hash: escrowHash })).contractAddress as Address;

  const deployBlock = await pub.getBlockNumber();
  console.log(`deployed wbtc=${wbtc} escrow=${escrow} at block ${deployBlock}`);

  // --- mint + approve + open one order ---
  const mockAbi = parseAbi([
    "function mint(address,uint256)",
    "function approve(address,uint256) returns (bool)",
  ]);
  const mockC = getContract({ address: wbtc, abi: mockAbi, client: wallet });
  const LOCK = 5n * 10n ** 8n;
  await pub.waitForTransactionReceipt({ hash: await mockC.write.mint([account.address, LOCK], { chain: null }) });
  await pub.waitForTransactionReceipt({ hash: await mockC.write.approve([escrow, LOCK], { chain: null }) });

  const now = Math.floor(Date.now() / 1000);
  const order = {
    user: account.address,
    nonce: 1n,
    originChainId: BigInt(chainId),
    expires: now + 24 * 3600,
    fillDeadline: now + 2 * 3600,
    inputOracle: "0x000000000000000000000000000000000000dEaD" as Address,
    inputs: [[BigInt(wbtc), LOCK]] as readonly (readonly [bigint, bigint])[],
    outputs: [
      {
        oracle: ("0x" + "11".repeat(32)) as Hex,
        settler: ("0x" + "22".repeat(32)) as Hex,
        chainId: 9_000_000n,
        token: ("0x" + "33".repeat(32)) as Hex,
        amount: 5n * 10n ** 8n,
        recipient: ("0x" + "44".repeat(32)) as Hex,
        callbackData: "0x" as Hex,
        context: "0x" as Hex,
      },
    ],
  };

  const escrowC = getContract({ address: escrow, abi: ESCROW_ABI, client: wallet });
  const openHash = await escrowC.write.open([order], { chain: null });
  await pub.waitForTransactionReceipt({ hash: openHash });
  console.log(`opened order, tx ${openHash}`);

  // --- run the watcher backfill ---
  const storePath = "/tmp/oranj-watcher-test.json";
  rmSync(storePath, { force: true });
  const store = new OrderStore(storePath);
  const watcher = new OpenWatcher(
    { rpcUrl: RPC, escrow, startBlock: deployBlock },
    store,
  );
  await watcher.backfill();

  // --- assert it was captured + decoded ---
  const all = store.byStatus("seen");
  assert.equal(all.length, 1, `expected 1 seen order, got ${all.length}`);
  const rec = all[0]!;
  assert.equal(rec.order.user.toLowerCase(), account.address.toLowerCase(), "user mismatch");
  assert.equal(rec.order.inputs[0]![1], LOCK.toString(), "lock amount mismatch");
  assert.equal(rec.order.outputs[0]!.chainId, "9000000", "canton chainId mismatch");
  assert.equal(rec.order.outputs[0]!.amount, (5n * 10n ** 8n).toString(), "cbtc amount mismatch");

  // --- assert idempotency: a second backfill changes nothing ---
  store.setCursor(0); // force re-scan
  await watcher.backfill();
  assert.equal(store.byStatus("seen").length, 1, "idempotency broken: duplicate order");

  console.log("✓ watcher integration PASSED — order decoded, persisted, idempotent");
  rmSync(storePath, { force: true });
}

main().catch((e) => {
  console.error("✗ watcher integration FAILED:", e);
  process.exit(1);
});

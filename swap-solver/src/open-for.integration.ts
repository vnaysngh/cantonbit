/**
 * Live integration check for Permit2 openFor (the USER deposit leg) — needs
 * anvil on :8545 WITH canonical Permit2 deployed (the OIF demo deploys it).
 *   node --import tsx src/open-for.integration.ts
 *
 * A user signs a Permit2 witness over a StandardOrder; we submit
 * escrow.openFor(order, user, sig); assert WBTC is pulled into the escrow and
 * the watcher decodes the resulting Open event. Proves the openFor signature is
 * correct against the REAL escrow + Permit2 before any testnet spend.
 */

import {
  createWalletClient,
  createPublicClient,
  http,
  parseAbi,
  getContract,
  pad,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, rmSync } from "node:fs";
import assert from "node:assert/strict";

import { ESCROW_ABI } from "./abi.js";
import { InMemoryOrderStore } from "./store.js";
import { OpenWatcher } from "./watcher.js";
import { signOpenFor, PERMIT2_ADDRESS } from "./open-for.js";
import type { StandardOrder } from "./encoding.js";

const RPC = "http://localhost:8545";
// account 0 = deployer; account 1 = the user (locks WBTC)
const DEPLOYER: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const USER: Hex = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const OUT = "../contracts/out";

function art(p: string): { abi: unknown[]; bytecode: Hex } {
  const j = JSON.parse(readFileSync(`${OUT}/${p}`, "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object as Hex };
}

async function main() {
  const deployer = privateKeyToAccount(DEPLOYER);
  const user = privateKeyToAccount(USER);
  const wallet = createWalletClient({ account: deployer, transport: http(RPC) });
  const userWallet = createWalletClient({ account: user, transport: http(RPC) });
  const pub = createPublicClient({ transport: http(RPC) });
  const chainId = await pub.getChainId();

  // sanity: canonical Permit2 must be present
  const p2 = await pub.getCode({ address: PERMIT2_ADDRESS });
  assert.ok(p2 && p2.length > 2, "canonical Permit2 not deployed on this anvil");

  // deploy escrow + mock wbtc
  const mock = art("EscrowReleasePath.t.sol/MockWBTC.json");
  const escrowArt = art("InputSettlerEscrow.sol/InputSettlerEscrow.json");
  const deploy = async (a: { abi: unknown[]; bytecode: Hex }, args: unknown[]) => {
    const h = await wallet.deployContract({ abi: a.abi as never, bytecode: a.bytecode, args: args as never, chain: null });
    return (await pub.waitForTransactionReceipt({ hash: h })).contractAddress as Address;
  };
  const wbtc = await deploy(mock, []);
  const escrow = await deploy(escrowArt, []);
  const deployBlock = await pub.getBlockNumber();

  // user gets WBTC + approves PERMIT2 (one-time max approve to permit2 is the
  // standard pattern; permit2 then moves tokens per-signature).
  const LOCK = 1n * 10n ** 4n; // 0.0001 WBTC (8dp) — tiny
  const mockAbi = parseAbi(["function mint(address,uint256)", "function approve(address,uint256) returns (bool)"]);
  await pub.waitForTransactionReceipt({ hash: await getContract({ address: wbtc, abi: mockAbi, client: wallet }).write.mint([user.address, LOCK], { chain: null }) });
  await pub.waitForTransactionReceipt({ hash: await getContract({ address: wbtc, abi: mockAbi, client: userWallet }).write.approve([PERMIT2_ADDRESS, 2n ** 256n - 1n], { chain: null }) });

  // build the order (the user is the depositor + signer)
  const now = Math.floor(Date.now() / 1000);
  const order: StandardOrder = {
    user: user.address,
    nonce: BigInt(now), // unique nonce
    originChainId: BigInt(chainId),
    expires: now + 24 * 3600,
    fillDeadline: now + 2 * 3600,
    inputOracle: "0x000000000000000000000000000000000000dEaD",
    inputs: [[BigInt(wbtc), LOCK]],
    outputs: [
      {
        oracle: pad("0x11", { size: 32 }),
        settler: pad("0x22", { size: 32 }),
        chainId: 9_000_000n,
        token: pad("0xc87c", { size: 32 }),
        amount: LOCK,
        recipient: pad("0x44", { size: 32 }),
        callbackData: "0x",
        context: "0x",
      },
    ],
  };

  // user signs the Permit2 witness
  const sig = await signOpenFor({ account: user, order, escrow, chainId });
  console.log(`user signed openFor (sig len ${sig.length})`);

  // submit openFor (anyone can submit; here the deployer relays)
  const escrowC = getContract({ address: escrow, abi: ESCROW_ABI, client: wallet });
  const beforeEscrow = await balanceOf(pub, wbtc, escrow);
  const openHash = await escrowC.write.openFor([order, user.address, sig], { chain: null });
  await pub.waitForTransactionReceipt({ hash: openHash });
  console.log(`openFor submitted: ${openHash}`);

  // assert WBTC pulled in
  const afterEscrow = await balanceOf(pub, wbtc, escrow);
  assert.equal(afterEscrow - beforeEscrow, LOCK, "escrow should hold the user's locked WBTC");
  assert.equal(await balanceOf(pub, wbtc, user.address), 0n, "user WBTC pulled via permit2");

  // watcher decodes the Open event
  const storePath = "/tmp/oranj-openfor-test.json";
  rmSync(storePath, { force: true });
  const store = new InMemoryOrderStore();
  await new OpenWatcher({ rpcUrl: RPC, escrow, startBlock: deployBlock }, store).backfill();
  const seen = await store.byStatus("seen");
  assert.equal(seen.length, 1, "watcher should see the openFor order");
  assert.equal(seen[0]!.order.user.toLowerCase(), user.address.toLowerCase(), "user mismatch");

  console.log("✓ openFor integration PASSED — Permit2 lock + watcher decode");
  rmSync(storePath, { force: true });
}

async function balanceOf(pub: ReturnType<typeof createPublicClient>, token: Address, who: Address): Promise<bigint> {
  return (await pub.readContract({
    address: token,
    abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
    functionName: "balanceOf",
    args: [who],
  })) as bigint;
}

main().catch((e) => {
  console.error("✗ openFor integration FAILED:", e);
  process.exit(1);
});

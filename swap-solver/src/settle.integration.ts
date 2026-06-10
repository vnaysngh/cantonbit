/**
 * Live integration check for the Settler (Task 8) — needs anvil on :8545.
 *   node --import tsx src/settle.integration.ts
 *
 * Deploys escrow + OranjAttestorOracle + MockWBTC, opens an order, seeds it as
 * `delivered` (with a fillTimestamp) in the store, then runs Settler.settleOne
 * and asserts the WBTC is released to the agent. Proves the live viem
 * attest+finalise path matches the Foundry EscrowReleasePath test.
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
import { InMemoryOrderStore, type SerializedOrder } from "./store.js";
import { Settler } from "./settle.js";

const RPC = "http://localhost:8545";
const PK: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const OUT = "../contracts/out";

function art(p: string): { abi: unknown[]; bytecode: Hex } {
  const j = JSON.parse(readFileSync(`${OUT}/${p}`, "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object as Hex };
}

async function main() {
  const account = privateKeyToAccount(PK);
  const wallet = createWalletClient({ account, transport: http(RPC) });
  const pub = createPublicClient({ transport: http(RPC) });
  const chainId = await pub.getChainId();

  // deploy
  const mock = art("EscrowReleasePath.t.sol/MockWBTC.json");
  const escrowArt = art("InputSettlerEscrow.sol/InputSettlerEscrow.json");
  const oracleArt = art("OranjAttestorOracle.sol/OranjAttestorOracle.json");

  const deploy = async (a: { abi: unknown[]; bytecode: Hex }, args: unknown[]) => {
    const h = await wallet.deployContract({ abi: a.abi as never, bytecode: a.bytecode, args: args as never, chain: null });
    return (await pub.waitForTransactionReceipt({ hash: h })).contractAddress as Address;
  };

  const wbtc = await deploy(mock, []);
  const escrow = await deploy(escrowArt, []);
  // owner = agent, attestor = agent (so the agent key can attest in this test)
  const oracle = await deploy(oracleArt, [account.address, account.address]);
  console.log(`wbtc=${wbtc} escrow=${escrow} oracle=${oracle}`);

  // mint + approve
  const mockAbi = parseAbi(["function mint(address,uint256)", "function approve(address,uint256) returns (bool)"]);
  const mc = getContract({ address: wbtc, abi: mockAbi, client: wallet });
  const LOCK = 5n * 10n ** 8n;
  await pub.waitForTransactionReceipt({ hash: await mc.write.mint([account.address, LOCK], { chain: null }) });
  await pub.waitForTransactionReceipt({ hash: await mc.write.approve([escrow, LOCK], { chain: null }) });

  // build + open the order — output.oracle MUST be the oracle id; inputOracle = oracle addr.
  const now = Math.floor(Date.now() / 1000);
  const oracleId = pad(oracle, { size: 32 });
  const order = {
    user: account.address,
    nonce: 99n,
    originChainId: BigInt(chainId),
    expires: now + 24 * 3600,
    fillDeadline: now + 2 * 3600,
    inputOracle: oracle,
    inputs: [[BigInt(wbtc), LOCK]] as readonly (readonly [bigint, bigint])[],
    outputs: [
      {
        oracle: oracleId,
        settler: pad("0xca470", { size: 32 }) as Hex,
        chainId: 9_000_000n,
        token: pad("0xc87c", { size: 32 }) as Hex,
        amount: 5n * 10n ** 8n,
        recipient: pad("0x44", { size: 32 }) as Hex,
        callbackData: "0x" as Hex,
        context: "0x" as Hex,
      },
    ],
  };
  const escrowC = getContract({ address: escrow, abi: ESCROW_ABI, client: wallet });
  await pub.waitForTransactionReceipt({ hash: await escrowC.write.open([order], { chain: null }) });
  const orderId = (await escrowC.read.orderIdentifier([order])) as Hex;
  console.log(`opened, orderId=${orderId}`);
  assert.equal(await mcBalance(pub, wbtc, escrow), LOCK, "escrow should hold the lock");

  // seed the store as `delivered` with a fill timestamp
  const storePath = "/tmp/oranj-settle-test.json";
  rmSync(storePath, { force: true });
  const store = new InMemoryOrderStore();
  const serialized: SerializedOrder = {
    user: order.user,
    nonce: order.nonce.toString(),
    originChainId: order.originChainId.toString(),
    expires: order.expires,
    fillDeadline: order.fillDeadline,
    inputOracle: order.inputOracle,
    inputs: order.inputs.map((p) => [p[0].toString(), p[1].toString()] as [string, string]),
    outputs: order.outputs.map((o) => ({
      oracle: o.oracle, settler: o.settler, chainId: o.chainId.toString(),
      token: o.token, amount: o.amount.toString(), recipient: o.recipient,
      callbackData: o.callbackData, context: o.context,
    })),
  };
  store.insertSeen(orderId, 1, serialized);
  store.update(orderId, { status: "delivered", fillTimestamp: now, cantonParty: "cbtc-user-x::1220", cantonDeliveryRef: "offer1" });

  // settle
  const settler = new Settler({ rpcUrl: RPC, escrow, oracle, account });
  const before = await mcBalance(pub, wbtc, account.address);
  const outcome = await settler.settleOne(store, orderId);
  console.log("settle outcome:", outcome);
  assert.equal(outcome.kind, "finalised", `expected finalised, got ${outcome.kind}`);

  const after = await mcBalance(pub, wbtc, account.address);
  assert.equal(after - before, LOCK, "agent should receive the released WBTC");
  assert.equal(await mcBalance(pub, wbtc, escrow), 0n, "escrow drained");
  assert.equal((await store.get(orderId))!.status, "finalised", "store marked finalised");

  // idempotency: re-running settle is a no-op (already Claimed)
  const again = await settler.settleOne(store, orderId);
  assert.equal(again.kind, "skipped", "re-settle should skip (not delivered status)");

  console.log("✓ settle integration PASSED — attest + finalise released WBTC, idempotent");
  rmSync(storePath, { force: true });
}

async function mcBalance(pub: ReturnType<typeof createPublicClient>, token: Address, who: Address): Promise<bigint> {
  return (await pub.readContract({
    address: token,
    abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
    functionName: "balanceOf",
    args: [who],
  })) as bigint;
}

main().catch((e) => {
  console.error("✗ settle integration FAILED:", e);
  process.exit(1);
});

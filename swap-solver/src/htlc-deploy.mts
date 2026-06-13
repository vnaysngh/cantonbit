/**
 * Deploy HTLCEscrow to the configured EVM chain for HTLC swaps.
 *
 * Devnet/testnet: Base Sepolia (default). Mainnet: Arbitrum (requires ALLOW_MAINNET=true).
 *
 * Run:
 *   cd swap-solver
 *   npx tsx --env-file=.env --env-file=../.env.local src/htlc-deploy.mts
 *
 * Mainnet:
 *   npx tsx --env-file=.env --env-file=../.env.mainnet --env-file=.env.htlc-mainnet src/htlc-deploy.mts
 *
 * Reuses PRIVATE_KEY/SOLVER_EVM_PK + ORIGIN_RPC_URL. Reads bytecode from contracts/out
 * (run `forge build` in ../contracts first).
 */
import { readFileSync } from "node:fs";
import {
  createWalletClient,
  createPublicClient,
  http,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  resolveHtlcEvmConfig,
  verifyRpcChainId,
} from "./htlc-evm-chain.js";

function reqEnv(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
}

function deployerPk(): Hex {
  const raw =
    process.env.PRIVATE_KEY ??
    process.env.SOLVER_EVM_PK ??
    process.env.AGENT_PRIVATE_KEY;
  if (!raw) throw new Error("Set PRIVATE_KEY or SOLVER_EVM_PK");
  return (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
}

const artifact = JSON.parse(
  readFileSync(
    new URL("../../contracts/out/HTLCEscrow.sol/HTLCEscrow.json", import.meta.url),
    "utf8",
  ),
);
const abi = artifact.abi;
const bytecode = (artifact.bytecode?.object ?? artifact.bytecode) as Hex;

async function main() {
  const { network, slug, chain, rpcUrl } = resolveHtlcEvmConfig();
  const account = privateKeyToAccount(deployerPk());
  const wallet = createWalletClient({
    account,
    chain,
    transport: http(rpcUrl),
  });
  const pub = createPublicClient({ chain, transport: http(rpcUrl) });
  await verifyRpcChainId(pub, chain);

  console.log(
    `Deploying HTLCEscrow from ${account.address} on ${chain.name} (${slug}, network=${network}) …`,
  );
  const hash = await wallet.deployContract({ abi, bytecode, args: [] });
  console.log(`tx: ${hash} — waiting for receipt…`);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  console.log(`\n✅ HTLCEscrow deployed at: ${receipt.contractAddress}`);
  console.log(`\nAdd to env:\n  HTLC_ESCROW_ADDRESS=${receipt.contractAddress}`);
  console.log(`  NEXT_PUBLIC_HTLC_ESCROW=${receipt.contractAddress}`);
}

main().catch((e) => {
  console.error("deploy failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});

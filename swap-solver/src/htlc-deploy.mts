/**
 * Deploy HTLCEscrow to the EVM testnet (Base Sepolia by default) for the
 * EVM→Canton swap test. Prints the address; add it to .env as HTLC_ESCROW_ADDRESS.
 *
 * Run:
 *   npx tsx --env-file=.env src/htlc-deploy.mts
 *
 * Reuses PRIVATE_KEY + ORIGIN_RPC_URL from .env. Reads the compiled bytecode
 * from contracts/out (run `forge build` in ../contracts first).
 */
import { readFileSync } from "node:fs";
import { createWalletClient, createPublicClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const RPC = reqEnv("ORIGIN_RPC_URL");
const PK = reqEnv("PRIVATE_KEY");

function reqEnv(k: string): string { const v = process.env[k]; if (!v) throw new Error(`missing env ${k}`); return v; }

const artifact = JSON.parse(
  readFileSync(new URL("../../contracts/out/HTLCEscrow.sol/HTLCEscrow.json", import.meta.url), "utf8"),
);
const abi = artifact.abi;
const bytecode = (artifact.bytecode?.object ?? artifact.bytecode) as Hex;

async function main() {
  const account = privateKeyToAccount((PK.startsWith("0x") ? PK : `0x${PK}`) as Hex);
  const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(RPC) });
  const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) });

  console.log(`Deploying HTLCEscrow from ${account.address} on ${RPC} …`);
  const hash = await wallet.deployContract({ abi, bytecode, args: [] });
  console.log(`tx: ${hash} — waiting for receipt…`);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  console.log(`\n✅ HTLCEscrow deployed at: ${receipt.contractAddress}`);
  console.log(`\nAdd to swap-solver/.env:\n  HTLC_ESCROW_ADDRESS=${receipt.contractAddress}`);
}

main().catch((e) => { console.error("deploy failed:", e instanceof Error ? e.message : e); process.exit(1); });

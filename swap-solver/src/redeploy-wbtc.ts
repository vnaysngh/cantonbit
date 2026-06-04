/**
 * Redeploy MockWBTC (now 8-decimal) and mint a clean amount to the user wallet.
 *   node --env-file=.env --import tsx src/redeploy-wbtc.ts
 *
 * Keeps the existing escrow + oracle. Prints the new WBTC_ADDRESS to paste into
 * .env. Mints MINT_BTC to the deployer/user wallet (the .env PRIVATE_KEY).
 */

import { createWalletClient, createPublicClient, http, getContract, parseAbi, type Hex, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { readFileSync } from "node:fs";

const MINT_BTC = "0.05"; // 0.05 WBTC at 8dp → plenty for many test swaps

function env(k: string): string { const v = process.env[k]; if (!v) throw new Error(`missing env ${k}`); return v; }
function key(): Hex { const r = env("PRIVATE_KEY"); return (r.startsWith("0x") ? r : `0x${r}`) as Hex; }
function art(p: string): { abi: unknown[]; bytecode: Hex } { const j = JSON.parse(readFileSync(`../contracts/out/${p}`, "utf8")); return { abi: j.abi, bytecode: j.bytecode.object as Hex }; }

async function main() {
  const RPC = process.env.ORIGIN_RPC_URL ?? "https://sepolia.base.org";
  const account = privateKeyToAccount(key());
  const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(RPC) });
  const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) });

  console.log("deployer/user:", account.address);
  const bal = await pub.getBalance({ address: account.address });
  if (bal === 0n) throw new Error("no ETH for gas");

  console.log("deploying MockWBTC (8 decimals)…");
  const a = art("MockWBTC.sol/MockWBTC.json");
  const hash = await wallet.deployContract({ abi: a.abi as never, bytecode: a.bytecode, args: [] });
  const rcpt = await pub.waitForTransactionReceipt({ hash });
  const wbtc = rcpt.contractAddress as Address;
  console.log("MockWBTC deployed:", wbtc);

  // sanity: decimals must be 8
  const decimals = await pub.readContract({ address: wbtc, abi: parseAbi(["function decimals() view returns (uint8)"]), functionName: "decimals" });
  if (Number(decimals) !== 8) throw new Error(`expected 8 decimals, got ${decimals}`);
  console.log("decimals() =", decimals, "✓");

  // mint MINT_BTC (8dp) to the user
  const mintAmount = BigInt(Math.round(Number(MINT_BTC) * 1e8));
  const mock = getContract({ address: wbtc, abi: parseAbi(["function mint(address,uint256)", "function balanceOf(address) view returns (uint256)"]), client: wallet });
  await pub.waitForTransactionReceipt({ hash: await mock.write.mint([account.address, mintAmount]) });
  const newBal = await pub.readContract({ address: wbtc, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [account.address] });
  console.log(`minted ${MINT_BTC} WBTC → balance now ${Number(newBal) / 1e8} WBTC`);

  console.log("\n=== UPDATE .env ===");
  console.log(`WBTC_ADDRESS=${wbtc}`);
  console.log("\n(escrow + oracle unchanged)");
}

main().catch((e) => { console.error("redeploy failed:", e instanceof Error ? e.message : e); process.exit(1); });

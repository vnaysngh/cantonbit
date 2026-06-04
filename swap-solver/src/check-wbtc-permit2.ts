/**
 * Read-only compatibility check for the real Base WBTC against our swap flow.
 *
 *   node --env-file=.env --import tsx src/check-wbtc-permit2.ts
 *
 * Base WBTC is a LayerZero OFT ("WBTCOFT"), not a vanilla ERC-20. Our swap pulls
 * WBTC into the escrow via Permit2 (openFor). Most OFTs are ERC-20-compatible,
 * but some add transfer hooks / non-standard behavior. This script verifies — by
 * READING ONLY, no transactions — everything we can confirm without spending:
 *   - decimals == 8 (our whole stack assumes 8dp)
 *   - standard ERC-20 surface (name/symbol/balanceOf/allowance) responds
 *   - Permit2 is deployed at the canonical address on this chain
 *   - the agent's WBTC balance + current Permit2 allowance
 *
 * What it CANNOT prove without a transaction (flagged at the end): that
 * Permit2.permitWitnessTransferFrom actually pulls this token cleanly. That
 * requires a tiny real approve + openFor + refund cycle on mainnet — do that with
 * a dust amount before any real swap.
 */

import { createPublicClient, http, parseAbi, getAddress, type Address } from "viem";
import { base, baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

import { PERMIT2_ADDRESS } from "./open-for.js";

const BASE_MAINNET_WBTC: Address = "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c";

function key(): `0x${string}` {
  const raw = process.env.PRIVATE_KEY ?? process.env.AGENT_PRIVATE_KEY ?? "";
  return (raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`;
}

async function main() {
  const isMainnet = (process.env.SWAP_NETWORK ?? "").toLowerCase() === "mainnet";
  const chain = isMainnet ? base : baseSepolia;
  const RPC = process.env.ORIGIN_RPC_URL ?? (isMainnet ? "https://mainnet.base.org" : "https://sepolia.base.org");
  const wbtc = getAddress(process.env.WBTC_ADDRESS ?? BASE_MAINNET_WBTC);
  const pub = createPublicClient({ chain, transport: http(RPC) });

  console.log(`[check] network=${isMainnet ? "mainnet" : "testnet"} chain=${chain.name}`);
  console.log(`[check] WBTC=${wbtc}`);
  console.log(`[check] Permit2=${PERMIT2_ADDRESS}\n`);

  const erc20 = parseAbi([
    "function name() view returns (string)",
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
    "function totalSupply() view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address,address) view returns (uint256)",
  ]);

  let ok = true;
  const read = async <T>(fn: string, args: unknown[] = []): Promise<T | null> => {
    try {
      return (await pub.readContract({ address: wbtc, abi: erc20, functionName: fn as never, args: args as never })) as T;
    } catch (e) {
      console.log(`  ✗ ${fn}() failed: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
      ok = false;
      return null;
    }
  };

  console.log("=== ERC-20 surface ===");
  const name = await read<string>("name");
  const symbol = await read<string>("symbol");
  const decimals = await read<number>("decimals");
  const supply = await read<bigint>("totalSupply");
  console.log(`  name=${name} symbol=${symbol} decimals=${decimals}`);
  if (supply != null) console.log(`  totalSupply=${Number(supply) / 1e8} WBTC`);

  if (decimals !== 8) { console.log(`  ✗ decimals=${decimals}, expected 8 — our stack assumes 8dp`); ok = false; }
  else console.log("  ✓ decimals == 8");

  console.log("\n=== Permit2 deployment ===");
  const code = await pub.getCode({ address: PERMIT2_ADDRESS });
  if (code && code !== "0x") console.log(`  ✓ Permit2 is deployed at the canonical address (${code.length} bytes)`);
  else { console.log("  ✗ Permit2 NOT deployed at the canonical address on this chain"); ok = false; }

  console.log("\n=== Agent account state ===");
  try {
    const account = privateKeyToAccount(key());
    const bal = await read<bigint>("balanceOf", [account.address]);
    const allowance = await read<bigint>("allowance", [account.address, PERMIT2_ADDRESS]);
    console.log(`  agent=${account.address}`);
    if (bal != null) console.log(`  WBTC balance=${Number(bal) / 1e8}`);
    if (allowance != null) console.log(`  Permit2 allowance=${allowance >= 2n ** 200n ? "max" : (Number(allowance) / 1e8).toString()}`);
  } catch {
    console.log("  (no PRIVATE_KEY set — skipping account state)");
  }

  console.log("\n" + (ok ? "✓ STATIC CHECKS PASSED" : "✗ STATIC CHECKS FAILED"));
  console.log("\n⚠️  STILL UNVERIFIED (needs a live tx): that Permit2.permitWitnessTransferFrom");
  console.log("    actually pulls this OFT cleanly. Before any real swap, run ONE dust-amount");
  console.log("    approve → openFor → refund cycle on mainnet to confirm end-to-end.");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error("check failed:", e instanceof Error ? e.message : e); process.exit(1); });

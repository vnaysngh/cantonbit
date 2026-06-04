/**
 * Deploy + env wiring for the swap contracts (escrow + oracle).
 *
 *   node --env-file=.env --import tsx src/deploy.ts
 *
 * NETWORK-AWARE (SWAP_NETWORK):
 *   - testnet/devnet (Base Sepolia): deploys MockWBTC, mints a test float, then
 *     deploys escrow + oracle. The deployer = agent = admin (test simplification).
 *   - mainnet (Base): uses the REAL canonical Base WBTC
 *     (0x0555E30da8f98308EdB960aa94C0Db47230d2B9c, 8 decimals, LayerZero OFT) —
 *     NO MockWBTC, NO minting. Gated behind ALLOW_MAINNET=true so a real deploy
 *     can never happen by accident. Override the WBTC via WBTC_ADDRESS if needed.
 *
 * Deploys are real, broadcasting transactions — only run when you mean it.
 * On mainnet, fund the deployer with real ETH and use a dedicated agent key.
 *
 * Idempotency: always deploys fresh contracts and rewrites the address lines in
 * .env (does not touch secrets or Canton config).
 */

import {
  createWalletClient,
  createPublicClient,
  http,
  getContract,
  parseAbi,
  getAddress,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const OUT = "../contracts/out";
const ENV_PATH = ".env";

/** Canonical Base mainnet WBTC (BitGo LayerZero OFT "WBTCOFT", 8 decimals). */
const BASE_MAINNET_WBTC: Address = "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c";

type Net = "devnet" | "testnet" | "mainnet";

function net(): Net {
  const n = (process.env.SWAP_NETWORK ?? "testnet").toLowerCase();
  if (n !== "devnet" && n !== "testnet" && n !== "mainnet") {
    throw new Error(`SWAP_NETWORK must be devnet|testnet|mainnet, got '${n}'`);
  }
  return n as Net;
}

function chainFor(n: Net): { chain: Chain; defaultRpc: string } {
  return n === "mainnet"
    ? { chain: base, defaultRpc: "https://mainnet.base.org" }
    : { chain: baseSepolia, defaultRpc: "https://sepolia.base.org" };
}

function art(p: string): { abi: unknown[]; bytecode: Hex } {
  const j = JSON.parse(readFileSync(`${OUT}/${p}`, "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object as Hex };
}

function key(): Hex {
  const raw = process.env.PRIVATE_KEY ?? process.env.AGENT_PRIVATE_KEY;
  if (!raw) throw new Error("Set PRIVATE_KEY in swap-solver/.env");
  return (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
}

async function main() {
  const network = net();
  const isMainnet = network === "mainnet";

  // Hard gate: never deploy to mainnet without an explicit opt-in.
  if (isMainnet && process.env.ALLOW_MAINNET !== "true") {
    throw new Error(
      "Refusing to deploy on mainnet. Set ALLOW_MAINNET=true to deploy real contracts.",
    );
  }

  const { chain, defaultRpc } = chainFor(network);
  const RPC = process.env.ORIGIN_RPC_URL ?? defaultRpc;

  const account = privateKeyToAccount(key());
  const wallet = createWalletClient({ account, chain, transport: http(RPC) });
  const pub = createPublicClient({ chain, transport: http(RPC) });

  console.log(`[deploy] network=${network} chain=${chain.name} rpc=${RPC}`);
  console.log(`[deploy] deployer=${account.address}`);
  const bal = await pub.getBalance({ address: account.address });
  console.log(`[deploy] deployer balance: ${Number(bal) / 1e18} ETH`);
  if (bal === 0n) throw new Error("deployer has no ETH on this RPC");

  const deploy = async (a: { abi: unknown[]; bytecode: Hex }, args: unknown[]) => {
    const h = await wallet.deployContract({ abi: a.abi as never, bytecode: a.bytecode, args: args as never });
    const r = await pub.waitForTransactionReceipt({ hash: h });
    return r.contractAddress as Address;
  };

  // --- WBTC: mock on testnet, real canonical token on mainnet ---
  let wbtc: Address;
  if (isMainnet) {
    wbtc = getAddress(process.env.WBTC_ADDRESS ?? BASE_MAINNET_WBTC);
    // Sanity: the real token must report 8 decimals (our whole stack assumes 8dp).
    const decimals = await pub.readContract({
      address: wbtc, abi: parseAbi(["function decimals() view returns (uint8)"]), functionName: "decimals",
    });
    if (Number(decimals) !== 8) throw new Error(`WBTC at ${wbtc} reports ${decimals} decimals, expected 8`);
    console.log(`[deploy] using REAL Base WBTC ${wbtc} (decimals=8 ✓) — no mock, no mint`);
  } else {
    console.log("[deploy] deploying MockWBTC (8 decimals)…");
    wbtc = await deploy(art("MockWBTC.sol/MockWBTC.json"), []);
  }

  console.log("[deploy] deploying InputSettlerEscrow…");
  const escrow = await deploy(art("InputSettlerEscrow.sol/InputSettlerEscrow.json"), []);

  // Oracle owner = cold admin (defaults to deployer on testnet); attestor = hot
  // agent. On mainnet pass ORACLE_OWNER (cold) + ORACLE_ATTESTOR (hot) to split.
  const owner = getAddress(process.env.ORACLE_OWNER ?? account.address);
  const attestor = getAddress(process.env.ORACLE_ATTESTOR ?? account.address);
  console.log(`[deploy] deploying OranjAttestorOracle (owner=${owner} attestor=${attestor})…`);
  const oracle = await deploy(art("OranjAttestorOracle.sol/OranjAttestorOracle.json"), [owner, attestor]);

  const startBlock = await pub.getBlockNumber();

  // Mint a tiny test float ONLY on testnet (mainnet WBTC can't be minted).
  if (!isMainnet) {
    const mintAmount = 1_000_000n; // 0.01 WBTC at 8dp
    const mock = getContract({ address: wbtc, abi: parseAbi(["function mint(address,uint256)"]), client: wallet });
    await pub.waitForTransactionReceipt({ hash: await mock.write.mint([account.address, mintAmount]) });
    console.log(`[deploy] minted ${mintAmount} test WBTC (8dp) to ${account.address}`);
  }

  console.log("\n=== Deployed ===");
  console.log("SWAP_NETWORK       =", network);
  console.log("WBTC_ADDRESS       =", wbtc);
  console.log("ESCROW_ADDRESS     =", escrow);
  console.log("ORACLE_ADDRESS     =", oracle);
  console.log("ESCROW_START_BLOCK =", startBlock.toString());

  writeEnv({
    ORIGIN_RPC_URL: RPC,
    WBTC_ADDRESS: wbtc,
    ESCROW_ADDRESS: escrow,
    ORACLE_ADDRESS: oracle,
    ESCROW_START_BLOCK: startBlock.toString(),
  });
  console.log(`\n✓ wrote addresses into ${ENV_PATH}`);
  if (isMainnet) {
    console.log("\n⚠️  MAINNET: verify the contracts on Basescan and run the Permit2/OFT");
    console.log("    compatibility check (check-wbtc-permit2.ts) before any real swap.");
  }
}

/** Upsert each key=value into .env (rewrites the line if present, else appends). */
function writeEnv(vars: Record<string, string>): void {
  let lines = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8").split("\n") : [];
  for (const [k, v] of Object.entries(vars)) {
    const idx = lines.findIndex((l) => l.startsWith(`${k}=`));
    if (idx >= 0) lines[idx] = `${k}=${v}`;
    else lines.push(`${k}=${v}`);
  }
  writeFileSync(ENV_PATH, lines.filter((l, i) => l !== "" || i < lines.length - 1).join("\n") + "\n");
}

main().catch((e) => {
  console.error("deploy failed:", e);
  process.exit(1);
});

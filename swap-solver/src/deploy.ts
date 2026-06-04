/**
 * Testnet deploy + env wiring (Base Sepolia).
 *
 *   node --import tsx src/deploy.ts
 *
 * Uses PRIVATE_KEY (or AGENT_PRIVATE_KEY) from .env as deployer = agent = admin
 * (testnet simplification). Deploys MockWBTC + InputSettlerEscrow +
 * OranjAttestorOracle (owner = attestor = your address), then APPENDS the
 * resulting addresses + start block to .env so the solver is ready to run.
 *
 * Idempotency: it always deploys fresh contracts and rewrites the address lines
 * in .env (does not touch your secrets or Canton config).
 */

import {
  createWalletClient,
  createPublicClient,
  http,
  getContract,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const RPC = process.env.ORIGIN_RPC_URL ?? "https://sepolia.base.org";
const OUT = "../contracts/out";
const ENV_PATH = ".env";

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
  const account = privateKeyToAccount(key());
  const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(RPC) });
  const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) });

  const bal = await pub.getBalance({ address: account.address });
  console.log(`deployer ${account.address} balance: ${Number(bal) / 1e18} ETH`);
  if (bal === 0n) throw new Error("deployer has no ETH on this RPC");

  const deploy = async (a: { abi: unknown[]; bytecode: Hex }, args: unknown[]) => {
    const h = await wallet.deployContract({ abi: a.abi as never, bytecode: a.bytecode, args: args as never });
    const r = await pub.waitForTransactionReceipt({ hash: h });
    return r.contractAddress as Address;
  };

  console.log("deploying MockWBTC…");
  const wbtc = await deploy(art("EscrowReleasePath.t.sol/MockWBTC.json"), []);
  console.log("deploying InputSettlerEscrow…");
  const escrow = await deploy(art("InputSettlerEscrow.sol/InputSettlerEscrow.json"), []);
  console.log("deploying OranjAttestorOracle (owner = attestor = you)…");
  const oracle = await deploy(art("OranjAttestorOracle.sol/OranjAttestorOracle.json"), [account.address, account.address]);

  const startBlock = await pub.getBlockNumber();

  // Mint some test WBTC to the deployer (acts as the user for the test).
  const mintAmount = 1_000_000n; // 0.01 WBTC at 8dp — tiny test float
  const mock = getContract({ address: wbtc, abi: parseAbi(["function mint(address,uint256)"]), client: wallet });
  await pub.waitForTransactionReceipt({ hash: await mock.write.mint([account.address, mintAmount]) });

  console.log("\n=== Deployed ===");
  console.log("WBTC_ADDRESS       =", wbtc);
  console.log("ESCROW_ADDRESS     =", escrow);
  console.log("ORACLE_ADDRESS     =", oracle);
  console.log("ESCROW_START_BLOCK =", startBlock.toString());
  console.log("minted", mintAmount.toString(), "test WBTC (8dp) to", account.address);

  writeEnv({
    ORIGIN_RPC_URL: RPC,
    WBTC_ADDRESS: wbtc,
    ESCROW_ADDRESS: escrow,
    ORACLE_ADDRESS: oracle,
    ESCROW_START_BLOCK: startBlock.toString(),
  });
  console.log(`\n✓ wrote addresses into ${ENV_PATH}`);
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

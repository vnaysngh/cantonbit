/**
 * REAL TWO-PARTY end-to-end: EVM → Canton HTLC swap.
 *
 * Distinct parties (no self-swap):
 *   USER  = 0x5228… (USER_PRIVATE_KEY). Has WBTC, wants cBTC. Generates the secret.
 *   SOLVER= 0x0B95… (PRIVATE_KEY). Has cBTC float on Canton, wants WBTC.
 *
 * Fund movement (the point of this test):
 *   WBTC: USER wallet → HTLC contract → SOLVER wallet   (two DIFFERENT addresses)
 *   cBTC: SOLVER Canton party → USER Canton party        (real delivery on DevNet)
 *
 * Flow (Cancore EVM→Canton):
 *   1. USER generates secret s, H=keccak(s).
 *   2. USER approves + locks WBTC in HTLCEscrow under H, receiver = SOLVER EVM addr.
 *   3. SOLVER confirms the WBTC lock on EVM.
 *   4. USER reveals s to the SOLVER (so SOLVER can both deliver cBTC + claim WBTC).
 *   5. SOLVER releases cBTC to the USER's Canton party (gated on s).
 *   6. SOLVER claims the WBTC on EVM with s → WBTC lands in SOLVER wallet.
 *   7. Verify balances actually changed across the two distinct EVM wallets.
 *
 * Run:
 *   CC_SECRET=... npx tsx --env-file=.env --env-file=../.env.local src/htlc-e2e-evm-to-canton-2party.mts
 */
import {
  createPublicClient, createWalletClient, getContract, http, parseUnits, formatUnits,
  type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

import { CantonClient } from "./canton.js";
import { HTLC_ESCROW_ABI } from "./htlc-abi.js";
import { generateSecret, secretToCantonPreimage } from "./htlc-order.js";
import { htlcTimelocks } from "./htlc-timelock.js";
import { HtlcSettler } from "./htlc-settle.js";
import { releaseCbtcOnReveal } from "./htlc-canton-leg.js";

function reqEnv(k: string): string { const v = process.env[k]; if (!v) throw new Error(`missing env ${k}`); return v; }
const norm = (k: string) => (k.startsWith("0x") ? k : `0x${k}`) as Hex;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const RPC = reqEnv("ORIGIN_RPC_URL");
const WBTC = reqEnv("WBTC_ADDRESS") as Address;
const ESCROW = reqEnv("HTLC_ESCROW_ADDRESS") as Address;

const LEDGER = reqEnv("CANTON_LEDGER_HOST");
const REGISTRY = reqEnv("CANTON_REGISTRY_URL");
const ADMIN = reqEnv("CANTON_ADMIN_PARTY");
const SOLVER_PARTY = reqEnv("SOLVER_CANTON_PARTY");
const TOKEN_URL = reqEnv("KEYCLOAK_TOKEN_URL");
const SCOPE = process.env.KEYCLOAK_SCOPE ?? "daml_ledger_api";
const SECRET_M2M = reqEnv("CC_SECRET");
const USER_CANTON_PARTY =
  process.env.SWAP_RECIPIENT_PARTY ??
  "8f5ca108eb208e8826f868952ede00a5::12200fe103931833a6cb6f080dff41df997dbb9abd8d06384e6405434a04efcf8e2b";

const WBTC_AMOUNT = parseUnits(process.env.WBTC_AMOUNT ?? "0.001", 8);
const CBTC_AMOUNT = process.env.CBTC_AMOUNT ?? "0.0001";

const ERC20 = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "o", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

async function main() {
  const solver = privateKeyToAccount(norm(reqEnv("PRIVATE_KEY")));
  const user = privateKeyToAccount(norm(reqEnv("USER_PRIVATE_KEY")));
  if (solver.address.toLowerCase() === user.address.toLowerCase()) throw new Error("USER and SOLVER must be different wallets");

  const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
  const userWallet = createWalletClient({ account: user, chain: baseSepolia, transport: http(RPC) });
  const solverWallet = createWalletClient({ account: solver, chain: baseSepolia, transport: http(RPC) });

  console.log(`\n=== REAL 2-PARTY EVM→Canton swap ===`);
  console.log(`USER  (pays WBTC, gets cBTC): ${user.address}`);
  console.log(`SOLVER(gets WBTC, pays cBTC): ${solver.address}`);
  console.log(`Canton receiver (user party): ${USER_CANTON_PARTY.slice(0, 24)}…\n`);

  const wbtcUser = getContract({ address: WBTC, abi: ERC20, client: { public: pub, wallet: userWallet } });
  const escrowUser = getContract({ address: ESCROW, abi: HTLC_ESCROW_ABI, client: { public: pub, wallet: userWallet } });

  // balances BEFORE
  const solverWbtc0 = (await wbtcUser.read.balanceOf([solver.address])) as bigint;
  const userWbtc0 = (await wbtcUser.read.balanceOf([user.address])) as bigint;
  console.log(`[balances before] USER WBTC=${formatUnits(userWbtc0, 8)}  SOLVER WBTC=${formatUnits(solverWbtc0, 8)}`);
  if (userWbtc0 < WBTC_AMOUNT) throw new Error(`USER needs >= ${formatUnits(WBTC_AMOUNT, 8)} WBTC`);

  // 1. USER generates the secret
  const { secret, hashLock } = generateSecret();
  const tl = htlcTimelocks(Math.floor(Date.now() / 1000));
  console.log(`[1] USER generated secret. H=${hashLock.slice(0, 18)}…`);

  // 2. USER approves + locks WBTC, receiver = SOLVER
  console.log(`[2] USER locks ${formatUnits(WBTC_AMOUNT, 8)} WBTC, receiver=SOLVER…`);
  const apv = await wbtcUser.write.approve([ESCROW, WBTC_AMOUNT * 5n], { account: user, chain: null });
  await pub.waitForTransactionReceipt({ hash: apv });
  const lockTx = await escrowUser.write.lock([hashLock, BigInt(tl.userTimelock), WBTC_AMOUNT, WBTC, solver.address], { account: user, chain: null });
  await pub.waitForTransactionReceipt({ hash: lockTx });
  console.log(`    ✓ locked. tx=${lockTx.slice(0, 18)}…`);

  // 3. SOLVER confirms the lock (with retry for RPC lag)
  let lock: readonly [bigint, bigint, Address, Address, Address] | undefined;
  for (let i = 0; i < 8; i++) {
    lock = (await escrowUser.read.locks([hashLock])) as readonly [bigint, bigint, Address, Address, Address];
    if (lock[1] === WBTC_AMOUNT) break;
    await sleep(2500);
  }
  if (!lock || lock[1] !== WBTC_AMOUNT) throw new Error("lock not visible on EVM");
  if (lock[4].toLowerCase() !== solver.address.toLowerCase()) throw new Error("lock receiver != SOLVER");
  console.log(`[3] SOLVER confirmed lock (receiver=SOLVER ✓, amount=${formatUnits(lock[1], 8)}).`);

  // 4. USER reveals s to SOLVER (in-script)
  console.log(`[4] USER reveals preimage to SOLVER.`);

  // 5. SOLVER releases cBTC to the USER's Canton party
  const canton = new CantonClient(
    { ledgerHost: LEDGER, registryUrl: REGISTRY, decentralizedPartyId: ADMIN, instrumentId: { admin: ADMIN, id: "CBTC" }, solverParty: SOLVER_PARTY },
    { tokenUrl: TOKEN_URL, clientId: "validator-devnet-m2m", clientSecret: SECRET_M2M, scope: SCOPE },
  );
  console.log(`[5] SOLVER delivers ${CBTC_AMOUNT} cBTC to USER on Canton (gated on preimage)…`);
  const rel = await releaseCbtcOnReveal(
    canton,
    { receiverParty: USER_CANTON_PARTY, amountBtc: CBTC_AMOUNT, swapId: hashLock, solverTimelock: tl.solverTimelock },
    { preimageHex: secretToCantonPreimage(secret), hashLock },
  );
  if (rel.kind !== "released") throw new Error(`cBTC release failed: ${JSON.stringify(rel)}`);
  console.log(`    ✓ cBTC delivered. updateId=${rel.updateId.slice(0, 18)}…`);

  // 6. SOLVER claims the WBTC with s (lands in SOLVER wallet)
  console.log(`[6] SOLVER claims the WBTC on EVM with the preimage…`);
  const settler = new HtlcSettler({ rpcUrl: RPC, htlcEscrow: ESCROW, account: solver });
  const claim = await settler.claimWithPreimage(secret, hashLock);
  if (claim.kind !== "claimed") throw new Error(`SOLVER claim failed: ${JSON.stringify(claim)}`);
  console.log(`    ✓ claimed. tx=${claim.txHash.slice(0, 18)}…`);

  // 7. verify the WBTC actually moved USER → SOLVER
  await sleep(3000);
  const solverWbtc1 = (await wbtcUser.read.balanceOf([solver.address])) as bigint;
  const userWbtc1 = (await wbtcUser.read.balanceOf([user.address])) as bigint;
  console.log(`\n[balances after]  USER WBTC=${formatUnits(userWbtc1, 8)}  SOLVER WBTC=${formatUnits(solverWbtc1, 8)}`);
  const userDelta = userWbtc0 - userWbtc1;
  const solverDelta = solverWbtc1 - solverWbtc0;
  console.log(`USER  WBTC delta: -${formatUnits(userDelta, 8)}  (expect -${formatUnits(WBTC_AMOUNT, 8)})`);
  console.log(`SOLVER WBTC delta: +${formatUnits(solverDelta, 8)}  (expect +${formatUnits(WBTC_AMOUNT, 8)})`);

  if (userDelta !== WBTC_AMOUNT) throw new Error("USER WBTC did not decrease by the swap amount");
  if (solverDelta !== WBTC_AMOUNT) throw new Error("SOLVER WBTC did not increase by the swap amount");

  console.log(`\n✅✅ REAL 2-PARTY EVM→Canton swap COMPLETE:`);
  console.log(`   WBTC moved USER → SOLVER (${formatUnits(WBTC_AMOUNT, 8)}), cBTC moved SOLVER → USER (${CBTC_AMOUNT}).`);
}

main().catch((e) => { console.error("\n[2party-e2e] FAILED:", e instanceof Error ? e.message : e); process.exit(1); });

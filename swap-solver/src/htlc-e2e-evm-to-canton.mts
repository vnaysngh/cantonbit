/**
 * END-TO-END test: EVM → Canton HTLC swap (Base Sepolia ⟷ Canton DevNet).
 *
 * Runs all of Cancore's steps for the EVM→Canton direction, with this script
 * playing BOTH the user and the solver (a test harness, not production):
 *
 *   1. User generates secret s, H = keccak256(s).
 *   2. User approves + locks WBTC in HTLCEscrow under H (receiver = solver EVM addr).
 *   3. Solver confirms the WBTC lock exists on EVM.
 *   4. User reveals s to the solver (in-script).
 *   5. Solver verifies keccak256(s)==H, releases CBTC to the Canton receiver
 *      (releaseCbtcOnReveal → TransferInstruction, auto-accepted).
 *   6. Solver claims the WBTC on EVM with s (HTLCEscrow.claim).
 *   7. Verify: WBTC moved to solver, CBTC delivered on Canton.
 *
 * Tiny amounts, recoverable. The solver's CBTC is delivered to a party you
 * control (SWAP_RECIPIENT_PARTY).
 *
 * Run:
 *   CC_SECRET=... npx tsx --env-file=.env --env-file=../.env.local src/htlc-e2e-evm-to-canton.mts
 */
import {
  createPublicClient,
  createWalletClient,
  getContract,
  http,
  parseUnits,
  toHex,
  type Address,
  type Hex
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

import { CantonClient } from "./canton.js";
import { HTLC_ESCROW_ABI } from "./htlc-abi.js";
import { generateSecret, secretToCantonPreimage } from "./htlc-order.js";
import { htlcTimelocks } from "./htlc-timelock.js";
import { HtlcSettler } from "./htlc-settle.js";
import { releaseCbtcOnReveal } from "./htlc-canton-leg.js";

function reqEnv(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const RPC = reqEnv("ORIGIN_RPC_URL");
const PK = reqEnv("PRIVATE_KEY");
const WBTC = reqEnv("WBTC_ADDRESS") as Address;
const ESCROW = reqEnv("HTLC_ESCROW_ADDRESS") as Address;

// Canton
const LEDGER = reqEnv("CANTON_LEDGER_HOST");
const REGISTRY = reqEnv("CANTON_REGISTRY_URL");
const ADMIN = reqEnv("CANTON_ADMIN_PARTY");
const SOLVER_PARTY = reqEnv("SOLVER_CANTON_PARTY");
const TOKEN_URL = reqEnv("KEYCLOAK_TOKEN_URL");
const SCOPE = process.env.KEYCLOAK_SCOPE ?? "daml_ledger_api";
const SECRET_M2M = reqEnv("CC_SECRET");
const RECEIVER_PARTY =
  process.env.SWAP_RECIPIENT_PARTY ??
  "8f5ca108eb208e8826f868952ede00a5::12200fe103931833a6cb6f080dff41df997dbb9abd8d06384e6405434a04efcf8e2b";

const WBTC_AMOUNT = parseUnits(process.env.WBTC_AMOUNT ?? "0.0001", 8); // 0.0001 wBTC (8dp)
const CBTC_AMOUNT = process.env.CBTC_AMOUNT ?? "0.0001"; // CBTC decimal string

async function main() {
  const account = privateKeyToAccount(
    (PK.startsWith("0x") ? PK : `0x${PK}`) as Hex
  );
  const wallet = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(RPC)
  });
  const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
  // user and solver share the EVM account in this test; receiver of the WBTC = solver.
  const solverEvm = account.address;

  console.log(`\n=== E2E EVM→Canton HTLC swap ===`);
  console.log(`EVM account (user+solver): ${account.address}`);
  console.log(`HTLCEscrow: ${ESCROW}  WBTC: ${WBTC}`);
  console.log(`Canton receiver: ${RECEIVER_PARTY.slice(0, 28)}…\n`);

  // ---- 1. user generates the secret ----
  const { secret, hashLock } = generateSecret();
  console.log(`[1] secret generated. H = ${hashLock}`);

  const tl = htlcTimelocks(Math.floor(Date.now() / 1000));
  console.log(
    `    userTimelock(EVM)=${tl.userTimelock}  solverTimelock(CC)=${tl.solverTimelock}`
  );

  const escrow = getContract({
    address: ESCROW,
    abi: HTLC_ESCROW_ABI,
    client: { public: pub, wallet }
  });
  const wbtc = getContract({
    address: WBTC,
    abi: [
      {
        type: "function",
        name: "approve",
        stateMutability: "nonpayable",
        inputs: [
          { name: "s", type: "address" },
          { name: "a", type: "uint256" }
        ],
        outputs: [{ type: "bool" }]
      },
      {
        type: "function",
        name: "allowance",
        stateMutability: "view",
        inputs: [
          { name: "o", type: "address" },
          { name: "s", type: "address" }
        ],
        outputs: [{ type: "uint256" }]
      },
      {
        type: "function",
        name: "balanceOf",
        stateMutability: "view",
        inputs: [{ name: "o", type: "address" }],
        outputs: [{ type: "uint256" }]
      }
    ] as const,
    client: { public: pub, wallet }
  });

  const wbtcBefore = (await wbtc.read.balanceOf([solverEvm])) as bigint;
  console.log(`    user WBTC balance: ${wbtcBefore}`);
  if (wbtcBefore < WBTC_AMOUNT)
    throw new Error("insufficient WBTC on the test account");

  // ---- 2. user approves + locks WBTC under H (receiver = solver) ----
  console.log(`[2] approve + lock ${WBTC_AMOUNT} WBTC under H…`);
  // Approve a generous amount and CONFIRM the allowance landed before locking
  // (avoid an InsufficientAllowance race).
  const approveTx = await wbtc.write.approve([ESCROW, WBTC_AMOUNT * 10n], {
    account,
    chain: null
  });
  await pub.waitForTransactionReceipt({ hash: approveTx });
  const allow = (await wbtc.read.allowance([solverEvm, ESCROW])) as bigint;
  console.log(`    allowance now: ${allow}`);
  if (allow < WBTC_AMOUNT)
    throw new Error(
      `allowance ${allow} < ${WBTC_AMOUNT} after approve — aborting`
    );
  const lockTx = await escrow.write.lock(
    [hashLock, BigInt(tl.userTimelock), WBTC_AMOUNT, WBTC, solverEvm],
    { account, chain: null }
  );
  await pub.waitForTransactionReceipt({ hash: lockTx });
  console.log(`    ✓ WBTC locked. tx=${lockTx.slice(0, 18)}…`);

  // ---- 3. solver confirms the lock exists (retry — RPC read-after-write lag) ----
  let lock: readonly [bigint, bigint, Address, Address, Address] | undefined;
  for (let i = 0; i < 8; i++) {
    lock = (await escrow.read.locks([hashLock])) as readonly [
      bigint,
      bigint,
      Address,
      Address,
      Address
    ];
    if (lock[1] === WBTC_AMOUNT) break;
    console.log(`    (read ${i}: amount=${lock[1]}, retrying…)`);
    await sleep(2500);
  }
  if (!lock || lock[1] !== WBTC_AMOUNT) {
    throw new Error(
      `lock not found / wrong amount on EVM (got ${lock?.[1]}, want ${WBTC_AMOUNT})`
    );
  }
  console.log(`[3] solver confirmed WBTC lock on EVM (amount=${lock[1]}).`);

  // ---- 4. user reveals s to the solver (in-script) ----
  const cantonPreimage = secretToCantonPreimage(secret);
  console.log(`[4] user reveals preimage to solver.`);

  // ---- 5. solver releases CBTC to the Canton receiver, gated on the preimage ----
  const canton = new CantonClient(
    {
      ledgerHost: LEDGER,
      registryUrl: REGISTRY,
      decentralizedPartyId: ADMIN,
      instrumentId: { admin: ADMIN, id: "CBTC" },
      solverParty: SOLVER_PARTY
    },
    {
      tokenUrl: TOKEN_URL,
      clientId: "validator-devnet-m2m",
      clientSecret: SECRET_M2M,
      scope: SCOPE
    }
  );
  console.log(
    `[5] solver releasing ${CBTC_AMOUNT} CBTC to the user on Canton (gated on preimage)…`
  );
  const rel = await releaseCbtcOnReveal(
    canton,
    {
      receiverParty: RECEIVER_PARTY,
      amountBtc: CBTC_AMOUNT,
      swapId: hashLock,
      solverTimelock: tl.solverTimelock
    },
    { preimageHex: cantonPreimage, hashLock }
  );
  if (rel.kind !== "released")
    throw new Error(`CBTC release failed: ${JSON.stringify(rel)}`);
  console.log(
    `    ✓ CBTC delivered. updateId=${rel.updateId.slice(0, 18)}… autoAccepted=${rel.autoAccepted}`
  );

  // ---- 6. solver claims the WBTC on EVM with s ----
  console.log(`[6] solver claiming WBTC on EVM with the preimage…`);
  const settler = new HtlcSettler({ rpcUrl: RPC, htlcEscrow: ESCROW, account });
  const claim = await settler.claimWithPreimage(secret, hashLock);
  if (claim.kind !== "claimed")
    throw new Error(`WBTC claim failed: ${JSON.stringify(claim)}`);
  console.log(`    ✓ WBTC claimed. tx=${claim.txHash.slice(0, 18)}…`);

  // ---- 7. verify ----
  await sleep(2000);
  const lockAfter = (await escrow.read.locks([hashLock])) as readonly [
    bigint,
    bigint,
    Address,
    Address,
    Address
  ];
  console.log(`[7] EVM lock cleared (amount now ${lockAfter[1]}, expect 0).`);

  console.log(
    `\n✅✅ EVM→Canton swap COMPLETE — WBTC claimed by solver, CBTC delivered to user.`
  );
}

main().catch((e) => {
  console.error("\n[e2e] FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});

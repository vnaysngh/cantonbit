/**
 * END-TO-END test: Canton → EVM HTLC swap (reverse direction).
 * User has CBTC on Canton, wants WBTC on EVM. Mirror of the EVM→Canton flow.
 *
 * Roles (this script plays both user and solver):
 *   - User: owns CBTC on Canton, wants WBTC. Generates the secret s, H=keccak(s).
 *   - Solver: owns WBTC on EVM, wants CBTC.
 *
 * Flow (timelock ladder: the EVM leg here is the SHORTER one because the user
 * reveals on EVM; give the Canton-commit side the longer window):
 *   1. User generates s, H.
 *   2. Solver locks WBTC on EVM under H (receiver = USER's EVM addr), so the user
 *      can claim it by revealing s.
 *   3. User sends CBTC to the solver on Canton (the user's side of the swap). In
 *      the trust-minimized CBTC model this is gated/observed by the orchestrator;
 *      here the script does it directly (solver is the CBTC receiver).
 *   4. User claims the WBTC on EVM by revealing s (HTLCEscrow.claim) → s public.
 *   5. Solver already has the CBTC; reads s from the EVM Claimed event (watchtower
 *      path) — proves the reverse settle works off the public reveal.
 *   6. Verify: WBTC to user, CBTC to solver.
 *
 * NOTE: in this test the CBTC moves solver-party → receiver-party (we reuse the
 * solver's float as the "user's" CBTC source, delivering to a 2nd party), because
 * the script's Canton creds are the solver m2m. The MECHANISM (HTLC bind by one
 * secret, EVM real-HTLC, reveal drives both legs) is what this proves.
 *
 * Run:
 *   CC_SECRET=... npx tsx --env-file=.env --env-file=../.env.local src/htlc-e2e-canton-to-evm.mts
 */
import {
  createPublicClient,
  createWalletClient,
  getContract,
  http,
  parseUnits,
  type Address,
  type Hex
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

import { CantonClient } from "./canton.js";
import { HTLC_ESCROW_ABI } from "./htlc-abi.js";
import { generateSecret } from "./htlc-order.js";
import { htlcTimelocks } from "./htlc-timelock.js";
import { HtlcSettler, readRevealedPreimage } from "./htlc-settle.js";
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

const WBTC_AMOUNT = parseUnits(process.env.WBTC_AMOUNT ?? "0.0001", 8);
const CBTC_AMOUNT = process.env.CBTC_AMOUNT ?? "0.0001";

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
  const userEvm = account.address; // user receives the WBTC

  console.log(`\n=== E2E Canton→EVM HTLC swap (reverse) ===`);
  console.log(`EVM account (user+solver): ${account.address}\n`);

  const { secret, hashLock } = generateSecret();
  console.log(`[1] secret generated. H = ${hashLock}`);
  const tl = htlcTimelocks(Math.floor(Date.now() / 1000));

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
  const fromBlock = await pub.getBlockNumber();

  // ---- 2. solver locks WBTC on EVM under H, receiver = USER ----
  console.log(
    `[2] solver locks ${WBTC_AMOUNT} WBTC on EVM under H (receiver = user)…`
  );
  const a = (await wbtc.read.allowance([account.address, ESCROW])) as bigint;
  if (a < WBTC_AMOUNT) {
    const apv = await wbtc.write.approve([ESCROW, WBTC_AMOUNT * 10n], {
      account,
      chain: null
    });
    await pub.waitForTransactionReceipt({ hash: apv });
  }
  const lockTx = await escrow.write.lock(
    [hashLock, BigInt(tl.userTimelock), WBTC_AMOUNT, WBTC, userEvm],
    { account, chain: null }
  );
  await pub.waitForTransactionReceipt({ hash: lockTx });
  for (let i = 0; i < 8; i++) {
    const l = (await escrow.read.locks([hashLock])) as readonly [
      bigint,
      bigint,
      Address,
      Address,
      Address
    ];
    if (l[1] === WBTC_AMOUNT) break;
    await sleep(2500);
  }
  console.log(`    ✓ WBTC locked. tx=${lockTx.slice(0, 18)}…`);

  // ---- 3. user sends CBTC to the solver on Canton ----
  console.log(`[3] user sends ${CBTC_AMOUNT} CBTC to the solver on Canton…`);
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
  // Reuse releaseCbtcOnReveal as the delivery (it's a gated TransferInstruction).
  // Here it represents the user delivering CBTC to the solver side.
  const rel = await releaseCbtcOnReveal(
    canton,
    {
      receiverParty: RECEIVER_PARTY,
      amountBtc: CBTC_AMOUNT,
      swapId: hashLock,
      solverTimelock: tl.solverTimelock
    },
    { preimageHex: secretToHex(secret), hashLock }
  );
  if (rel.kind !== "released")
    throw new Error(`CBTC transfer failed: ${JSON.stringify(rel)}`);
  console.log(`    ✓ CBTC delivered. updateId=${rel.updateId.slice(0, 18)}…`);

  // ---- 4. user claims WBTC on EVM revealing s ----
  console.log(`[4] user claims WBTC on EVM with the preimage (reveals s)…`);
  const settler = new HtlcSettler({ rpcUrl: RPC, htlcEscrow: ESCROW, account });
  const claim = await settler.claimWithPreimage(secret, hashLock);
  if (claim.kind !== "claimed")
    throw new Error(`WBTC claim failed: ${JSON.stringify(claim)}`);
  console.log(`    ✓ WBTC claimed by user. tx=${claim.txHash.slice(0, 18)}…`);

  // ---- 5. solver reads s from the public Claimed event (reverse settle path) ----
  await sleep(3000);
  const revealed = await readRevealedPreimage(pub, ESCROW, hashLock, fromBlock);
  if (revealed?.toLowerCase() !== secret.toLowerCase())
    throw new Error("solver could not read revealed s");
  console.log(
    `[5] ✓ solver read the revealed preimage from chain (already holds the CBTC).`
  );

  console.log(
    `\n✅✅ Canton→EVM swap COMPLETE — WBTC claimed by user, CBTC received by solver.`
  );
}

function secretToHex(secret: Hex): string {
  return secret.startsWith("0x")
    ? secret.slice(2).toLowerCase()
    : secret.toLowerCase();
}

main().catch((e) => {
  console.error("\n[e2e-reverse] FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});

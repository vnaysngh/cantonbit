/**
 * FULL cross-chain swap E2E — WBTC (Base Sepolia) → cBTC (Canton DevNet), LIVE.
 *   node --import tsx src/e2e-full.ts
 *
 * The complete, real flow across BOTH live chains:
 *   1. Base:   user openFor → WBTC locked in the escrow (Base Sepolia)
 *   2. Watch:  solver sees the Open event
 *   3. Canton: solver delivers cBTC to the recipient (DevNet) — offer created
 *   4. Accept: (auto-accept OFF) you accept the offer in your wallet
 *   5. Capture: solver detects accept + record-time → delivered
 *   6. Settle: solver attests + finalises on Base → WBTC released to agent
 *
 * Requires: Base Sepolia env (deployed addrs + PRIVATE_KEY) AND Canton DevNet
 * creds (KEYCLOAK_* + KEYCLOAK_CLIENT_SECRET_DEVNET). The recipient is the
 * RECIPIENT party below; bound on-chain as keccak256(party).
 */

import {
  createWalletClient, createPublicClient, http, getContract, parseAbi, pad,
  type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { readFileSync, rmSync } from "node:fs";
import assert from "node:assert/strict";

import { ESCROW_ABI } from "./abi.js";
import { InMemoryOrderStore } from "./store.js";
import { OpenWatcher } from "./watcher.js";
import { signOpenFor, PERMIT2_ADDRESS } from "./open-for.js";
import { Settler } from "./settle.js";
import { CantonClient } from "./canton.js";
import { cantonPartyToRecipient } from "./order.js";
import { recordTimeToUnixSeconds } from "./accept-watch.js";
import type { StandardOrder } from "./encoding.js";

// --- Canton DevNet ---
const DEVNET = {
  ledgerHost: "https://ledger-api.validator.devnet.warpx.fivenorth.io",
  registryUrl: "https://api.utilities.digitalasset-dev.com",
  decentralizedPartyId: "cbtc-network::12202a83c6f4082217c175e29bc53da5f2703ba2675778ab99217a5a881a949203ff",
  instrumentId: { admin: "cbtc-network::12202a83c6f4082217c175e29bc53da5f2703ba2675778ab99217a5a881a949203ff", id: "CBTC" },
};
const FLOAT_PARTY = "warpx-devnet-1::1220231c1885f289f90e0d08b448579c31a655b5826802c6d885258a27371039fba9";
const RECIPIENT = "8f5ca108eb208e8826f868952ede00a5::12200fe103931833a6cb6f080dff41df997dbb9abd8d06384e6405434a04efcf8e2b";
const CBTC_BTC = "0.0001";           // cBTC delivered on Canton
const WBTC_LOCK = 1n * 10n ** 4n;    // 0.0001 WBTC locked on Base (8dp)

function env(k: string): string { const v = process.env[k]; if (!v) throw new Error(`missing env ${k}`); return v; }
function key(): Hex { const r = env("PRIVATE_KEY"); return (r.startsWith("0x") ? r : `0x${r}`) as Hex; }
function art(p: string): { abi: unknown[]; bytecode: Hex } { const j = JSON.parse(readFileSync(`../contracts/out/${p}`, "utf8")); return { abi: j.abi, bytecode: j.bytecode.object as Hex }; }

const log = (s: string) => console.log(`\n=== ${s} ===`);

async function main() {
  const RPC = process.env.ORIGIN_RPC_URL ?? "https://sepolia.base.org";
  const escrow = env("ESCROW_ADDRESS") as Address;
  const oracle = env("ORACLE_ADDRESS") as Address;
  const wbtc = env("WBTC_ADDRESS") as Address;
  const startBlock = BigInt(env("ESCROW_START_BLOCK"));

  const account = privateKeyToAccount(key());
  const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(RPC) });
  const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
  const chainId = await pub.getChainId();

  const canton = new CantonClient(
    { ...DEVNET, solverParty: FLOAT_PARTY },
    { tokenUrl: env("KEYCLOAK_TOKEN_URL"), clientId: env("KEYCLOAK_CLIENT_ID"),
      clientSecret: process.env.KEYCLOAK_CLIENT_SECRET_DEVNET ?? env("KEYCLOAK_CLIENT_SECRET"),
      scope: process.env.KEYCLOAK_SCOPE ?? "daml_ledger_api" },
  );

  const balOf = async (who: Address) => (await pub.readContract({ address: wbtc, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [who] })) as bigint;
  const waitBal = async (who: Address, want: bigint, label: string) => { for (let i = 0; i < 25; i++) { if ((await balOf(who)) === want) return; await sleep(1500); } throw new Error(`${label}: ${who} balance never reached ${want}`); };

  const summary: Record<string, string> = {};

  // float check
  log("0. PRECHECK: solver cBTC float (DevNet)");
  const float = await canton.getFloatSats();
  console.log(`float: ${Number(float) / 1e8} cBTC`);
  assert.ok(float >= 10n ** 4n, "insufficient float for 0.0001 cBTC");
  summary["cBTC float"] = `${Number(float) / 1e8} cBTC`;

  // === 1. Base: user openFor locks WBTC ===
  log("1. BASE: user locks WBTC via Permit2 openFor");
  // ensure permit2 approval
  const allowance = (await pub.readContract({ address: wbtc, abi: parseAbi(["function allowance(address,address) view returns (uint256)"]), functionName: "allowance", args: [account.address, PERMIT2_ADDRESS] })) as bigint;
  if (allowance < 10n ** 18n) await pub.waitForTransactionReceipt({ hash: await getContract({ address: wbtc, abi: parseAbi(["function approve(address,uint256) returns (bool)"]), client: wallet }).write.approve([PERMIT2_ADDRESS, 2n ** 256n - 1n]) });
  // ensure the user has WBTC to lock
  if ((await balOf(account.address)) < WBTC_LOCK) await pub.waitForTransactionReceipt({ hash: await getContract({ address: wbtc, abi: parseAbi(["function mint(address,uint256)"]), client: wallet }).write.mint([account.address, WBTC_LOCK]) });

  const now = Math.floor(Date.now() / 1000);
  const order: StandardOrder = {
    user: account.address, nonce: BigInt(now), originChainId: BigInt(chainId),
    expires: now + 6 * 3600, fillDeadline: now + 3 * 3600, inputOracle: oracle,
    inputs: [[BigInt(wbtc), WBTC_LOCK]],
    outputs: [{
      oracle: pad(oracle, { size: 32 }), settler: pad("0xca470", { size: 32 }),
      chainId: 1_000_000_000_000_001n, token: pad("0xc87c", { size: 32 }),
      amount: WBTC_LOCK, recipient: cantonPartyToRecipient(RECIPIENT),
      callbackData: "0x", context: "0x",
    }],
  };
  const sig = await signOpenFor({ account, order, escrow, chainId });
  const escrowC = getContract({ address: escrow, abi: ESCROW_ABI, client: wallet });
  const escrowBefore = await balOf(escrow);
  const openTx = await escrowC.write.openFor([order, account.address, sig]);
  await pub.waitForTransactionReceipt({ hash: openTx });
  await waitBal(escrow, escrowBefore + WBTC_LOCK, "lock");
  const orderId = (await escrowC.read.orderIdentifier([order])) as Hex;
  console.log(`WBTC locked ✓  openFor tx: ${openTx}`);
  console.log(`orderId: ${orderId}`);
  summary["1. openFor (Base)"] = openTx;
  summary["orderId"] = orderId;

  // === 2. Watch ===
  log("2. WATCH: solver observes the Open event");
  const storePath = "/tmp/oranj-e2e-full.json"; rmSync(storePath, { force: true });
  const store = new InMemoryOrderStore();
  await new OpenWatcher({ rpcUrl: RPC, escrow, startBlock }, store, () => {}).backfill();
  assert.ok(store.has(orderId), "watcher missed the order");
  // attach the canton party preimage (off-chain side channel)
  store.update(orderId, { cantonParty: RECIPIENT });
  console.log(`watcher recorded order as 'seen' ✓`);

  // === 3. Canton: deliver cBTC (offer) ===
  log("3. CANTON: solver delivers cBTC (creates transfer offer)");
  const holdings = await canton.getHoldings(FLOAT_PARTY);
  const { updateId, offerContractId, autoAccepted } = await canton.createOffer({ receiverParty: RECIPIENT, amountBtc: CBTC_BTC, inputHoldings: holdings });
  console.log(`offer created ✓  updateId: ${updateId}`);
  console.log(autoAccepted ? `(auto-accepted by wallet)` : `offerId: ${offerContractId}`);
  store.update(orderId, { status: "delivering", cantonDeliveryRef: offerContractId || updateId });
  summary["3. cBTC delivery (Canton)"] = `updateId ${updateId}`;

  // === 4+5. Accept + capture record-time ===
  log("4. ACCEPT: waiting for you to accept in the wallet (auto-accept OFF)");
  let fillTimestamp: number;
  if (autoAccepted) {
    fillTimestamp = now; // collapsed one-step; use submit time
    console.log("auto-accepted → using submit time as fill timestamp");
  } else {
    console.log(`>>> ACCEPT the incoming 0.0001 CBTC transfer in your wallet now <<<\n`);
    let resolved = false; fillTimestamp = now;
    for (let i = 0; i < 120; i++) {
      const active = await canton.isOfferActive(RECIPIENT, offerContractId).catch(() => true);
      if (!active) {
        const r = await canton.resolveOffer({ receiverParty: RECIPIENT, offerContractId, fromOffset: 0 });
        if (r.kind === "accepted") { fillTimestamp = recordTimeToUnixSeconds(r.recordTime); console.log(`\naccepted at ${r.recordTime} ✓`); summary["5. accept record-time"] = r.recordTime; resolved = true; break; }
        if (r.kind === "expired") throw new Error("offer expired unaccepted");
      }
      process.stdout.write(`  waiting… (${i * 5}s)\r`); await sleep(5000);
    }
    if (!resolved) throw new Error("timed out waiting for accept");
  }
  store.update(orderId, { status: "delivered", fillTimestamp });
  console.log(`order marked delivered (fillTimestamp ${fillTimestamp}) ✓`);

  // === 6. Settle: attest + finalise → WBTC released ===
  log("6. SETTLE: solver attests + finalises on Base → WBTC released");
  const settler = new Settler({ rpcUrl: RPC, escrow, oracle, account });
  const userBefore = await balOf(account.address);
  const outcome = await settler.settleOne(store, orderId);
  assert.equal(outcome.kind, "finalised", `settle failed: ${JSON.stringify(outcome)}`);
  await waitBal(account.address, userBefore + WBTC_LOCK, "release");
  console.log(`WBTC released ✓`);
  if (outcome.kind === "finalised") { summary["6. attest (Base)"] = outcome.attestTxHash ?? "-"; summary["6. finalise (Base)"] = outcome.finaliseTxHash ?? "-"; }

  // === RESULT ===
  console.log(`\n\n========== ✓ FULL CROSS-CHAIN SWAP PASSED ==========`);
  console.log(`  ${WBTC_LOCK} WBTC (Base Sepolia) → ${CBTC_BTC} cBTC (Canton DevNet)`);
  for (const [k, v] of Object.entries(summary)) console.log(`  ${k.padEnd(28)} ${v}`);
  console.log(`====================================================`);
  rmSync(storePath, { force: true });
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
main().catch((e) => { console.error("\n✗ FULL E2E FAILED:", e instanceof Error ? e.message : e); process.exit(1); });

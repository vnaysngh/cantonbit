/**
 * MAINNET full-cycle swap — WBTC (Arbitrum) → cBTC (Canton mainnet), LIVE, REAL FUNDS.
 *
 *   node --env-file=.env --env-file=../.env.local --env-file=.env.mainnet \
 *     --import tsx src/e2e-mainnet.ts
 *
 * Moves REAL value: 0.00001 WBTC on Arbitrum ↔ 0.00001 cBTC on Canton mainnet.
 * Fully env-driven (chain, RPC, escrow/oracle/wbtc, Canton, recipient). The full
 * flow inline: lock WBTC (openFor) → deliver cBTC → accept (or auto) → attest →
 * finalise → confirm WBTC released to the PAYOUT (treasury) address.
 *
 * Required env: ESCROW/ORACLE/WBTC/START_BLOCK + ORIGIN_RPC_URL (Arbitrum) +
 * CANTON_* + KEYCLOAK_* + SOLVER_CANTON_PARTY + SWAP_RECIPIENT_PARTY +
 * PAYOUT_ADDRESS. EVM_CHAIN must be arbitrum. ALLOW_MAINNET=true.
 */

import {
  createWalletClient, createPublicClient, http, getContract, parseAbi, pad,
  getAddress, type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import assert from "node:assert/strict";

import { ESCROW_ABI } from "./abi.js";
import { SupabaseOrderStore } from "./store.js";
import { OpenWatcher } from "./watcher.js";
import { signOpenFor, PERMIT2_ADDRESS } from "./open-for.js";
import { Settler } from "./settle.js";
import { CantonClient } from "./canton.js";
import { cantonPartyToRecipient } from "./order.js";
import { recordTimeToUnixSeconds } from "./accept-watch.js";
import type { StandardOrder } from "./encoding.js";

function env(k: string): string { const v = process.env[k]; if (!v) throw new Error(`missing env ${k}`); return v; }
function key(): Hex { const r = env("PRIVATE_KEY"); return (r.startsWith("0x") ? r : `0x${r}`) as Hex; }
const log = (s: string) => console.log(`\n=== ${s} ===`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Tiny test amount: 0.00001 (1000 sats at 8dp).
const WBTC_LOCK = 1000n;
const CBTC_BTC = "0.00001";

async function main() {
  // Hard safety gates.
  assert.equal(process.env.SWAP_NETWORK, "mainnet", "SWAP_NETWORK must be mainnet");
  assert.equal(process.env.ALLOW_MAINNET, "true", "ALLOW_MAINNET must be true");
  assert.equal((process.env.EVM_CHAIN ?? "").toLowerCase(), "arbitrum", "EVM_CHAIN must be arbitrum");

  const RPC = env("ORIGIN_RPC_URL");
  const escrow = getAddress(env("ESCROW_ADDRESS"));
  const oracle = getAddress(env("ORACLE_ADDRESS"));
  const wbtc = getAddress(env("WBTC_ADDRESS"));
  const startBlock = BigInt(env("ESCROW_START_BLOCK"));
  const payout = getAddress(env("PAYOUT_ADDRESS"));
  const recipient = env("SWAP_RECIPIENT_PARTY");
  const floatParty = env("SOLVER_CANTON_PARTY");

  const account = privateKeyToAccount(key());
  const wallet = createWalletClient({ account, chain: arbitrum, transport: http(RPC) });
  const pub = createPublicClient({ chain: arbitrum, transport: http(RPC) });
  const chainId = await pub.getChainId();
  assert.equal(chainId, 42161, "not connected to Arbitrum One");

  const canton = new CantonClient(
    {
      ledgerHost: env("CANTON_LEDGER_HOST"),
      registryUrl: env("CANTON_REGISTRY_URL"),
      decentralizedPartyId: env("CANTON_ADMIN_PARTY"),
      instrumentId: { admin: env("CANTON_ADMIN_PARTY"), id: process.env.CANTON_INSTRUMENT_ID ?? "CBTC" },
      solverParty: floatParty,
    },
    { tokenUrl: env("KEYCLOAK_TOKEN_URL"), clientId: env("KEYCLOAK_CLIENT_ID"),
      clientSecret: env("KEYCLOAK_CLIENT_SECRET"), scope: process.env.KEYCLOAK_SCOPE ?? "daml_ledger_api" },
  );

  const balOf = async (a: Address) => (await pub.readContract({ address: wbtc, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [a] })) as bigint;
  const waitBal = async (a: Address, want: bigint, label: string) => { for (let i = 0; i < 40; i++) { if ((await balOf(a)) === want) return; await sleep(1500); } throw new Error(`${label}: ${a} never reached ${want}`); };

  const summary: Record<string, string> = {};
  console.log(`MAINNET swap: ${Number(WBTC_LOCK) / 1e8} WBTC (Arbitrum) → ${CBTC_BTC} cBTC (Canton mainnet)`);
  console.log(`recipient: ${recipient.slice(0, 40)}…`);
  console.log(`payout (treasury): ${payout}`);

  // === 0. PRECHECK: float ===
  log("0. PRECHECK: solver cBTC float (mainnet)");
  const float = await canton.getFloatSats();
  console.log(`float: ${Number(float) / 1e8} cBTC`);
  assert.ok(float >= 1000n, "insufficient float for 0.00001 cBTC");
  summary["cBTC float"] = `${Number(float) / 1e8} cBTC`;

  // === 1. Arbitrum: lock WBTC via openFor ===
  log("1. ARBITRUM: lock WBTC via Permit2 openFor");
  const allowance = (await pub.readContract({ address: wbtc, abi: parseAbi(["function allowance(address,address) view returns (uint256)"]), functionName: "allowance", args: [account.address, PERMIT2_ADDRESS] })) as bigint;
  if (allowance < WBTC_LOCK) {
    console.log("approving Permit2…");
    await pub.waitForTransactionReceipt({ hash: await getContract({ address: wbtc, abi: parseAbi(["function approve(address,uint256) returns (bool)"]), client: wallet }).write.approve([PERMIT2_ADDRESS, 2n ** 256n - 1n]) });
  }
  const userBal = await balOf(account.address);
  assert.ok(userBal >= WBTC_LOCK, `need ${WBTC_LOCK} WBTC, have ${userBal}`);

  const now = Math.floor(Date.now() / 1000);
  const order: StandardOrder = {
    user: account.address, nonce: BigInt(now), originChainId: BigInt(chainId),
    expires: now + 6 * 3600, fillDeadline: now + 3 * 3600, inputOracle: oracle,
    inputs: [[BigInt(wbtc), WBTC_LOCK]],
    outputs: [{
      oracle: pad(oracle, { size: 32 }), settler: pad("0xca470", { size: 32 }),
      chainId: 1_000_000_000_000_003n, // mainnet Canton synthetic chainId (offset 3)
      token: pad("0xc87c", { size: 32 }),
      amount: WBTC_LOCK, recipient: cantonPartyToRecipient(recipient),
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
  console.log(`WBTC locked ✓  openFor: ${openTx}`);
  summary["1. openFor (Arbitrum)"] = openTx;
  summary["orderId"] = orderId;

  // === 2. Watch ===
  log("2. WATCH: solver observes the Open event");
  // Route this REAL mainnet swap through the PRODUCTION Supabase store, so the
  // whole flow (seen → delivering → delivered → finalised) is proven end-to-end
  // against the new Postgres backend — the actual migration verification.
  const store = SupabaseOrderStore.fromEnv();
  await new OpenWatcher({ rpcUrl: RPC, escrow, startBlock }, store, () => {}).backfill();
  assert.ok(await store.has(orderId), "watcher missed the order");
  await store.update(orderId, { cantonParty: recipient });
  console.log("watcher recorded 'seen' ✓");

  // === 3. Canton: deliver cBTC ===
  log("3. CANTON: deliver cBTC (transfer offer)");
  const holdings = await canton.getHoldings(floatParty);
  const { updateId, offerContractId, autoAccepted, inputHoldingCids } = await canton.createOffer({ receiverParty: recipient, amountBtc: CBTC_BTC, inputHoldings: holdings });
  console.log(`offer created ✓  updateId: ${updateId}`);
  console.log(autoAccepted ? "(auto-accepted)" : `offerId: ${offerContractId} — ACCEPT IT NOW in the receiving wallet`);
  await store.update(orderId, { status: "delivering", cantonDeliveryRef: offerContractId || updateId });
  summary["3. cBTC delivery (Canton)"] = `updateId ${updateId}`;

  // === 4. Accept + capture record-time ===
  log("4. ACCEPT");
  let fillTimestamp: number;
  if (autoAccepted) {
    fillTimestamp = now;
    console.log("auto-accepted → using submit time");
  } else {
    console.log(`>>> ACCEPT the incoming ${CBTC_BTC} CBTC transfer in the receiving wallet <<<`);
    // Detect the accept via the SOLVER's own ACS (sender-readable): once the user
    // accepts, the pending TransferInstruction / locked Holding for these inputs
    // disappears. We CANNOT read the receiver's offer (403), so the old
    // isOfferActive(offerContractId) check was useless (offerContractId is empty).
    let resolved = false; fillTimestamp = now;
    for (let i = 0; i < 120; i++) {
      const accepted = await canton.isDeliveryAccepted(inputHoldingCids).catch(() => false);
      if (accepted) {
        fillTimestamp = Math.floor(Date.now() / 1000);
        console.log(`\naccepted (detected via solver ACS) ✓`);
        summary["4. accept"] = "detected via solver float";
        resolved = true; break;
      }
      process.stdout.write(`  waiting for accept… (${i * 5}s)\r`); await sleep(5000);
    }
    if (!resolved) throw new Error("timed out waiting for accept");
  }
  await store.update(orderId, { status: "delivered", fillTimestamp });
  console.log(`delivered (fillTimestamp ${fillTimestamp}) ✓`);

  // === 5. Settle: attest + finalise → WBTC to PAYOUT ===
  log("5. SETTLE: attest + finalise → WBTC to treasury");
  const settler = new Settler({ rpcUrl: RPC, escrow, oracle, account, payoutAddress: payout });
  const payoutBefore = await balOf(payout);
  const outcome = await settler.settleOne(store, orderId);
  assert.equal(outcome.kind, "finalised", `settle failed: ${JSON.stringify(outcome)}`);
  await waitBal(payout, payoutBefore + WBTC_LOCK, "release-to-payout");
  console.log(`WBTC released to treasury ${payout} ✓`);
  if (outcome.kind === "finalised") { summary["5. attest"] = outcome.attestTxHash ?? "-"; summary["5. finalise"] = outcome.finaliseTxHash ?? "-"; }

  console.log(`\n\n========== ✓ MAINNET SWAP PASSED ==========`);
  console.log(`  ${Number(WBTC_LOCK) / 1e8} WBTC (Arbitrum) → ${CBTC_BTC} cBTC (Canton mainnet)`);
  for (const [k, v] of Object.entries(summary)) console.log(`  ${k.padEnd(28)} ${v}`);
  console.log(`===========================================`);
}

main().catch((e) => { console.error("\n✗ MAINNET E2E FAILED:", e instanceof Error ? e.message : e); process.exit(1); });

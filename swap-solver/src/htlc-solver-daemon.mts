/**
 * INDEPENDENT HTLC SOLVER DAEMON (B-REAL2).
 *
 * This is the real solver — a standalone process, NOT the browser. It:
 *   1. Polls the order API for orders.
 *   2. When an order is `main_locked`, verifies the WBTC lock on-chain, then locks
 *      the CBTC counter (transitions it to counter_locked) so the user can claim.
 *   3. When an order is `counter_claimed` (the USER revealed the preimage by
 *      claiming the CBTC), the solver READS the revealed preimage and submits
 *      claim(preImage) on the HTLCEscrow — actually taking the WBTC on EVM.
 *   4. Records main_claimed.
 *
 * The user and the solver each do their own steps. The secret is revealed by the
 * USER's claim; the solver only ever READS the public preimage to take the WBTC it
 * is owed. It cannot steal — it can only claim the leg the user already unlocked.
 *
 * Run:
 *   SOLVER_EVM_PK=0x... API_BASE=http://localhost:3000 \
 *     npx tsx src/htlc-solver-daemon.mts
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  getContract,
  type Address,
  type Hex
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { HTLC_ESCROW_ABI } from "./htlc-abi.js";
import {
  resolveHtlcEvmConfig,
  resolveWbtcAddress,
  verifyRpcChainId,
} from "./htlc-evm-chain.js";

const API_BASE = process.env.API_BASE ?? "http://localhost:3000";
const ESCROW = (process.env.HTLC_ESCROW_ADDRESS ??
  "0x1b19a764ab35db1833ae2137544dd84ba5bf8cf1") as Address;
const POLL_MS = Number(process.env.SOLVER_POLL_MS ?? 4000);
const API_AUTH_TOKEN =
  process.env.HTLC_DAEMON_SECRET ??
  process.env.API_AUTH_TOKEN ??
  "";

function reqEnv(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
}
/** Solver EVM hot key — same fallbacks as swap-solver/src/env.ts. */
function solverEvmPk(): string {
  return (
    process.env.SOLVER_EVM_PK ??
    process.env.AGENT_PRIVATE_KEY ??
    process.env.PRIVATE_KEY ??
    reqEnv("SOLVER_EVM_PK")
  );
}
const norm = (k: string) => (k.startsWith("0x") ? k : `0x${k}`) as Hex;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fire-and-forget operational alert to ALERT_WEBHOOK_URL (Slack/Discord). Never
 *  throws. Mirrors lib/alert.ts but inline (the daemon has its own dep tree). */
const ALERT_WEBHOOK = process.env.ALERT_WEBHOOK_URL;
async function alert(
  title: string,
  fields: Record<string, string | number> = {}
): Promise<void> {
  const text =
    `🔴 *${title}*\n` +
    Object.entries(fields)
      .map(([k, v]) => `• ${k}: \`${v}\``)
      .join("\n");
  console.error(`[alert] ${title}`, fields);
  if (!ALERT_WEBHOOK) return;
  try {
    await fetch(ALERT_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(5000)
    });
  } catch {
    /* monitoring must not break the loop */
  }
}

interface Order {
  id: string;
  status: string;
  hashLock: Hex;
  wbtcAmount: string;
  userEvmAddress: string;
  solverEvmAddress: string;
  revealedPreimage?: Hex;
  mainClaimTx?: string;
  direction?: string;
  solverTimelock?: number;
  counterLockTx?: string;
}

const ERC20_ABI = [
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
] as const;

const ESCROW_START_BLOCK = BigInt(process.env.ESCROW_START_BLOCK ?? "42371722");

/** Recover the tx hash of the Locked event for a hashLock (chunked; RPC 2000-block
 *  cap). Used when counterLockTx wasn't persisted, so the reverse watchtower never
 *  goes blind (M3 — would otherwise risk losing both legs). */
async function findLockTx(
  pub: ReturnType<typeof createPublicClient>,
  hashLock: Hex
): Promise<Hex | undefined> {
  const tip = await pub.getBlockNumber();
  for (let from = ESCROW_START_BLOCK; from <= tip; from += 1990n) {
    const to = from + 1989n > tip ? tip : from + 1989n;
    const logs = await pub.getContractEvents({
      address: ESCROW,
      abi: HTLC_ESCROW_ABI,
      eventName: "Locked",
      args: { hashValue: hashLock },
      fromBlock: from,
      toBlock: to
    });
    if (logs.length)
      return (logs[logs.length - 1] as { transactionHash?: Hex })
        .transactionHash;
  }
  return undefined;
}

async function jget(path: string) {
  const r = await fetch(`${API_BASE}${path}`, {
    headers: API_AUTH_TOKEN
      ? { Authorization: `Bearer ${API_AUTH_TOKEN}` }
      : undefined
  });
  if (!r.ok) throw new Error(`GET ${path} ${r.status}`);
  return r.json();
}
async function jpost(path: string, body?: unknown) {
  const r = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(API_AUTH_TOKEN ? { Authorization: `Bearer ${API_AUTH_TOKEN}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `POST ${path} ${r.status}`);
  return j;
}

async function main() {
  const { network, slug, chain, rpcUrl } = resolveHtlcEvmConfig();
  const account = privateKeyToAccount(norm(solverEvmPk()));
  const pub = createPublicClient({ chain, transport: http(rpcUrl) });
  await verifyRpcChainId(pub, chain);
  const wallet = createWalletClient({
    account,
    chain,
    transport: http(rpcUrl)
  });
  const escrow = getContract({
    address: ESCROW,
    abi: HTLC_ESCROW_ABI,
    client: { public: pub, wallet }
  });

  console.log(
    `[solver] up. network=${network} evm=${slug} chainId=${chain.id} account=${account.address} escrow=${ESCROW} api=${API_BASE} rpc=${rpcUrl}`
  );
  console.log(`[solver] polling every ${POLL_MS}ms…`);

  // Track which orders we've acted on (avoid double-submits).
  const lockedCounter = new Set<string>();
  const claimedMain = new Set<string>();
  let lastSweep = 0;

  for (;;) {
    try {
      // AUTO-REFUND sweep (Cancore parity) — periodically refund counter-locked
      // swaps past their Canton timelock, freeing the solver's CBTC. Every ~60s.
      const nowMs = Date.now();
      if (nowMs - lastSweep > 60_000) {
        lastSweep = nowMs;
        try {
          const r = (await jpost("/api/htlc/auto-refund")) as {
            due?: number;
            refunded?: number;
          };
          if (r.due && r.due > 0)
            console.log(
              `[solver] auto-refund swept ${r.refunded}/${r.due} expired swaps`
            );
        } catch (e) {
          console.error(
            "[solver] auto-refund error:",
            e instanceof Error ? e.message : e
          );
        }
      }
      // The API has no list endpoint yet; the daemon learns order ids from a
      // shared ids feed. We poll the known-active set via /api/htlc/active.
      const { orders } = (await jget("/api/htlc/active")) as {
        orders: Order[];
      };

      for (const o of orders ?? []) {
        try {
        // ================= REVERSE (canton-to-evm) =================
        // Main leg = user's CBTC (locked by our backend, LONG timelock); counter
        // leg = OUR WBTC (SHORT timelock). See docs/canton-to-evm-design.md.
        if (o.direction === "canton-to-evm") {
          // R-STEP 3 — CBTC locked on-ledger (our own backend's write) → lock WBTC
          // on EVM: same hashLock, receiver = the USER's EVM address, SHORT timelock.
          if (o.status === "main_locked" && !lockedCounter.has(o.id)) {
            const amount = BigInt(o.wbtcAmount);
            const unlock = BigInt(o.solverTimelock ?? 0);
            if (unlock <= BigInt(Math.floor(Date.now() / 1000) + 300)) {
              console.log(
                `[solver] ${o.id.slice(0, 12)} rev: timelock too close — skip`
              );
              continue;
            }
            const existing = (await escrow.read.locks([
              o.hashLock
            ])) as readonly [bigint, bigint, Address, Address, Address];
            if (existing[1] === 0n) {
              const wbtc = resolveWbtcAddress(slug);
              // SOLVENCY (M1): don't lock if the solver's WBTC balance is short — the
              // user's CBTC is already custodied/locked, so it auto-refunds cleanly.
              const balance = (await pub.readContract({
                address: wbtc,
                abi: ERC20_ABI,
                functionName: "balanceOf",
                args: [account.address]
              })) as bigint;
              if (balance < amount) {
                void alert(
                  "Solver WBTC balance too low — cannot fill reverse swap",
                  {
                    order: o.id.slice(0, 18),
                    have: String(balance),
                    need: String(amount)
                  }
                );
                continue;
              }
              const allowance = (await pub.readContract({
                address: wbtc,
                abi: ERC20_ABI,
                functionName: "allowance",
                args: [account.address, ESCROW]
              })) as bigint;
              if (allowance < amount) {
                const atx = await wallet.writeContract({
                  address: wbtc,
                  abi: ERC20_ABI,
                  functionName: "approve",
                  args: [ESCROW, amount * 100n],
                  account,
                  chain: null
                });
                await pub.waitForTransactionReceipt({ hash: atx });
              }
              console.log(
                `[solver] ${o.id.slice(0, 12)} rev: locking ${amount} WBTC for user ${o.userEvmAddress.slice(0, 10)}…`
              );
              const tx = await escrow.write.lock(
                [o.hashLock, unlock, amount, wbtc, o.userEvmAddress as Address],
                { account, chain: null }
              );
              await pub.waitForTransactionReceipt({ hash: tx });
              await jpost(`/api/htlc/${o.id}/counter-lock`, {
                counterLockTx: tx
              });
            } else {
              // Lock already on-chain (e.g. daemon crashed after lock, before the POST).
              // Recover the REAL lock tx hash from the Locked event — NEVER record the
              // string "already-locked", which has no 0x prefix and would blind the
              // watchtower's claim-event scan → solver could lose both legs (M3).
              const realTx = await findLockTx(pub, o.hashLock);
              await jpost(`/api/htlc/${o.id}/counter-lock`, {
                counterLockTx: realTx ?? "0x"
              }).catch(() => {});
            }
            lockedCounter.add(o.id);
            continue;
          }

          // R-STEP 4/5 WATCHTOWER — counter_locked: watch the EVM lock. If the user
          // claimed (lock gone), pull the preimage from the Claimed event and claim
          // the CBTC. NEVER rely only on the browser reporting the claim — a silent
          // WBTC claim + later CBTC auto-refund would rob the solver of both legs.
          if (
            (o.status === "counter_locked" || o.status === "counter_claimed") &&
            !claimedMain.has(o.id)
          ) {
            let preimage: Hex | undefined = o.revealedPreimage;
            if (!preimage) {
              const lock = (await escrow.read.locks([o.hashLock])) as readonly [
                bigint,
                bigint,
                Address,
                Address,
                Address
              ];
              if (lock[1] !== 0n) {
                // Still locked. If OUR retake window opened (user never claimed), retake.
                if (
                  o.solverTimelock &&
                  Date.now() / 1000 > o.solverTimelock + 30
                ) {
                  console.log(
                    `[solver] ${o.id.slice(0, 12)} rev: user never claimed — retaking WBTC`
                  );
                  const tx = await escrow.write.retake([o.hashLock], {
                    account,
                    chain: null
                  });
                  await pub.waitForTransactionReceipt({ hash: tx });
                  claimedMain.add(o.id);
                }
                continue;
              }
              // Lock is gone → the user claimed. Find the Claimed event → preimage.
              // Public RPC caps eth_getLogs at 2000 blocks → scan in chunks from the
              // counter-lock tx's block (the claim can only be after the lock).
              // Scan from the counter-lock tx's block if we have it; else from the
              // Locked event for this hashLock (recovered), so a missing/short
              // counterLockTx can never make the reveal invisible (M3).
              let fromBlock: bigint | undefined;
              if (
                o.counterLockTx &&
                o.counterLockTx.startsWith("0x") &&
                o.counterLockTx.length === 66
              ) {
                try {
                  fromBlock = (
                    await pub.getTransactionReceipt({
                      hash: o.counterLockTx as Hex
                    })
                  ).blockNumber;
                } catch {
                  /* recover below */
                }
              }
              if (fromBlock === undefined) {
                const lockTx = await findLockTx(pub, o.hashLock);
                if (lockTx) {
                  try {
                    fromBlock = (
                      await pub.getTransactionReceipt({ hash: lockTx })
                    ).blockNumber;
                  } catch {
                    /* below */
                  }
                }
              }
              if (fromBlock === undefined)
                fromBlock = (await pub.getBlockNumber()) - 49_999n;
              if (fromBlock < 0n) fromBlock = 0n;
              const tip = await pub.getBlockNumber();
              let found: { args?: { preImage?: Hex } } | undefined;
              for (let from = fromBlock; from <= tip && !found; from += 1990n) {
                const to = from + 1989n > tip ? tip : from + 1989n;
                const logs = await pub.getContractEvents({
                  address: ESCROW,
                  abi: HTLC_ESCROW_ABI,
                  eventName: "Claimed",
                  args: { hashValue: o.hashLock },
                  fromBlock: from,
                  toBlock: to
                });
                if (logs.length)
                  found = logs[logs.length - 1] as {
                    args?: { preImage?: Hex };
                  };
              }
              preimage = found?.args?.preImage;
              if (!preimage) {
                console.log(
                  `[solver] ${o.id.slice(0, 12)} rev: lock gone but no Claimed event found yet`
                );
                continue;
              }
            }
            console.log(
              `[solver] ${o.id.slice(0, 12)} rev: preimage public → claiming CBTC on Canton…`
            );
            await jpost(`/api/htlc/${o.id}/claim-main`, {
              preimage: (preimage as string).replace(/^0x/, "")
            });
            claimedMain.add(o.id);
            continue;
          }
          continue; // reverse orders never fall through to the forward branches
        }

        // STEP 4 — order is main_locked: verify the WBTC lock on-chain, lock counter.
        if (o.status === "main_locked" && !lockedCounter.has(o.id)) {
          const lock = (await escrow.read.locks([o.hashLock])) as readonly [
            bigint,
            bigint,
            Address,
            Address,
            Address
          ];
          const amount = BigInt(o.wbtcAmount);
          if (lock[1] !== amount) {
            console.log(
              `[solver] ${o.id.slice(0, 12)} lock not on-chain yet (have ${lock[1]})`
            );
            continue;
          }
          if (lock[4].toLowerCase() !== o.solverEvmAddress.toLowerCase()) {
            console.log(
              `[solver] ${o.id.slice(0, 12)} lock receiver != solver — skip`
            );
            continue;
          }
          // ROBBERY GUARD: the WBTC lock must have enough time left for the solver to
          // claim AFTER the user reveals. Without this, a user can lock WBTC with a
          // near-immediate unlockTime, take the CBTC, then retake the WBTC before we
          // can claim it. (Mirrors verifyEvmLock's EVM_CLAIM_MARGIN.) settleBefore
          // ladder is also enforced server-side at createOrder, but verify on-chain.
          const nowSec = Math.floor(Date.now() / 1000);
          const CLAIM_MARGIN = 10 * 60;
          if (Number(lock[0]) - nowSec < CLAIM_MARGIN) {
            console.log(
              `[solver] ${o.id.slice(0, 12)} WBTC lock expires too soon (${Number(lock[0]) - nowSec}s) — REFUSING to lock CBTC`
            );
            continue;
          }
          console.log(
            `[solver] ${o.id.slice(0, 12)} WBTC lock verified on-chain → locking CBTC counter`
          );
          await jpost(`/api/htlc/${o.id}/lock-counter`);
          lockedCounter.add(o.id);
        }

        // STEP 7 — order is counter_claimed: the USER revealed the preimage. Read it
        // and ACTUALLY claim the WBTC on EVM.
        if (o.status === "counter_claimed" && !claimedMain.has(o.id)) {
          const { preimage } = (await jget(`/api/htlc/${o.id}/preimage`)) as {
            preimage: Hex;
          };
          if (!preimage) {
            console.log(`[solver] ${o.id.slice(0, 12)} no preimage yet`);
            continue;
          }
          // sanity: don't double-claim if already gone
          const lock = (await escrow.read.locks([o.hashLock])) as readonly [
            bigint,
            bigint,
            Address,
            Address,
            Address
          ];
          if (lock[1] === 0n) {
            console.log(
              `[solver] ${o.id.slice(0, 12)} lock already claimed/empty`
            );
            claimedMain.add(o.id);
            await jpost(`/api/htlc/${o.id}/main-claim`, {
              mainClaimTx: "already-claimed"
            }).catch(() => {});
            continue;
          }
          console.log(
            `[solver] ${o.id.slice(0, 12)} preimage revealed → claiming WBTC on EVM…`
          );
          try {
            const tx = await escrow.write.claim([preimage], {
              account,
              chain: null
            });
            await pub.waitForTransactionReceipt({ hash: tx });
            console.log(
              `[solver] ${o.id.slice(0, 12)} ✓ WBTC claimed tx=${tx.slice(0, 14)}`
            );
            await jpost(`/api/htlc/${o.id}/main-claim`, { mainClaimTx: tx });
            claimedMain.add(o.id);
          } catch (e) {
            // CRITICAL: the user revealed the secret but we failed to claim the WBTC
            // we're owed. It retries next loop, but the operator must know NOW (the
            // EVM timelock is ticking — if it lapses the user could retake).
            void alert(
              "Solver FAILED to claim WBTC after reveal — manual check needed",
              {
                order: o.id.slice(0, 18),
                error: e instanceof Error ? e.message.slice(0, 100) : String(e)
              }
            );
          }
        }
        } catch (e) {
          console.error(
            `[solver] ${o.id.slice(0, 12)} error:`,
            e instanceof Error ? e.message : e
          );
        }
      }
    } catch (e) {
      console.error(`[solver] loop error:`, e instanceof Error ? e.message : e);
    }
    await sleep(POLL_MS);
  }
}

main().catch((e) => {
  console.error("[solver] fatal:", e);
  process.exit(1);
});

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
import { startHealthServer } from "./health-server.mjs";

const API_BASE = process.env.API_BASE ?? "http://localhost:3000";
const ESCROW = (process.env.HTLC_ESCROW_ADDRESS ??
  "0x1b19a764ab35db1833ae2137544dd84ba5bf8cf1") as Address;
const POLL_MS = Number(process.env.SOLVER_POLL_MS ?? 4000);
const API_AUTH_TOKEN = (
  process.env.HTLC_DAEMON_SECRET ??
  process.env.CRON_SECRET ??
  process.env.API_AUTH_TOKEN ??
  ""
).trim();

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
  counterMode?: string;
  solverTimelock?: number;
  counterLockTx?: string;
  createdAt?: number;
  updatedAt?: number;
}

/** Forward fills and EVM claims first — reverse watchtower log scans are slow. */
function daemonPriority(o: Order): number {
  if (o.direction === "evm-to-canton") {
    if (o.status === "main_locked") return 0;
    if (o.status === "counter_claimed") return 1;
    return 8;
  }
  if (o.direction === "canton-to-evm") {
    if (o.status === "main_locked" || o.status === "counter_locking") return 2;
    if (o.status === "counter_locked" || o.status === "counter_claimed")
      return 6;
  }
  return 9;
}

function sortDaemonOrders(orders: Order[]): Order[] {
  return [...orders].sort(
    (a, b) => daemonPriority(a) - daemonPriority(b) || a.id.localeCompare(b.id)
  );
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

// M-04: deploy block of the escrow on the active chain — historical safety scans
// start here. On mainnet this must be configured explicitly. On devnet/testnet we
// discover it once at startup when unset/0, avoiding a from-genesis scan on every
// reverse fill.
let escrowStartBlock = BigInt(process.env.ESCROW_START_BLOCK ?? "0");
const lockTxCache = new Map<string, Hex>();
// M-04: per-(hashLock, event) checkpoint of the highest block already scanned with
// NO match. A repeated scan for a still-unfound event resumes from here instead of
// re-walking the whole deploy→tip range every call. In-memory only: on restart we
// re-scan from escrowStartBlock once (safe — never misses, just slower once).
const scanCheckpoint = new Map<string, bigint>();
const EVENT_SCAN_SAFETY_SECONDS = Number(
  process.env.HTLC_EVENT_SCAN_SAFETY_SECONDS ?? 600
);

/** Scan the escrow history (chunked at the RPC 2000-block cap) for the latest event
 *  of `eventName` matching `hashLock`; return its tx hash. M-04: scans from the
 *  escrow deploy (never a fixed recent window — a 48–72h order can outlive one), but
 *  CHECKPOINTS the scanned range so repeat calls only walk new blocks. Throws on RPC
 *  error (callers fail-closed). */
async function findEventTx(
  pub: ReturnType<typeof createPublicClient>,
  hashLock: Hex,
  eventName: "Locked" | "Claimed"
): Promise<Hex | undefined> {
  const tip = await pub.getBlockNumber();
  const key = `${eventName}:${hashLock}`;
  const resumeFrom = scanCheckpoint.get(key);
  let from =
    resumeFrom != null && resumeFrom + 1n > escrowStartBlock
      ? resumeFrom + 1n
      : escrowStartBlock;
  for (; from <= tip; from += 1990n) {
    const to = from + 1989n > tip ? tip : from + 1989n;
    const logs = await pub.getContractEvents({
      address: ESCROW,
      abi: HTLC_ESCROW_ABI,
      eventName,
      args: { hashValue: hashLock },
      fromBlock: from,
      toBlock: to
    });
    if (logs.length) {
      // Found — clear any checkpoint (caller caches the tx hash separately).
      scanCheckpoint.delete(key);
      return (logs[logs.length - 1] as { transactionHash?: Hex })
        .transactionHash;
    }
    // Advance the checkpoint only after a clean (no-error) chunk with no match, so a
    // mid-scan RPC throw doesn't skip an unscanned range on the next attempt.
    scanCheckpoint.set(key, to);
  }
  return undefined;
}

async function findEventTxFromBlock(
  pub: ReturnType<typeof createPublicClient>,
  hashLock: Hex,
  eventName: "Locked" | "Claimed",
  startBlock: bigint
): Promise<Hex | undefined> {
  const tip = await pub.getBlockNumber();
  let from = startBlock > escrowStartBlock ? startBlock : escrowStartBlock;
  for (; from <= tip; from += 1990n) {
    const to = from + 1989n > tip ? tip : from + 1989n;
    const logs = await pub.getContractEvents({
      address: ESCROW,
      abi: HTLC_ESCROW_ABI,
      eventName,
      args: { hashValue: hashLock },
      fromBlock: from,
      toBlock: to
    });
    if (logs.length) {
      return (logs[logs.length - 1] as { transactionHash?: Hex })
        .transactionHash;
    }
  }
  return undefined;
}

async function blockAtOrBeforeUnixTime(
  pub: ReturnType<typeof createPublicClient>,
  unixSeconds: number
): Promise<bigint> {
  const tip = await pub.getBlockNumber();
  const tipBlock = await pub.getBlock({ blockNumber: tip });
  if (Number(tipBlock.timestamp) <= unixSeconds) return tip;

  let lo = escrowStartBlock;
  let hi = tip;
  while (lo < hi) {
    const mid = (lo + hi + 1n) >> 1n;
    const block = await pub.getBlock({ blockNumber: mid });
    if (Number(block.timestamp) <= unixSeconds) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}

async function orderEventScanStartBlock(
  pub: ReturnType<typeof createPublicClient>,
  o: Order
): Promise<bigint | undefined> {
  const reference = o.updatedAt ?? o.createdAt;
  if (!reference || !Number.isFinite(reference)) return undefined;
  const safeUnixSeconds = Math.max(
    0,
    Math.floor(reference - EVENT_SCAN_SAFETY_SECONDS)
  );
  return blockAtOrBeforeUnixTime(pub, safeUnixSeconds);
}

async function findOrderScopedEventTx(
  pub: ReturnType<typeof createPublicClient>,
  o: Order,
  eventName: "Locked" | "Claimed"
): Promise<Hex | undefined> {
  const startBlock = await orderEventScanStartBlock(pub, o);
  if (startBlock == null) return findEventTx(pub, o.hashLock, eventName);
  return findEventTxFromBlock(pub, o.hashLock, eventName, startBlock);
}

/** Recover the tx hash of the Locked event for a hashLock. Used when counterLockTx
 *  wasn't persisted, so the reverse watchtower never goes blind (M3). Cached. */
async function findLockTx(
  pub: ReturnType<typeof createPublicClient>,
  hashLock: Hex
): Promise<Hex | undefined> {
  const cached = lockTxCache.get(hashLock);
  if (cached) return cached;
  const tx = await findEventTx(pub, hashLock, "Locked");
  if (tx) lockTxCache.set(hashLock, tx);
  return tx;
}

/** Recover the tx hash of the Claimed event for a hashLock (full-history scan).
 *  C-02: used to prove a hash was already claimed before any re-lock; the caller
 *  treats a thrown error as fail-closed (skip re-lock). */
async function findClaimTx(
  pub: ReturnType<typeof createPublicClient>,
  hashLock: Hex
): Promise<Hex | undefined> {
  return findEventTx(pub, hashLock, "Claimed");
}

/** Locate the first block where the escrow bytecode exists. Devnet/testnet only:
 * this keeps recovery scans bounded without baking one chain-specific block into
 * source. Mainnet still requires explicit ESCROW_START_BLOCK. */
async function discoverEscrowStartBlock(
  pub: ReturnType<typeof createPublicClient>
): Promise<bigint> {
  const tip = await pub.getBlockNumber();
  let lo = 0n;
  let hi = tip;
  while (lo < hi) {
    const mid = (lo + hi) >> 1n;
    const code = await pub.getBytecode({ address: ESCROW, blockNumber: mid });
    if (code && code !== "0x") hi = mid;
    else lo = mid + 1n;
  }
  const code = await pub.getBytecode({ address: ESCROW, blockNumber: lo });
  if (!code || code === "0x") {
    throw new Error(
      `HTLC escrow ${ESCROW} has no bytecode at chain tip ${tip}; check HTLC_ESCROW_ADDRESS/EVM_CHAIN/RPC.`
    );
  }
  return lo;
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
  if (!API_AUTH_TOKEN) {
    throw new Error(
      "HTLC_DAEMON_SECRET, CRON_SECRET, or API_AUTH_TOKEN required"
    );
  }
  if (!process.env.HTLC_ESCROW_ADDRESS?.trim()) {
    throw new Error(
      "HTLC_ESCROW_ADDRESS required — do not rely on baked-in default"
    );
  }
  // M-01: never run mainnet against the localhost default API_BASE.
  const isMainnet =
    process.env.SWAP_NETWORK === "mainnet" ||
    process.env.ALLOW_MAINNET === "true";
  if (isMainnet && !process.env.API_BASE?.trim()) {
    throw new Error(
      "API_BASE required on mainnet — refusing the localhost default"
    );
  }
  const { network, slug, chain, rpcUrl } = resolveHtlcEvmConfig();
  const account = privateKeyToAccount(norm(solverEvmPk()));
  const pub = createPublicClient({ chain, transport: http(rpcUrl) });
  await verifyRpcChainId(pub, chain);

  if (!isMainnet && escrowStartBlock <= 0n) {
    escrowStartBlock = await discoverEscrowStartBlock(pub);
    console.log(
      `[solver] discovered escrowStartBlock=${escrowStartBlock} for escrow=${ESCROW}`
    );
  }

  // M-04: fail fast on a bogus ESCROW_START_BLOCK. If it is at/after the chain tip,
  // every findEventTx/findLockTx/findClaimTx loop scans ZERO blocks and silently
  // recovers nothing — which also defeats the C-02 re-lock guard. A misconfigured
  // value (e.g. an extra digit) must crash at startup, not fail open at runtime.
  {
    const tipNow = await pub.getBlockNumber();
    if (escrowStartBlock >= tipNow) {
      throw new Error(
        `ESCROW_START_BLOCK (${escrowStartBlock}) is >= chain tip (${tipNow}) — historical event scans would cover zero blocks. Set it to the escrow deployment block.`
      );
    }
    // P2b: on mainnet an unset/0 ESCROW_START_BLOCK makes recovery scans walk from
    // genesis in 1990-block chunks — thousands of RPC calls that time out reconcile/
    // refund. Require the real deploy block on mainnet.
    if (isMainnet && escrowStartBlock <= 0n) {
      throw new Error(
        "ESCROW_START_BLOCK required on mainnet (the escrow deploy block) — a from-genesis scan would time out recovery."
      );
    }
  }
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

  // M-01: health/readiness server + heartbeat.
  const heartbeat = startHealthServer({
    name: "htlc-solver-daemon",
    port: Number(process.env.HEALTH_PORT ?? "8080"),
    readyStaleMs: Math.max(POLL_MS * 3, 30_000),
    nowMs: () => Date.now()
  });

  // Track which orders we've acted on (avoid double-submits).
  const lockedCounter = new Set<string>();
  const claimedMain = new Set<string>();
  const watchtowerLastScan = new Map<string, number>();
  const WATCHTOWER_MIN_MS = Number(process.env.HTLC_WATCHTOWER_MIN_MS ?? 30_000);
  let lastSweep = 0;

  for (;;) {
    try {
      // AUTO-REFUND sweep — fire-and-forget so a slow expire sweep never blocks fills.
      const nowMs = Date.now();
      if (nowMs - lastSweep > 60_000) {
        lastSweep = nowMs;
        void jpost("/api/htlc/auto-refund")
          .then((r) => {
            const body = r as { due?: number; refunded?: number };
            if (body.due && body.due > 0)
              console.log(
                `[solver] auto-refund swept ${body.refunded}/${body.due} expired swaps`
              );
          })
          .catch((e) => {
            console.error(
              "[solver] auto-refund error:",
              e instanceof Error ? e.message : e
            );
          });
      }
      // The API has no list endpoint yet; the daemon learns order ids from a
      // shared ids feed. We poll the known-active set via /api/htlc/active.
      const { orders: rawOrders } = (await jget("/api/htlc/active")) as {
        orders: Order[];
      };
      const orders = sortDaemonOrders(rawOrders ?? []);
      for (const o of orders) {
        try {
        if (o.direction !== "evm-to-canton" && o.direction !== "canton-to-evm") {
          continue;
        }
        if (
          !o.solverEvmAddress ||
          o.solverEvmAddress.toLowerCase() !== account.address.toLowerCase()
        ) {
          throw new Error(
            `order solver EVM ${o.solverEvmAddress || "missing"} does not match daemon hot key ${account.address}`
          );
        }
        // ================= REVERSE (canton-to-evm) =================
        // Main leg = user's CBTC (locked by our backend, LONG timelock); counter
        // leg = OUR WBTC (SHORT timelock). See docs/canton-to-evm-design.md.
        if (o.direction === "canton-to-evm") {
          // R-STEP 3 — CBTC locked on-ledger (our own backend's write) → lock WBTC
          // on EVM: same hashLock, receiver = the USER's EVM address, SHORT timelock.
          if (
            (o.status === "main_locked" || o.status === "counter_locking") &&
            !lockedCounter.has(o.id)
          ) {
            const beganThisAttempt = o.status === "main_locked";
            const amount = BigInt(o.wbtcAmount);
            const wbtc = resolveWbtcAddress(slug);
            const unlock = BigInt(o.solverTimelock ?? 0);
            const existing = (await escrow.read.locks([
              o.hashLock
            ])) as readonly [bigint, bigint, Address, Address, Address];
            if (existing[1] === 0n) {
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
                if (o.status === "counter_locking") {
                  await jpost(`/api/htlc/${o.id}/abort-counter-lock`);
                }
                continue;
              }
              if (o.status === "main_locked") {
                const begun = (await jpost(
                  `/api/htlc/${o.id}/begin-counter-lock`,
                  { evmFloatUnits: balance.toString() }
                )) as { order?: Order };
                if (!begun.order || begun.order.status !== "counter_locking") {
                  continue;
                }
                Object.assign(o, begun.order);
              }
              if (unlock <= BigInt(Math.floor(Date.now() / 1000) + 300)) {
                console.log(
                  `[solver] ${o.id.slice(0, 12)} rev: timelock too close — skip`
                );
                await jpost(`/api/htlc/${o.id}/abort-counter-lock`);
                continue;
              }
              // C-02: lock reads empty. Before re-locking, prove the hash was NOT
              // already claimed. A scan ERROR must FAIL CLOSED — never re-lock on an
              // unconfirmed scan, or a real claim + RPC blip makes us double-fund.
              let claimedAlready = false;
              if (!beganThisAttempt) {
                try {
                  const claimTx = await findOrderScopedEventTx(pub, o, "Claimed");
                  claimedAlready = !!claimTx;
                } catch (e) {
                  console.error(
                    `[solver] ${o.id.slice(0, 12)} rev: Claimed scan failed — SKIP re-lock (fail-closed): ${e instanceof Error ? e.message : e}`
                  );
                  continue;
                }
              }
              if (claimedAlready) {
                console.log(
                  `[solver] ${o.id.slice(0, 12)} rev: EVM already claimed — skip re-lock`
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
              const receipt = await pub.waitForTransactionReceipt({ hash: tx });
              if (receipt.status !== "success") {
                console.log(
                  `[solver] ${o.id.slice(0, 12)} rev: lock tx reverted on-chain — skip record`
                );
                await jpost(`/api/htlc/${o.id}/abort-counter-lock`);
                continue;
              }
              await jpost(`/api/htlc/${o.id}/counter-lock`, {
                counterLockTx: tx
              });
            } else {
              // Lock already on-chain (e.g. daemon crashed after lock, before the POST).
              const lockAmount = existing[1];
              const lockReceiver = existing[4];
              if (
                lockAmount < amount ||
                lockReceiver.toLowerCase() !== o.userEvmAddress.toLowerCase()
              ) {
                console.log(
                  `[solver] ${o.id.slice(0, 12)} rev: on-chain lock mismatch — skip record`
                );
                continue;
              }
              const realTx =
                (await findOrderScopedEventTx(pub, o, "Locked")) ??
                (await findLockTx(pub, o.hashLock));
              if (!realTx) {
                console.log(
                  `[solver] ${o.id.slice(0, 12)} rev: lock on-chain but Locked tx not found — skip`
                );
                continue;
              }
              await jpost(`/api/htlc/${o.id}/counter-lock`, {
                counterLockTx: realTx
              });
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
              const lastScan = watchtowerLastScan.get(o.id) ?? 0;
              if (Date.now() - lastScan < WATCHTOWER_MIN_MS) continue;
              watchtowerLastScan.set(o.id, Date.now());
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
                const lockTx =
                  (await findOrderScopedEventTx(pub, o, "Locked")) ??
                  (await findLockTx(pub, o.hashLock));
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
              // M-04: last-resort fallback scans from the escrow deploy (a Claimed
              // event can't predate it), not a fixed recent window that a 48–72h
              // order could outlive.
              if (fromBlock === undefined) fromBlock = escrowStartBlock;
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

        // STEP 4 — order is main_locked/counter_locking: verify the WBTC lock
        // on-chain, then lock/recover the Canton counter. Include counter_locking
        // so a crash or transient API failure after the lifecycle CAS is retried.
        if (
          (o.status === "main_locked" || o.status === "counter_locking") &&
          !lockedCounter.has(o.id)
        ) {
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
          const expectedWbtc = resolveWbtcAddress(
            resolveHtlcEvmConfig().slug
          ).toLowerCase();
          if (lock[2].toLowerCase() !== expectedWbtc) {
            console.log(
              `[solver] ${o.id.slice(0, 12)} lock token != WBTC — skip`
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
            const claimTx =
              (await findOrderScopedEventTx(pub, o, "Claimed")) ??
              (await findClaimTx(pub, o.hashLock));
            if (!claimTx) {
              console.log(
                `[solver] ${o.id.slice(0, 12)} lock empty but Claimed tx not found — cannot finalize`
              );
              continue;
            }
            console.log(
              `[solver] ${o.id.slice(0, 12)} lock already claimed → recording tx=${claimTx.slice(0, 14)}`
            );
            await jpost(`/api/htlc/${o.id}/main-claim`, {
              mainClaimTx: claimTx
            });
            claimedMain.add(o.id);
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
      // M-01: a full poll (list + per-order processing) completed without a
      // loop-level failure → mark the daemon ready/healthy.
      heartbeat.pollOk();
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

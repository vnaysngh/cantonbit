/**
 * Reverse HTLC (canton→evm) EVM counter-lock verification.
 * Ensures we never mark counter_locked without a real WBTC lock for the user.
 */
import { keccak_256 } from "@noble/hashes/sha3.js";

import { HTLC_ESCROW_ADDRESS, SWAP_CHAIN } from "./swap-evm";

/** keccak256("Locked(bytes32,uint256,uint256,address,address,address)") */
export const HTLC_LOCKED_EVENT_TOPIC =
  "0xd6d702a76b234272f4a006b7371c543bd5a459e14919397f2a451d0904c04fa3";

/** keccak256("Claimed(bytes,bytes32,uint256,uint256,address,address,address)") */
export const HTLC_CLAIMED_EVENT_TOPIC =
  "0x9baa2625abab959dfcaa38cf2046eb3d90f7e017d3c1a9ae36b079d5c77db937";

/** keccak256("Retaken(bytes32,uint256,uint256,address,address,address)") */
export const HTLC_RETAKEN_EVENT_TOPIC =
  "0x92fa5d2512a0c91c94e90087fc2ded03ce1ec5b10ef5c729af19bd597fc88d5f";

function normalizeHashLock(hashLock: string): string {
  const h = hashLock.startsWith("0x") ? hashLock.slice(2) : hashLock;
  return h.toLowerCase().padStart(64, "0");
}

function normalizeAddr(addr: string): string {
  return addr.toLowerCase();
}

function wordAt(data: string, i: number): string {
  const body = data.startsWith("0x") ? data.slice(2) : data;
  return body.slice(i * 64, (i + 1) * 64);
}

function addrFromWord(word: string): string {
  return `0x${word.slice(24)}`.toLowerCase();
}

export type ReverseCounterLockRequirements = {
  hashLock: string;
  wbtcAmount: string;
  userEvmAddress: string;
  solverTimelock: number;
  expectedWbtcAddress: string;
};

export type ParsedLockedEvent = {
  unlockTime: number;
  amount: bigint;
  tokenAddress: string;
  senderAddress: string;
  receiverAddress: string;
};

/** Decode non-indexed fields from a Locked log's data payload. */
export function parseLockedEventData(data: string): ParsedLockedEvent {
  return {
    unlockTime: parseInt(wordAt(data, 0), 16),
    amount: BigInt(`0x${wordAt(data, 1)}`),
    tokenAddress: addrFromWord(wordAt(data, 2)),
    senderAddress: addrFromWord(wordAt(data, 3)),
    receiverAddress: addrFromWord(wordAt(data, 4))
  };
}

export function assertReverseCounterLockMatches(
  lock: ParsedLockedEvent,
  req: ReverseCounterLockRequirements
): void {
  const expectedToken = normalizeAddr(req.expectedWbtcAddress);
  if (lock.tokenAddress !== expectedToken) {
    throw new Error("EVM counter-lock token is not canonical WBTC");
  }
  if (lock.amount < BigInt(req.wbtcAmount)) {
    throw new Error(
      `EVM counter-lock amount too small (${lock.amount} < ${req.wbtcAmount})`
    );
  }
  if (lock.receiverAddress !== normalizeAddr(req.userEvmAddress)) {
    throw new Error("EVM counter-lock receiver is not the user's EVM address");
  }
}

/** Read locks(hashLock) from escrow — unlockTime + amount + receiver. */
export async function readEvmLockMapping(
  hashLock: string,
  rpcUrl?: string
): Promise<{
  unlockTime: number;
  amount: bigint;
  tokenAddress: string;
  receiver: string;
}> {
  const hash = normalizeHashLock(hashLock);
  const selector = toHexLower(
    keccak_256(new TextEncoder().encode("locks(bytes32)"))
  ).slice(2, 10);
  const result = await rpcCall<string>(
    "eth_call",
    [
      {
        to: HTLC_ESCROW_ADDRESS,
        data: `0x${selector}${hash}`
      },
      "latest"
    ],
    rpcUrl
  );
  if (!result || result.length < 2 + 5 * 64) {
    throw new Error("EVM locks() read failed");
  }
  const word = (i: number) => result.slice(2 + i * 64, 2 + (i + 1) * 64);
  return {
    unlockTime: parseInt(word(0), 16),
    amount: BigInt(`0x${word(1)}`),
    tokenAddress: addrFromWord(word(2)),
    receiver: addrFromWord(word(4))
  };
}

function toHexLower(bytes: Uint8Array): string {
  return (
    "0x" +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}

/** Decode lock() calldata from a mined counter-lock transaction. */
export function parseLockTxCalldata(input: string): {
  unlockTime: number;
  amount: bigint;
  tokenAddress: string;
  receiverAddress: string;
} {
  const body = input.startsWith("0x") ? input.slice(2) : input;
  if (body.length < 8 + 64 * 5) {
    throw new Error("lock tx input too short");
  }
  const data = body.slice(8);
  return {
    unlockTime: parseInt(data.slice(64, 128), 16),
    amount: BigInt(`0x${data.slice(128, 192)}`),
    tokenAddress: addrFromWord(data.slice(192, 256)),
    receiverAddress: addrFromWord(data.slice(256, 320))
  };
}

async function readLockArgsFromTx(txHash: string): Promise<{
  unlockTime: number;
  amount: bigint;
  tokenAddress: string;
  receiverAddress: string;
}> {
  const tx = await rpcCall<{ input?: string } | null>(
    "eth_getTransactionByHash",
    [txHash]
  );
  if (!tx?.input) throw new Error(`counter-lock tx input missing: ${txHash}`);
  return parseLockTxCalldata(tx.input);
}

type RpcReceipt = {
  status?: string;
  blockNumber?: string;
  blockHash?: string;
  logs?: { address?: string; topics?: string[]; data?: string }[];
};

async function rpcCall<T>(
  method: string,
  params: unknown[],
  rpcUrl?: string
): Promise<T> {
  const rpc =
    rpcUrl?.trim() ||
    process.env.ORIGIN_RPC_URL?.trim() ||
    SWAP_CHAIN.rpcUrls[0];
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    cache: "no-store"
  });
  if (!res.ok) throw new Error(`EVM RPC ${method} failed (${res.status})`);
  const { result, error } = (await res.json()) as {
    result?: T;
    error?: { message?: string };
  };
  if (error) throw new Error(error.message ?? `EVM RPC ${method} error`);
  return result as T;
}

export async function evmBlockAtOrBeforeUnixTime(
  timestampSeconds: number,
  rpcUrl?: string
): Promise<string> {
  const tipHex = await getBlockNumberHex(rpcUrl);
  let lo = 0n;
  let hi = BigInt(tipHex);
  const target = BigInt(Math.max(0, Math.floor(timestampSeconds)));
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    const block = await rpcCall<{ timestamp?: string } | null>(
      "eth_getBlockByNumber",
      [`0x${mid.toString(16)}`, false],
      rpcUrl
    );
    const ts = BigInt(block?.timestamp ?? "0x0");
    if (ts <= target) lo = mid;
    else hi = mid - 1n;
  }
  return `0x${lo.toString(16)}`;
}

/** Canonical ERC-20 balance read used before reserving reverse solver inventory. */
export async function readErc20Balance(
  tokenAddress: string,
  ownerAddress: string,
  rpcUrl?: string
): Promise<bigint> {
  const token = normalizeAddr(tokenAddress);
  const owner = normalizeAddr(ownerAddress).replace(/^0x/, "");
  if (!/^0x[0-9a-f]{40}$/.test(token) || !/^[0-9a-f]{40}$/.test(owner)) {
    throw new Error("invalid token or owner address for balance read");
  }
  const result = await rpcCall<string>(
    "eth_call",
    [
      {
        to: token,
        data: `0x70a08231${owner.padStart(64, "0")}`
      },
      "latest"
    ],
    rpcUrl
  );
  if (!/^0x[0-9a-f]+$/i.test(result ?? "")) {
    throw new Error("ERC-20 balanceOf returned invalid data");
  }
  return BigInt(result);
}

function findLockedLog(
  receipt: RpcReceipt,
  hashLock: string
): ParsedLockedEvent | null {
  const want = normalizeHashLock(hashLock);
  const topic1 = `0x${want}`;
  const escrow = HTLC_ESCROW_ADDRESS.toLowerCase();
  for (const log of receipt.logs ?? []) {
    if ((log.address ?? "").toLowerCase() !== escrow) continue;
    const topics = log.topics ?? [];
    if (topics[0]?.toLowerCase() !== HTLC_LOCKED_EVENT_TOPIC) continue;
    if ((topics[1] ?? "").toLowerCase() !== topic1) continue;
    if (!log.data) continue;
    return parseLockedEventData(log.data);
  }
  return null;
}

/** Verify counter-lock tx exists on-chain and emitted a matching Locked event. */
export async function verifyReverseCounterLockTx(
  counterLockTx: string,
  req: ReverseCounterLockRequirements
): Promise<ParsedLockedEvent> {
  const tx = counterLockTx.trim();
  if (!tx.startsWith("0x") || tx.length !== 66) {
    throw new Error("counterLockTx must be a 32-byte tx hash (0x + 64 hex)");
  }
  const receipt = await rpcCall<RpcReceipt>("eth_getTransactionReceipt", [tx]);
  if (!receipt) {
    throw new Error(`counter-lock tx not found on ${SWAP_CHAIN.name}: ${tx}`);
  }
  if (receipt.status !== "0x1") {
    throw new Error(`counter-lock tx reverted on-chain: ${tx}`);
  }
  await assertEvmTransactionFinalized(tx);
  const locked = findLockedLog(receipt, req.hashLock);
  if (!locked) {
    throw new Error(
      `counter-lock tx has no matching Locked event for hashLock on escrow ${HTLC_ESCROW_ADDRESS}`
    );
  }
  assertReverseCounterLockMatches(locked, req);
  const args = await readLockArgsFromTx(tx);
  if (args.unlockTime !== req.solverTimelock) {
    throw new Error(
      `EVM counter-lock unlockTime mismatch (${args.unlockTime} != ${req.solverTimelock})`
    );
  }
  if (args.amount < BigInt(req.wbtcAmount)) {
    throw new Error(
      `EVM counter-lock tx amount too small (${args.amount} < ${req.wbtcAmount})`
    );
  }
  if (args.receiverAddress !== normalizeAddr(req.userEvmAddress)) {
    throw new Error("EVM counter-lock tx receiver mismatch");
  }
  for (let i = 0; i < 6; i++) {
    const onChain = await readEvmLockMapping(req.hashLock);
    if (onChain.amount >= BigInt(req.wbtcAmount)) return locked;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("EVM counter-lock not visible in locks() after tx mined");
}

async function getBlockNumberHex(rpcUrl?: string): Promise<string> {
  return rpcCall<string>("eth_blockNumber", [], rpcUrl);
}

export function evmMinConfirmations(): number {
  const value = Number(process.env.EVM_MIN_CONFIRMATIONS ?? "3");
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error("EVM_MIN_CONFIRMATIONS must be an integer from 1 to 100");
  }
  return value;
}

/** Refuse to treat a merely included transaction as final settlement evidence. */
export async function assertEvmTransactionFinalized(
  txHash: string,
  opts?: { minConfirmations?: number; rpcUrl?: string }
): Promise<void> {
  const receipt = await rpcCall<RpcReceipt | null>(
    "eth_getTransactionReceipt",
    [txHash],
    opts?.rpcUrl
  );
  if (!receipt?.blockNumber) {
    throw new Error("EVM transaction is not mined yet");
  }
  const tip = BigInt(await getBlockNumberHex(opts?.rpcUrl));
  const block = BigInt(receipt.blockNumber);
  const confirmations = tip >= block ? tip - block + 1n : 0n;
  const required = BigInt(opts?.minConfirmations ?? evmMinConfirmations());
  if (confirmations < required) {
    throw new Error(
      `EVM transaction awaiting finality (${confirmations}/${required} confirmations)`
    );
  }
  const confirmed = await rpcCall<RpcReceipt | null>(
    "eth_getTransactionReceipt",
    [txHash],
    opts?.rpcUrl
  );
  if (
    !confirmed ||
    confirmed.status !== "0x1" ||
    confirmed.blockNumber !== receipt.blockNumber ||
    !confirmed.blockHash ||
    confirmed.blockHash !== receipt.blockHash
  ) {
    throw new Error("EVM transaction receipt changed during finality check");
  }
}

/** True if a Claimed event exists for this hashLock (user revealed preimage on EVM). */
export async function hasEvmClaimedForHashLock(
  hashLock: string,
  opts?: { fromBlockHex?: string; rpcUrl?: string }
): Promise<boolean> {
  const want = normalizeHashLock(hashLock);
  const topic1 = `0x${want}`;
  const rpc = opts?.rpcUrl;
  const tip = await getBlockNumberHex(rpc);
  const tipN = BigInt(tip);
  // C-02: when we have no trustworthy anchor block (counterLockTx missing/unmined),
  // scan from genesis rather than a fixed recent window — a claim on an older/legacy
  // order could fall outside a 50k-block window, and missing it would let a refund
  // proceed after the user already took the WBTC. Slow but never misses.
  let from = opts?.fromBlockHex ? BigInt(opts.fromBlockHex) : 0n;
  if (from < 0n) from = 0n;
  const chunk = 1990n;
  while (from <= tipN) {
    const to = from + chunk - 1n > tipN ? tipN : from + chunk - 1n;
    const logs = await rpcCall<{ topics?: string[] }[]>(
      "eth_getLogs",
      [
        {
          address: HTLC_ESCROW_ADDRESS,
          topics: [HTLC_CLAIMED_EVENT_TOPIC, topic1],
          fromBlock: `0x${from.toString(16)}`,
          toBlock: `0x${to.toString(16)}`
        }
      ],
      rpc
    );
    if ((logs?.length ?? 0) > 0) return true;
    from = to + 1n;
  }
  return false;
}

export type ReverseEvmCounterLockProbe = {
  hashLock: string;
  wbtcAmount: string;
  userEvmAddress: string;
};

/** Fast on-chain probe: is WBTC locked for this user at hashLock? (single eth_call) */
export async function isReverseEvmCounterLockReady(
  probe: ReverseEvmCounterLockProbe,
  opts?: { rpcUrl?: string }
): Promise<{ ready: true } | { ready: false; reason: string }> {
  try {
    const lock = await readEvmLockMapping(probe.hashLock, opts?.rpcUrl);
    const need = BigInt(probe.wbtcAmount);
    if (lock.amount < need) {
      return {
        ready: false,
        reason: "No WBTC lock found on-chain for this swap yet."
      };
    }
    if (
      lock.receiver.toLowerCase() !== normalizeAddr(probe.userEvmAddress)
    ) {
      return {
        ready: false,
        reason: "On-chain WBTC lock receiver does not match your wallet."
      };
    }
    return { ready: true };
  } catch {
    return {
      ready: false,
      reason: "Could not read WBTC lock status from the chain."
    };
  }
}

/** Block number hex for a tx hash, if mined. */
export async function evmTxBlockHex(txHash: string): Promise<string | undefined> {
  if (!txHash.startsWith("0x") || txHash.length !== 66) return undefined;
  const receipt = await rpcCall<RpcReceipt | null>(
    "eth_getTransactionReceipt",
    [txHash]
  );
  return receipt?.blockNumber;
}

function receiptHasHashLockEvent(
  receipt: RpcReceipt,
  hashLock: string,
  eventTopic: string
): boolean {
  const want = normalizeHashLock(hashLock);
  const topic1 = `0x${want}`;
  const escrow = HTLC_ESCROW_ADDRESS.toLowerCase();
  for (const log of receipt.logs ?? []) {
    if ((log.address ?? "").toLowerCase() !== escrow) continue;
    const topics = log.topics ?? [];
    if (topics[0]?.toLowerCase() !== eventTopic.toLowerCase()) continue;
    if ((topics[1] ?? "").toLowerCase() !== topic1) continue;
    return true;
  }
  return false;
}

/** Verify forward user retake tx emitted Retaken for this hashLock. */
export async function verifyForwardRetakeTx(
  retakeTx: string,
  hashLock: string
): Promise<void> {
  const tx = retakeTx.trim();
  if (!tx.startsWith("0x") || tx.length !== 66) {
    throw new Error("retakeTx must be a 32-byte tx hash (0x + 64 hex)");
  }
  const receipt = await rpcCall<RpcReceipt>("eth_getTransactionReceipt", [tx]);
  if (!receipt) {
    throw new Error(`retake tx not found on ${SWAP_CHAIN.name}: ${tx}`);
  }
  if (receipt.status !== "0x1") {
    throw new Error(`retake tx reverted on-chain: ${tx}`);
  }
  await assertEvmTransactionFinalized(tx);
  if (!receiptHasHashLockEvent(receipt, hashLock, HTLC_RETAKEN_EVENT_TOPIC)) {
    throw new Error(
      `retake tx has no matching Retaken event for hashLock on escrow ${HTLC_ESCROW_ADDRESS}`
    );
  }
}

/** Verify reverse user claim tx emitted Claimed for this hashLock. */
export async function verifyReverseClaimTx(
  claimTx: string,
  hashLock: string
): Promise<void> {
  const tx = claimTx.trim();
  if (!tx.startsWith("0x") || tx.length !== 66) {
    throw new Error("claim tx must be a 32-byte tx hash (0x + 64 hex)");
  }
  const receipt = await rpcCall<RpcReceipt>("eth_getTransactionReceipt", [tx]);
  if (!receipt) {
    throw new Error(`claim tx not found on ${SWAP_CHAIN.name}: ${tx}`);
  }
  if (receipt.status !== "0x1") {
    throw new Error(`claim tx reverted on-chain: ${tx}`);
  }
  await assertEvmTransactionFinalized(tx);
  if (!receiptHasHashLockEvent(receipt, hashLock, HTLC_CLAIMED_EVENT_TOPIC)) {
    throw new Error(
      `claim tx has no matching Claimed event for hashLock on escrow ${HTLC_ESCROW_ADDRESS}`
    );
  }
}

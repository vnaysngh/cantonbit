/**
 * HTLC settle (T9 + T10) — the solver claims the user's WBTC on EVM using the
 * revealed preimage. This is where the swap completes and the OLD oracle path
 * (attest + finalise on OranjAttestorOracle) is replaced.
 *
 * Flow position (Cancore's 8 steps):
 *   step 6  the user reveals the preimage to receive cBTC (T8 released it on a
 *           valid preimage). The orchestrator now HAS the preimage.
 *   step 7  Claim Main — solver calls HTLCEscrow.claim(preImage) → WBTC released
 *           to the solver. THIS module.
 *
 * The preimage may be learned two ways (both supported):
 *   A) the user reveals it to the orchestrator to get their cBTC (off-chain, the
 *      EVM→Canton direction). The orchestrator verifies it, releases cBTC (T8),
 *      then claims WBTC here.
 *   B) the preimage appears on-chain (e.g. the reverse direction, or a watchtower
 *      reading the Canton claim's exercised argument). reveal-watch (below) reads
 *      it from there.
 *
 * Trustlessness: the EVM leg is a REAL HTLC. The solver can only claim WBTC by
 * presenting a preimage whose keccak256 == the hashLock the user signed. No
 * oracle, no attestation — the secret is the only key. (Deletes the old trusted
 * OranjAttestorOracle dependency — T10.)
 */

import {
  createPublicClient,
  createWalletClient,
  getContract,
  http,
  keccak256,
  type Account,
  type Address,
  type Hex,
} from "viem";

import { HTLC_ESCROW_ABI } from "./htlc-abi.js";

export interface HtlcSettleConfig {
  rpcUrl: string;
  /** Deployed HTLCEscrow address on the origin (EVM) chain. */
  htlcEscrow: Address;
  /** The solver account that submits claim() and receives the WBTC. */
  account: Account;
}

export type SettleOutcome =
  | { kind: "claimed"; txHash: Hex }
  | { kind: "alreadyClaimed" }
  | { kind: "badPreimage"; reason: string }
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; reason: string };

export class HtlcSettler {
  private cfg: HtlcSettleConfig;
  private pub: ReturnType<typeof createPublicClient>;
  private wallet: ReturnType<typeof createWalletClient>;

  constructor(cfg: HtlcSettleConfig) {
    this.cfg = cfg;
    this.pub = createPublicClient({ transport: http(cfg.rpcUrl) });
    this.wallet = createWalletClient({ account: cfg.account, transport: http(cfg.rpcUrl) });
  }

  /**
   * Claim the user's WBTC on EVM with the revealed preimage (step 7). Idempotent
   * and crash-safe: if the lock no longer exists on-chain (already claimed or
   * already retaken), returns without re-sending.
   *
   * @param preImage The revealed secret, as 0x-hex of the RAW bytes (the EVM
   *   HTLCEscrow hashes these raw bytes; keccak256(preImage) must == hashLock).
   * @param hashLock The committed hashlock (bytes32) from the user's signed order.
   */
  async claimWithPreimage(preImage: Hex, hashLock: Hex): Promise<SettleOutcome> {
    // 1. verify the preimage matches the committed hash (never submit a bad one).
    if (keccak256(preImage).toLowerCase() !== hashLock.toLowerCase()) {
      return { kind: "badPreimage", reason: "keccak256(preImage) != hashLock" };
    }

    const escrow = getContract({
      address: this.cfg.htlcEscrow,
      abi: HTLC_ESCROW_ABI,
      client: { public: this.pub, wallet: this.wallet },
    });

    // 2. crash-safe: if the lock is gone (claimed/retaken), nothing to do.
    try {
      const lock = (await escrow.read.locks([hashLock])) as readonly [bigint, bigint, Address, Address, Address];
      const amount = lock[1];
      if (amount === 0n) {
        return { kind: "alreadyClaimed" }; // lock deleted on-chain
      }
    } catch (e) {
      return { kind: "skipped", reason: `lock read failed (transient): ${errMsg(e)}` };
    }

    // 3. claim — releases the WBTC to the lock's receiver (the solver).
    try {
      const txHash = await escrow.write.claim([preImage], { account: this.cfg.account, chain: null });
      await this.pub.waitForTransactionReceipt({ hash: txHash });
      return { kind: "claimed", txHash };
    } catch (e) {
      return { kind: "failed", reason: `claim failed (will retry): ${errMsg(e)}` };
    }
  }

  /**
   * REFUND (T11) — retake a locked WBTC after its timelock. Only the lock's
   * sender (the funder) can retake; this is normally the USER's action via
   * MetaMask, but the solver/watchtower can also submit it on behalf of the
   * sender (retake sends to the stored sender regardless of who pays gas — same
   * as Cancore's "manual retake"). Safe/idempotent: if the lock is gone, no-op.
   *
   * `account` here must be the lock's sender for the on-chain require to pass
   * (Cancore restricts retake to msg.sender == senderAddress). So this is for the
   * party whose account funded the lock. For the EVM leg in EVM→Canton, that's
   * the USER — so the user retakes their own WBTC; the solver can't retake for
   * them, which is correct (the user's funds, the user's refund).
   */
  async retakeAfterTimeout(hashLock: Hex, nowSeconds: number): Promise<SettleOutcome> {
    const escrow = getContract({
      address: this.cfg.htlcEscrow,
      abi: HTLC_ESCROW_ABI,
      client: { public: this.pub, wallet: this.wallet },
    });
    let lock: readonly [bigint, bigint, Address, Address, Address];
    try {
      lock = (await escrow.read.locks([hashLock])) as readonly [bigint, bigint, Address, Address, Address];
    } catch (e) {
      return { kind: "skipped", reason: `lock read failed (transient): ${errMsg(e)}` };
    }
    const [unlockTime, amount, , senderAddress] = lock;
    if (amount === 0n) return { kind: "alreadyClaimed" }; // gone (claimed or already retaken)
    if (nowSeconds < Number(unlockTime)) {
      return { kind: "skipped", reason: `too early: ${Number(unlockTime) - nowSeconds}s until retake` };
    }
    if (this.cfg.account.address.toLowerCase() !== senderAddress.toLowerCase()) {
      return { kind: "skipped", reason: "only the lock sender can retake (this account is not the funder)" };
    }
    try {
      const txHash = await escrow.write.retake([hashLock], { account: this.cfg.account, chain: null });
      await this.pub.waitForTransactionReceipt({ hash: txHash });
      return { kind: "claimed", txHash }; // 'claimed' = the terminal-refund tx landed
    } catch (e) {
      return { kind: "failed", reason: `retake failed (will retry): ${errMsg(e)}` };
    }
  }
}

/**
 * reveal-watch (T9, case B) — extract a revealed preimage from an EVM `Claimed`
 * event for a given hashLock. Once ANY party claims an HTLC lock, the preimage is
 * public in the Claimed event; a watchtower (or the reverse-direction solver) can
 * read it here and use it to claim the OTHER leg. Returns the preimage (0x-hex of
 * the raw bytes) or null if not yet revealed.
 *
 * This is the on-chain reveal source. (For EVM→Canton the solver usually already
 * has the preimage from the user's cBTC-claim request, so it doesn't need this —
 * but the watchtower and the reverse direction do.)
 */
export async function readRevealedPreimage(
  pub: ReturnType<typeof createPublicClient>,
  htlcEscrow: Address,
  hashLock: Hex,
  fromBlock: bigint,
): Promise<Hex | null> {
  const logs = await pub.getContractEvents({
    address: htlcEscrow,
    abi: HTLC_ESCROW_ABI,
    eventName: "Claimed",
    args: { hashValue: hashLock },
    fromBlock,
    toBlock: "latest",
  });
  for (const log of logs) {
    const pre = (log as { args?: { preImage?: Hex } }).args?.preImage;
    if (pre && keccak256(pre).toLowerCase() === hashLock.toLowerCase()) {
      return pre;
    }
  }
  return null;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

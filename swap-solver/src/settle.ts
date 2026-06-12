/**
 * Settle leg (Task 8) — release the locked WBTC for a `delivered` order.
 *
 * For each `delivered` order (CBTC already accepted by the user on Canton, with
 * a captured fillTimestamp): compute the payloadHash, `attest()` it on our
 * oracle, then `finalise()` on the escrow to pull the WBTC to the solver.
 * Transitions: delivered → attested → finalised.
 *
 * This closes the loop whose on-chain mechanics are already proven in
 * contracts/test/EscrowReleasePath.t.sol — now driven live and signed by the
 * agent key.
 *
 * Idempotency / crash-safety:
 *   - attest() is a no-op if the slot is already proven; we also skip it when
 *     isProven() is already true, and record attestTxHash.
 *   - finalise() releases funds exactly once on-chain (the escrow's OrderStatus
 *     guard). If the order is already Claimed on-chain we mark finalised without
 *     re-sending.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  getContract,
  type Account,
  type Address,
  type Hex
} from "viem";

import { ESCROW_ABI, ORACLE_ABI, ORDER_STATUS } from "./abi.js";
import { deserializeOrder } from "./convert.js";
import { fillDescriptionHash } from "./encoding.js";
import type { OrderStore } from "./store.js";

export interface SettleConfig {
  rpcUrl: string;
  escrow: Address;
  oracle: Address;
  /** The agent account (signs attest + finalise). This is the HOT key. */
  account: Account;
  /**
   * Where the released WBTC is sent on finalise (the escrow `destination`).
   * Decoupled from the signing key so collected funds can land in a separate
   * cold/treasury wallet. Defaults to the agent address if unset (backwards
   * compatible). NOTE: this is NOT part of the proof — only `solver` (the agent
   * identity) is hashed into the attestation; `destination` just routes funds.
   */
  payoutAddress?: Address;
  /**
   * Minimum agent ETH balance (wei) required to attempt settlement. Ports CoW's
   * solver native-token guard (settlement.rs:84-136): if the hot key can't pay for
   * attest+finalise gas, SKIP (don't strand a delivered order mid-settlement) and
   * warn loudly. 0/undefined = no floor (best-effort). Set MIN_GAS_ETH_WEI to enable.
   */
  minEthForGasWei?: bigint;
}

export type SettleOutcome =
  | { kind: "skipped"; reason: string }
  | { kind: "finalised"; attestTxHash?: Hex; finaliseTxHash?: Hex }
  | { kind: "failed"; reason: string };

export class Settler {
  private cfg: SettleConfig;
  private pub: ReturnType<typeof createPublicClient>;
  private wallet: ReturnType<typeof createWalletClient>;

  constructor(cfg: SettleConfig) {
    this.cfg = cfg;
    this.pub = createPublicClient({ transport: http(cfg.rpcUrl) });
    this.wallet = createWalletClient({
      account: cfg.account,
      transport: http(cfg.rpcUrl)
    });
  }

  /** The solver's identity (hashed into the proof) = the agent address as bytes32. */
  private solverId(): Hex {
    return `0x${"00".repeat(12)}${this.cfg.account.address.slice(2)}` as Hex;
  }

  /**
   * PRE-FLIGHT (called BEFORE delivering CBTC): is the WBTC collection guaranteed
   * to succeed? If yes, delivering the CBTC is safe — both legs will complete
   * together (never user-gets-CBTC-but-we-lose-WBTC). Checks the two conditions
   * that make a later finalise() unfailable:
   *   1. the order's WBTC is DEPOSITED in escrow on-chain (locked & claimable), and
   *   2. there's comfortable margin before `expires` (so finalise can't lose a
   *      race to the user's refund window).
   * Attest is the solver's OWN oracle (always succeeds for our fills), so with
   * (1)+(2) true, the whole settle path is guaranteed. Returns
   * { ok: true } or { ok: false, reason }.
   */
  async verifyClaimable(
    orderId: Hex,
    expires: number,
    nowSeconds: number,
    minMarginSeconds: number
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    // 2. time margin — finalise must run well before the refund window opens.
    if (nowSeconds + minMarginSeconds >= expires) {
      return {
        ok: false,
        reason: `too close to expiry: ${expires - nowSeconds}s left (need > ${minMarginSeconds}s)`
      };
    }
    // 1. WBTC must be DEPOSITED (locked & claimable) in the escrow.
    try {
      const escrow = getContract({
        address: this.cfg.escrow,
        abi: ESCROW_ABI,
        client: { public: this.pub, wallet: this.wallet }
      });
      const status = Number(await escrow.read.orderStatus([orderId]));
      // enum OrderStatus { None, Deposited, Claimed, Refunded }
      if (status !== 1 /* Deposited */) {
        const names = ["None", "Deposited", "Claimed", "Refunded"];
        return {
          ok: false,
          reason: `WBTC not claimable: escrow status is ${names[status] ?? status} (need Deposited)`
        };
      }
    } catch (e) {
      return { ok: false, reason: `couldn't read escrow status: ${errMsg(e)}` };
    }
    return { ok: true };
  }

  /**
   * Where the released WBTC lands (escrow `destination`), as bytes32. This is
   * the payout/treasury address — separate from the signing key — and is NOT
   * part of the attestation proof. Defaults to the agent address.
   */
  private destinationId(): Hex {
    const payout = this.cfg.payoutAddress ?? this.cfg.account.address;
    return `0x${"00".repeat(12)}${payout.slice(2)}` as Hex;
  }

  async settleOne(store: OrderStore, orderId: Hex): Promise<SettleOutcome> {
    const rec = await store.get(orderId);
    if (!rec) return { kind: "failed", reason: "order not found" };
    if (rec.status !== "delivered" && rec.status !== "attested") {
      return {
        kind: "skipped",
        reason: `status '${rec.status}' is not delivered/attested`
      };
    }
    if (rec.fillTimestamp == null) {
      return await fail(store, orderId, "delivered order has no fillTimestamp");
    }

    const order = deserializeOrder(rec.order);
    const output = order.outputs[0];
    if (!output) return await fail(store, orderId, "order has no output");

    // GAS PRE-FLIGHT (CoW solver native-token guard, settlement.rs:84-136): if the
    // agent hot key lacks the ETH to pay for attest+finalise, SKIP rather than
    // start and strand the order half-settled. Skipped (not failed) so the next
    // tick retries once the key is topped up. The CBTC is already delivered; we
    // just defer pulling the WBTC until we can afford the gas.
    if (this.cfg.minEthForGasWei && this.cfg.minEthForGasWei > 0n) {
      let agentEth: bigint;
      try {
        agentEth = await this.pub.getBalance({
          address: this.cfg.account.address
        });
      } catch (e) {
        return {
          kind: "skipped",
          reason: `agent balance read failed (transient): ${e instanceof Error ? e.message : e}`
        };
      }
      if (agentEth < this.cfg.minEthForGasWei) {
        console.warn(
          `[settle] agent ETH ${agentEth} < min ${this.cfg.minEthForGasWei} wei — deferring settlement of ${orderId.slice(0, 12)}… (top up the hot key)`
        );
        return {
          kind: "skipped",
          reason: `agent ETH too low for gas: ${agentEth} < ${this.cfg.minEthForGasWei} wei`
        };
      }
    }

    const solverId = this.solverId();
    const fillTs = rec.fillTimestamp;

    // Defensive: fillTimestamp must still be <= fillDeadline (7b already checked,
    // but re-check before spending gas).
    if (fillTs > order.fillDeadline) {
      return await fail(
        store,
        orderId,
        `fillTimestamp ${fillTs} > fillDeadline ${order.fillDeadline}`
      );
    }

    const dataHash = fillDescriptionHash(solverId, orderId, fillTs, output);

    const oracle = getContract({
      address: this.cfg.oracle,
      abi: ORACLE_ABI,
      client: { public: this.pub, wallet: this.wallet }
    });
    const escrow = getContract({
      address: this.cfg.escrow,
      abi: ESCROW_ABI,
      client: { public: this.pub, wallet: this.wallet }
    });

    // --- 1. attest (idempotent) ---
    let attestTxHash = rec.attestTxHash;
    const alreadyProven = (await oracle.read.isProven([
      output.chainId,
      output.oracle,
      output.settler,
      dataHash
    ])) as boolean;

    if (!alreadyProven) {
      try {
        attestTxHash = await oracle.write.attest(
          [output.chainId, output.oracle, output.settler, dataHash],
          { account: this.cfg.account, chain: null }
        );
        await this.pub.waitForTransactionReceipt({ hash: attestTxHash });
        await store.update(orderId, { status: "attested", attestTxHash });
      } catch (e) {
        return {
          kind: "skipped",
          reason: `attest failed (will retry): ${errMsg(e)}`
        };
      }
    } else if (rec.status === "delivered") {
      await store.update(orderId, { status: "attested", attestTxHash });
    }

    // --- 2. finalise (releases WBTC) ---
    // Skip if already Claimed on-chain (crash-safe re-run).
    const status = (await escrow.read.orderStatus([orderId])) as number;
    if (status === ORDER_STATUS.Claimed) {
      await store.update(orderId, {
        status: "finalised",
        note: "already claimed on-chain"
      });
      return {
        kind: "finalised",
        attestTxHash,
        finaliseTxHash: rec.finaliseTxHash
      };
    }

    try {
      // solver = agent identity (matches the attested proof); destination =
      // payout/treasury address (where the WBTC actually lands).
      const solveParams = [{ timestamp: fillTs, solver: solverId }];
      const destination = this.destinationId();
      const finaliseTxHash = await escrow.write.finalise(
        [orderToTuple(order), solveParams, destination, "0x"],
        { account: this.cfg.account, chain: null }
      );
      await this.pub.waitForTransactionReceipt({ hash: finaliseTxHash });
      await store.update(orderId, { status: "finalised", finaliseTxHash });
      return { kind: "finalised", attestTxHash, finaliseTxHash };
    } catch (e) {
      return {
        kind: "skipped",
        reason: `finalise failed (will retry): ${errMsg(e)}`
      };
    }
  }

  /** Process all settleable (delivered/attested) orders once. */
  async settleReady(
    store: OrderStore
  ): Promise<{ orderId: Hex; outcome: SettleOutcome }[]> {
    const out: { orderId: Hex; outcome: SettleOutcome }[] = [];
    const _ready = [
      ...(await store.byStatus("delivered")),
      ...(await store.byStatus("attested"))
    ];
    for (const rec of _ready) {
      out.push({
        orderId: rec.orderId,
        outcome: await this.settleOne(store, rec.orderId)
      });
    }
    return out;
  }
}

/** StandardOrder → the tuple viem passes to finalise (field-identical). */
function orderToTuple(o: ReturnType<typeof deserializeOrder>) {
  return o;
}

async function fail(
  store: OrderStore,
  orderId: Hex,
  reason: string
): Promise<SettleOutcome> {
  await store.update(orderId, { status: "failed", note: reason });
  return { kind: "failed", reason };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

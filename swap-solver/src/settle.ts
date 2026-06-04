/**
 * Settle leg (Task 8) — release the locked WBTC for a `delivered` order.
 *
 * For each `delivered` order (cBTC already accepted by the user on Canton, with
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
  type Hex,
} from "viem";

import { ESCROW_ABI, ORACLE_ABI, ORDER_STATUS } from "./abi.js";
import { deserializeOrder } from "./convert.js";
import { fillDescriptionHash } from "./encoding.js";
import type { OrderStore } from "./store.js";

export interface SettleConfig {
  rpcUrl: string;
  escrow: Address;
  oracle: Address;
  /** The agent account (signs attest + finalise). This is the treasury key. */
  account: Account;
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
    this.wallet = createWalletClient({ account: cfg.account, transport: http(cfg.rpcUrl) });
  }

  /** The solver's identity = the agent address, as both solver & destination. */
  private solverId(): Hex {
    return `0x${"00".repeat(12)}${this.cfg.account.address.slice(2)}` as Hex;
  }

  async settleOne(store: OrderStore, orderId: Hex): Promise<SettleOutcome> {
    const rec = store.get(orderId);
    if (!rec) return { kind: "failed", reason: "order not found" };
    if (rec.status !== "delivered" && rec.status !== "attested") {
      return { kind: "skipped", reason: `status '${rec.status}' is not delivered/attested` };
    }
    if (rec.fillTimestamp == null) {
      return fail(store, orderId, "delivered order has no fillTimestamp");
    }

    const order = deserializeOrder(rec.order);
    const output = order.outputs[0];
    if (!output) return fail(store, orderId, "order has no output");

    const solverId = this.solverId();
    const fillTs = rec.fillTimestamp;

    // Defensive: fillTimestamp must still be <= fillDeadline (7b already checked,
    // but re-check before spending gas).
    if (fillTs > order.fillDeadline) {
      return fail(store, orderId, `fillTimestamp ${fillTs} > fillDeadline ${order.fillDeadline}`);
    }

    const dataHash = fillDescriptionHash(solverId, orderId, fillTs, output);

    const oracle = getContract({ address: this.cfg.oracle, abi: ORACLE_ABI, client: { public: this.pub, wallet: this.wallet } });
    const escrow = getContract({ address: this.cfg.escrow, abi: ESCROW_ABI, client: { public: this.pub, wallet: this.wallet } });

    // --- 1. attest (idempotent) ---
    let attestTxHash = rec.attestTxHash;
    const alreadyProven = (await oracle.read.isProven([
      output.chainId,
      output.oracle,
      output.settler,
      dataHash,
    ])) as boolean;

    if (!alreadyProven) {
      try {
        attestTxHash = await oracle.write.attest(
          [output.chainId, output.oracle, output.settler, dataHash],
          { account: this.cfg.account, chain: null },
        );
        await this.pub.waitForTransactionReceipt({ hash: attestTxHash });
        store.update(orderId, { status: "attested", attestTxHash });
      } catch (e) {
        return { kind: "skipped", reason: `attest failed (will retry): ${errMsg(e)}` };
      }
    } else if (rec.status === "delivered") {
      store.update(orderId, { status: "attested", attestTxHash });
    }

    // --- 2. finalise (releases WBTC) ---
    // Skip if already Claimed on-chain (crash-safe re-run).
    const status = (await escrow.read.orderStatus([orderId])) as number;
    if (status === ORDER_STATUS.Claimed) {
      store.update(orderId, { status: "finalised", note: "already claimed on-chain" });
      return { kind: "finalised", attestTxHash, finaliseTxHash: rec.finaliseTxHash };
    }

    try {
      const solveParams = [{ timestamp: fillTs, solver: solverId }];
      const finaliseTxHash = await escrow.write.finalise(
        [orderToTuple(order), solveParams, solverId, "0x"],
        { account: this.cfg.account, chain: null },
      );
      await this.pub.waitForTransactionReceipt({ hash: finaliseTxHash });
      store.update(orderId, { status: "finalised", finaliseTxHash });
      return { kind: "finalised", attestTxHash, finaliseTxHash };
    } catch (e) {
      return { kind: "skipped", reason: `finalise failed (will retry): ${errMsg(e)}` };
    }
  }

  /** Process all settleable (delivered/attested) orders once. */
  async settleReady(store: OrderStore): Promise<{ orderId: Hex; outcome: SettleOutcome }[]> {
    const out: { orderId: Hex; outcome: SettleOutcome }[] = [];
    for (const rec of [...store.byStatus("delivered"), ...store.byStatus("attested")]) {
      out.push({ orderId: rec.orderId, outcome: await this.settleOne(store, rec.orderId) });
    }
    return out;
  }
}

/** StandardOrder → the tuple viem passes to finalise (field-identical). */
function orderToTuple(o: ReturnType<typeof deserializeOrder>) {
  return o;
}

function fail(store: OrderStore, orderId: Hex, reason: string): SettleOutcome {
  store.update(orderId, { status: "failed", note: reason });
  return { kind: "failed", reason };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

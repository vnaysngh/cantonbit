/**
 * Open-event watcher — the solver's intake leg.
 *
 * Subscribes to InputSettlerEscrow `Open(orderId, order)` on the origin chain,
 * decodes each into the canonical StandardOrder, and records it in the store as
 * `seen`. Resumable: on start it backfills from the persisted cursor, then
 * follows the chain head. Idempotent: an orderId already in the store is
 * ignored (the store enforces this), so reprocessing a block range is safe.
 *
 * No Canton calls here — this leg only observes Base. Downstream legs (deliver,
 * attest, finalise) consume `seen` orders from the store (Tasks 7-8).
 */

import {
  createPublicClient,
  http,
  webSocket,
  parseEventLogs,
  type Address,
  type Hex,
  type PublicClient,
  type Log,
} from "viem";

import { ESCROW_ABI } from "./abi.js";
import { OrderStore, type SerializedOrder } from "./store.js";

export interface WatcherConfig {
  /** Origin-chain RPC. Use ws:// for live subscription, http:// for polling. */
  rpcUrl: string;
  escrow: Address;
  /** Block to start from if the store has no cursor yet (e.g. deploy block). */
  startBlock: bigint;
  /** Backfill chunk size (blocks per getLogs call). */
  chunkSize?: bigint;
}

type OpenLog = Log<bigint, number, false> & {
  args: { orderId: Hex; order: DecodedOrder };
};

interface DecodedOrder {
  user: Address;
  nonce: bigint;
  originChainId: bigint;
  expires: number;
  fillDeadline: number;
  inputOracle: Address;
  inputs: readonly (readonly [bigint, bigint])[];
  outputs: readonly {
    oracle: Hex;
    settler: Hex;
    chainId: bigint;
    token: Hex;
    amount: bigint;
    recipient: Hex;
    callbackData: Hex;
    context: Hex;
  }[];
}

export class OpenWatcher {
  private client: PublicClient;
  private cfg: WatcherConfig;
  private store: OrderStore;
  private onSeen?: (orderId: Hex) => void;

  constructor(cfg: WatcherConfig, store: OrderStore, onSeen?: (orderId: Hex) => void) {
    this.cfg = cfg;
    this.store = store;
    this.onSeen = onSeen;
    const transport = cfg.rpcUrl.startsWith("ws") ? webSocket(cfg.rpcUrl) : http(cfg.rpcUrl);
    this.client = createPublicClient({ transport });
  }

  /** Resume point: max(persisted cursor, configured startBlock). */
  private async resumeFrom(): Promise<bigint> {
    const cursor = BigInt(await this.store.cursorBlock());
    return cursor > this.cfg.startBlock ? cursor + 1n : this.cfg.startBlock;
  }

  /**
   * Backfill from the resume point to the current head, in chunks. Returns the
   * head block scanned to (also persisted as the cursor).
   */
  async backfill(): Promise<bigint> {
    const head = await this.client.getBlockNumber();
    const chunk = this.cfg.chunkSize ?? 2_000n;
    let from = await this.resumeFrom();

    while (from <= head) {
      const to = from + chunk - 1n > head ? head : from + chunk - 1n;
      const logs = await this.client.getLogs({
        address: this.cfg.escrow,
        fromBlock: from,
        toBlock: to,
      });
      await this.ingest(logs);
      await this.store.setCursor(Number(to));
      from = to + 1n;
    }
    return head;
  }

  /**
   * Live-follow new Open events after backfill. Uses viem's watchEvent (polls
   * over http, subscribes over ws). Returns an unwatch function.
   */
  watch(): () => void {
    return this.client.watchContractEvent({
      address: this.cfg.escrow,
      abi: ESCROW_ABI,
      eventName: "Open",
      // onLogs isn't awaited by viem; ingest is async (DB writes) so we catch
      // its rejection here rather than leak an unhandled promise.
      onLogs: (logs) => {
        void this.ingest(logs as unknown as Log[]).catch((e) =>
          console.error("[watch] ingest error:", e instanceof Error ? e.message : e),
        );
      },
    });
  }

  /** Decode + persist a batch of raw logs (only Open events are kept). */
  private async ingest(logs: Log[]): Promise<void> {
    const parsed = parseEventLogs({
      abi: ESCROW_ABI,
      eventName: "Open",
      logs,
    }) as unknown as OpenLog[];

    for (const log of parsed) {
      const orderId = log.args.orderId;
      if (await this.store.has(orderId)) continue; // idempotent
      const serialized = serializeOrder(log.args.order);
      await this.store.insertSeen(orderId, Number(log.blockNumber ?? 0n), serialized);
      this.onSeen?.(orderId);
    }
  }
}

/** Convert a decoded on-chain order to the JSON-safe stored form. */
function serializeOrder(o: DecodedOrder): SerializedOrder {
  return {
    user: o.user,
    nonce: o.nonce.toString(),
    originChainId: o.originChainId.toString(),
    expires: o.expires,
    fillDeadline: o.fillDeadline,
    inputOracle: o.inputOracle,
    inputs: o.inputs.map((p) => [p[0].toString(), p[1].toString()] as [string, string]),
    outputs: o.outputs.map((out) => ({
      oracle: out.oracle,
      settler: out.settler,
      chainId: out.chainId.toString(),
      token: out.token,
      amount: out.amount.toString(),
      recipient: out.recipient,
      callbackData: out.callbackData,
      context: out.context,
    })),
  };
}

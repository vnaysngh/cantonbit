/**
 * FFI shim for the differential Foundry test (EncodingParity.t.sol).
 *
 * Reads a JSON job from argv[2], runs the corresponding encoding function, and
 * prints the resulting hex to stdout (no 0x trimming, no newline noise) so the
 * Solidity test can compare it byte-for-byte against the on-chain library.
 *
 * Usage (invoked by forge ffi):
 *   tsx src/encode-cli.ts '<json>'
 *
 * Job shapes:
 *   { "fn": "fillDescription", solver, orderId, timestamp, output }
 *   { "fn": "fillDescriptionHash", solver, orderId, timestamp, output }
 *   { "fn": "orderId", order, escrow }
 */

import {
  encodeFillDescription,
  fillDescriptionHash,
  orderId,
  type MandateOutput,
  type StandardOrder,
} from "./encoding.js";
import type { Hex } from "viem";

interface OutputJob {
  fn: "fillDescription" | "fillDescriptionHash";
  solver: Hex;
  orderId: Hex;
  timestamp: number;
  output: SerializedOutput;
}
interface OrderIdJob {
  fn: "orderId";
  order: SerializedOrder;
  escrow: Hex;
}

interface SerializedOutput {
  oracle: Hex;
  settler: Hex;
  chainId: string;
  token: Hex;
  amount: string;
  recipient: Hex;
  callbackData: Hex;
  context: Hex;
}
interface SerializedOrder {
  user: Hex;
  nonce: string;
  originChainId: string;
  expires: number;
  fillDeadline: number;
  inputOracle: Hex;
  inputs: [string, string][];
  outputs: SerializedOutput[];
}

function toOutput(o: SerializedOutput): MandateOutput {
  return {
    oracle: o.oracle,
    settler: o.settler,
    chainId: BigInt(o.chainId),
    token: o.token,
    amount: BigInt(o.amount),
    recipient: o.recipient,
    callbackData: o.callbackData,
    context: o.context,
  };
}

function toOrder(o: SerializedOrder): StandardOrder {
  return {
    user: o.user,
    nonce: BigInt(o.nonce),
    originChainId: BigInt(o.originChainId),
    expires: o.expires,
    fillDeadline: o.fillDeadline,
    inputOracle: o.inputOracle,
    inputs: o.inputs.map((p) => [BigInt(p[0]), BigInt(p[1])] as const),
    outputs: o.outputs.map(toOutput),
  };
}

function main(): void {
  const raw = process.argv[2];
  if (!raw) throw new Error("missing JSON job argument");
  const job = JSON.parse(raw) as OutputJob | OrderIdJob;

  let result: Hex;
  switch (job.fn) {
    case "fillDescription":
      result = encodeFillDescription(
        job.solver,
        job.orderId,
        job.timestamp,
        toOutput(job.output),
      );
      break;
    case "fillDescriptionHash":
      result = fillDescriptionHash(
        job.solver,
        job.orderId,
        job.timestamp,
        toOutput(job.output),
      );
      break;
    case "orderId":
      result = orderId(toOrder(job.order), job.escrow);
      break;
    default:
      throw new Error(`unknown fn: ${(job as { fn: string }).fn}`);
  }

  // Print raw hex with no trailing newline so forge ffi parses it directly.
  process.stdout.write(result);
}

main();

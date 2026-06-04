/**
 * Convert a stored SerializedOrder (JSON-safe, bigints as strings) back into the
 * typed StandardOrder / MandateOutput the encoder + viem contract calls expect.
 */

import type { Hex } from "viem";

import type { SerializedOrder } from "./store.js";
import type { MandateOutput, StandardOrder } from "./encoding.js";

export function deserializeOrder(s: SerializedOrder): StandardOrder {
  return {
    user: s.user,
    nonce: BigInt(s.nonce),
    originChainId: BigInt(s.originChainId),
    expires: s.expires,
    fillDeadline: s.fillDeadline,
    inputOracle: s.inputOracle,
    inputs: s.inputs.map((p) => [BigInt(p[0]), BigInt(p[1])] as const),
    outputs: s.outputs.map(deserializeOutput),
  };
}

export function deserializeOutput(o: SerializedOrder["outputs"][number]): MandateOutput {
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

/** The on-chain tuple shape viem wants for finalise()'s `order` arg. */
export function orderToContractTuple(s: StandardOrder): {
  user: Hex;
  nonce: bigint;
  originChainId: bigint;
  expires: number;
  fillDeadline: number;
  inputOracle: Hex;
  inputs: readonly (readonly [bigint, bigint])[];
  outputs: readonly MandateOutput[];
} {
  // The encoding StandardOrder already matches the contract tuple field-for-field.
  return s;
}

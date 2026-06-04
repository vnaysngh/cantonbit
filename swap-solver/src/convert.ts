/**
 * Convert a stored SerializedOrder (JSON-safe, bigints as strings) back into the
 * typed StandardOrder / MandateOutput the encoder + viem contract calls expect.
 */

import type { Hex } from "viem";

import type { SerializedOrder } from "./store.js";
import type { MandateOutput, StandardOrder } from "./encoding.js";

/** Inverse of deserializeOrder: a typed StandardOrder → the JSON-safe form
 *  (bigints as decimal strings) for storage and API responses. */
export function serializeOrder(o: StandardOrder): SerializedOrder {
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

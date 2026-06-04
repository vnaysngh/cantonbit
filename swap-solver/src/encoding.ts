/**
 * OIF payload encoding — byte-exact reproductions of oif-contracts'
 * MandateOutputEncodingLib + StandardOrderType, so the off-chain agent computes
 * the SAME payloadHash / orderId that the on-chain InputSettler computes.
 *
 * These are the single most correctness-critical functions in the solver: a
 * one-byte divergence makes the escrow's `efficientRequireProven` revert
 * `NotProven` and the WBTC never releases. They are pinned by a differential
 * Foundry test (EncodingParity.t.sol) that asserts equality against the real
 * on-chain library for many fixtures.
 *
 * Reference (oif-contracts):
 *   src/libs/MandateOutputEncodingLib.sol :: encodeFillDescription
 *   src/input/types/StandardOrderType.sol :: orderIdentifier
 */

import {
  encodePacked,
  encodeAbiParameters,
  keccak256,
  type Hex,
} from "viem";

/** A MandateOutput, mirroring oif-contracts' struct (identifiers are bytes32). */
export interface MandateOutput {
  oracle: Hex; // bytes32
  settler: Hex; // bytes32
  chainId: bigint; // uint256
  token: Hex; // bytes32
  amount: bigint; // uint256
  recipient: Hex; // bytes32
  callbackData: Hex; // bytes
  context: Hex; // bytes
}

/** A StandardOrder, mirroring oif-contracts' struct. */
export interface StandardOrder {
  user: Hex; // address
  nonce: bigint; // uint256
  originChainId: bigint; // uint256
  expires: number; // uint32
  fillDeadline: number; // uint32
  inputOracle: Hex; // address
  inputs: readonly (readonly [bigint, bigint])[]; // uint256[2][]
  outputs: readonly MandateOutput[];
}

/**
 * encodeFillDescription — abi.encodePacked of:
 *   solver(32) | orderId(32) | timestamp(uint32=4) | token(32) | amount(32)
 *   | recipient(32) | uint16(callbackData.len) | callbackData
 *   | uint16(context.len) | context
 *
 * NB: timestamp is 4 bytes (uint32), and the two uint16 length prefixes are
 * mandatory (collision protection). Packed, not padded.
 */
export function encodeFillDescription(
  solver: Hex,
  orderId: Hex,
  timestamp: number,
  output: MandateOutput,
): Hex {
  const callbackLen = byteLength(output.callbackData);
  const contextLen = byteLength(output.context);
  if (callbackLen > 0xffff) throw new Error("callbackData exceeds uint16");
  if (contextLen > 0xffff) throw new Error("context exceeds uint16");

  return encodePacked(
    [
      "bytes32", // solver
      "bytes32", // orderId
      "uint32", // timestamp
      "bytes32", // token
      "uint256", // amount
      "bytes32", // recipient
      "uint16", // callbackData length
      "bytes", // callbackData
      "uint16", // context length
      "bytes", // context
    ],
    [
      solver,
      orderId,
      timestamp,
      output.token,
      output.amount,
      output.recipient,
      callbackLen,
      output.callbackData,
      contextLen,
      output.context,
    ],
  );
}

/** keccak256(encodeFillDescription(...)) — the dataHash the oracle attests. */
export function fillDescriptionHash(
  solver: Hex,
  orderId: Hex,
  timestamp: number,
  output: MandateOutput,
): Hex {
  return keccak256(encodeFillDescription(solver, orderId, timestamp, output));
}

const MANDATE_OUTPUT_ABI = {
  type: "tuple",
  components: [
    { name: "oracle", type: "bytes32" },
    { name: "settler", type: "bytes32" },
    { name: "chainId", type: "uint256" },
    { name: "token", type: "bytes32" },
    { name: "amount", type: "uint256" },
    { name: "recipient", type: "bytes32" },
    { name: "callbackData", type: "bytes" },
    { name: "context", type: "bytes" },
  ],
} as const;

/**
 * orderIdentifier — keccak256(abi.encodePacked(
 *   block.chainid, address(this)/*escrow*​/, user, nonce, expires, fillDeadline,
 *   inputOracle, keccak256(abi.encodePacked(inputs)), abi.encode(outputs)
 * ))
 *
 * `escrow` is the InputSettlerEscrow address (the contract computing the id).
 * `inputs` (uint256[2][]) are packed; `outputs` are standard ABI-encoded.
 */
export function orderId(order: StandardOrder, escrow: Hex): Hex {
  // keccak256(abi.encodePacked(order.inputs)) where inputs is uint256[2][].
  // encodePacked of a uint256[2][] is each element padded to 32 bytes in order.
  const flatInputs = order.inputs.flatMap((pair) => [pair[0], pair[1]]);
  const inputsTypes = flatInputs.map(() => "uint256" as const);
  const inputsHash = keccak256(
    flatInputs.length === 0
      ? "0x"
      : encodePacked(inputsTypes, flatInputs),
  );

  // abi.encode(order.outputs) — standard (non-packed) ABI encoding of the array.
  const outputsEncoded = encodeAbiParameters(
    [{ type: "tuple[]", components: MANDATE_OUTPUT_ABI.components }],
    [order.outputs as never],
  );

  return keccak256(
    encodePacked(
      [
        "uint256", // block.chainid (== originChainId)
        "address", // escrow (address(this))
        "address", // user
        "uint256", // nonce
        "uint32", // expires
        "uint32", // fillDeadline
        "address", // inputOracle
        "bytes32", // keccak256(packed inputs)
        "bytes", // abi.encode(outputs)
      ],
      [
        order.originChainId,
        escrow,
        order.user,
        order.nonce,
        order.expires,
        order.fillDeadline,
        order.inputOracle,
        inputsHash,
        outputsEncoded,
      ],
    ),
  );
}

/** Byte length of a 0x-prefixed hex string. */
function byteLength(hex: Hex): number {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  return h.length / 2;
}

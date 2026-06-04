/**
 * Permit2 `openFor` helper — the USER side of a swap.
 *
 * The user signs a Permit2 witness over the StandardOrder (one signature, no
 * separate ERC20 approve), then anyone (the frontend or the solver) submits
 * `escrow.openFor(order, user, signature)` to pull the WBTC into the escrow.
 *
 * The witness type mirrors oif-contracts Permit2WitnessType.sol:
 *   Permit2Witness(address user,uint32 expires,address inputOracle,MandateOutput[] outputs)
 * combined with Permit2's PermitBatchTransferFrom over TokenPermissions.
 *
 * This module BUILDS the typed data + (optionally) signs it with a provided
 * account, and assembles the SIGNATURE_TYPE_PERMIT2 (0x00) byte-prefixed
 * signature the escrow's openFor expects.
 */

import {
  concatHex,
  type Account,
  type Address,
  type Hex,
  type TypedDataDomain,
} from "viem";

import type { MandateOutput, StandardOrder } from "./encoding.js";

/** Canonical Permit2 contract (same address on every chain). */
export const PERMIT2_ADDRESS: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

/** SIGNATURE_TYPE_PERMIT2 prefix byte (see InputSettlerEscrow.sol). */
const SIGNATURE_TYPE_PERMIT2: Hex = "0x00";

/** EIP-712 types for the Permit2 witness transfer used by openFor. */
const TYPES = {
  PermitBatchWitnessTransferFrom: [
    { name: "permitted", type: "TokenPermissions[]" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "witness", type: "Permit2Witness" },
  ],
  TokenPermissions: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  Permit2Witness: [
    { name: "user", type: "address" },
    { name: "expires", type: "uint32" },
    { name: "inputOracle", type: "address" },
    { name: "outputs", type: "MandateOutput[]" },
  ],
  MandateOutput: [
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

function permit2Domain(chainId: number): TypedDataDomain {
  return { name: "Permit2", chainId, verifyingContract: PERMIT2_ADDRESS };
}

/** Shape the openFor typed-data message for a StandardOrder. */
export function buildOpenForTypedData(params: {
  order: StandardOrder;
  escrow: Address;
  chainId: number;
}) {
  const { order, escrow, chainId } = params;

  // Permit2 transfers each input token to the escrow; openFor uses
  // deadline == fillDeadline and nonce == order.nonce (see InputSettlerEscrow).
  const permitted = order.inputs.map((inp) => ({
    token: uintToAddress(inp[0]),
    amount: inp[1],
  }));

  const witness = {
    user: order.user as Address,
    expires: order.expires,
    inputOracle: order.inputOracle as Address,
    outputs: order.outputs.map(outputForTypedData),
  };

  return {
    domain: permit2Domain(chainId),
    types: TYPES,
    primaryType: "PermitBatchWitnessTransferFrom" as const,
    message: {
      permitted,
      spender: escrow,
      nonce: order.nonce,
      deadline: BigInt(order.fillDeadline),
      witness,
    },
  };
}

/**
 * Sign the openFor typed data with `account` and return the escrow-ready
 * signature (0x00 prefix + the 65-byte permit2 signature).
 */
export async function signOpenFor(params: {
  account: Account;
  order: StandardOrder;
  escrow: Address;
  chainId: number;
}): Promise<Hex> {
  const typed = buildOpenForTypedData(params);
  if (!params.account.signTypedData) {
    throw new Error("account cannot signTypedData (use a local/private-key account)");
  }
  const sig = await params.account.signTypedData(typed as never);
  return concatHex([SIGNATURE_TYPE_PERMIT2, sig]);
}

/** MandateOutput → the typed-data message form (bigints stay bigint). */
function outputForTypedData(o: MandateOutput) {
  return {
    oracle: o.oracle,
    settler: o.settler,
    chainId: o.chainId,
    token: o.token,
    amount: o.amount,
    recipient: o.recipient,
    callbackData: o.callbackData,
    context: o.context,
  };
}

/** A uint256 input token id → its 20-byte address. */
function uintToAddress(u: bigint): Address {
  const hex = u.toString(16).padStart(40, "0").slice(-40);
  return (`0x${hex}`) as Address;
}

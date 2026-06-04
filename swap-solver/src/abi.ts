/**
 * ABI fragments for the OIF InputSettlerEscrow + our OranjAttestorOracle.
 * Hand-written (only the parts the solver uses) and kept in sync with the
 * compiled artifacts in ../contracts/out. The MandateOutput / StandardOrder
 * tuple shapes here MUST match the on-chain structs exactly — verified against
 * out/InputSettlerEscrow.sol/InputSettlerEscrow.json.
 */

const MANDATE_OUTPUT_COMPONENTS = [
  { name: "oracle", type: "bytes32" },
  { name: "settler", type: "bytes32" },
  { name: "chainId", type: "uint256" },
  { name: "token", type: "bytes32" },
  { name: "amount", type: "uint256" },
  { name: "recipient", type: "bytes32" },
  { name: "callbackData", type: "bytes" },
  { name: "context", type: "bytes" },
] as const;

const STANDARD_ORDER_COMPONENTS = [
  { name: "user", type: "address" },
  { name: "nonce", type: "uint256" },
  { name: "originChainId", type: "uint256" },
  { name: "expires", type: "uint32" },
  { name: "fillDeadline", type: "uint32" },
  { name: "inputOracle", type: "address" },
  { name: "inputs", type: "uint256[2][]" },
  { name: "outputs", type: "tuple[]", components: MANDATE_OUTPUT_COMPONENTS },
] as const;

const SOLVE_PARAMS_COMPONENTS = [
  { name: "timestamp", type: "uint32" },
  { name: "solver", type: "bytes32" },
] as const;

/** Escrow ABI — only the fragments the solver reads/calls. */
export const ESCROW_ABI = [
  {
    type: "event",
    name: "Open",
    anonymous: false,
    inputs: [
      { name: "orderId", type: "bytes32", indexed: true },
      { name: "order", type: "tuple", indexed: false, components: STANDARD_ORDER_COMPONENTS },
    ],
  },
  {
    type: "event",
    name: "Finalised",
    anonymous: false,
    inputs: [
      { name: "orderId", type: "bytes32", indexed: true },
      { name: "solver", type: "bytes32", indexed: false },
      { name: "destination", type: "bytes32", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Refunded",
    anonymous: false,
    inputs: [{ name: "orderId", type: "bytes32", indexed: true }],
  },
  {
    type: "function",
    name: "open",
    stateMutability: "nonpayable",
    inputs: [{ name: "order", type: "tuple", components: STANDARD_ORDER_COMPONENTS }],
    outputs: [],
  },
  {
    type: "function",
    name: "openFor",
    stateMutability: "nonpayable",
    inputs: [
      { name: "order", type: "tuple", components: STANDARD_ORDER_COMPONENTS },
      { name: "sponsor", type: "address" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "orderStatus",
    stateMutability: "view",
    inputs: [{ name: "orderId", type: "bytes32" }],
    // enum OrderStatus { None, Deposited, Claimed, Refunded }
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "orderIdentifier",
    stateMutability: "view",
    inputs: [{ name: "order", type: "tuple", components: STANDARD_ORDER_COMPONENTS }],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "finalise",
    stateMutability: "nonpayable",
    inputs: [
      { name: "order", type: "tuple", components: STANDARD_ORDER_COMPONENTS },
      { name: "solveParams", type: "tuple[]", components: SOLVE_PARAMS_COMPONENTS },
      { name: "destination", type: "bytes32" },
      { name: "call", type: "bytes" },
    ],
    outputs: [],
  },
  {
    // refund(order) — after order.expires, returns the locked inputs to order.user.
    // The user safety valve when a solver never delivers / never finalises.
    type: "function",
    name: "refund",
    stateMutability: "nonpayable",
    inputs: [{ name: "order", type: "tuple", components: STANDARD_ORDER_COMPONENTS }],
    outputs: [],
  },
] as const;

/** Our oracle ABI — the attest entrypoints + read. */
export const ORACLE_ABI = [
  {
    type: "function",
    name: "attest",
    stateMutability: "nonpayable",
    inputs: [
      { name: "remoteChainId", type: "uint256" },
      { name: "remoteOracle", type: "bytes32" },
      { name: "application", type: "bytes32" },
      { name: "dataHash", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "isProven",
    stateMutability: "view",
    inputs: [
      { name: "remoteChainId", type: "uint256" },
      { name: "remoteOracle", type: "bytes32" },
      { name: "application", type: "bytes32" },
      { name: "dataHash", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "attestor",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

/** Mirrors the on-chain enum OrderStatus. */
export const ORDER_STATUS = {
  None: 0,
  Deposited: 1,
  Claimed: 2,
  Refunded: 3,
} as const;

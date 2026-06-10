/**
 * ABI for the new HTLCEscrow (contracts/src/HTLCEscrow.sol) — the trustless EVM
 * leg. Only the fragments the solver/orchestrator reads or calls.
 *
 * Keyed by hashlock (bytes32 hashValue); claim takes the raw preimage bytes.
 * Matches Cancore's verified HTLC ABI (lock / claim / retake) + our hardening.
 */
export const HTLC_ESCROW_ABI = [
  {
    type: "function",
    name: "lock",
    stateMutability: "nonpayable",
    inputs: [
      { name: "hashValue", type: "bytes32" },
      { name: "unlockTime", type: "uint64" },
      { name: "amount", type: "uint256" },
      { name: "tokenAddress", type: "address" },
      { name: "receiverAddress", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [{ name: "preImage", type: "bytes" }],
    outputs: [],
  },
  {
    type: "function",
    name: "retake",
    stateMutability: "nonpayable",
    inputs: [{ name: "hashValue", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "locks",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [
      { name: "unlockTime", type: "uint64" },
      { name: "amount", type: "uint256" },
      { name: "tokenAddress", type: "address" },
      { name: "senderAddress", type: "address" },
      { name: "receiverAddress", type: "address" },
    ],
  },
  {
    type: "event",
    name: "Locked",
    inputs: [
      { name: "hashValue", type: "bytes32", indexed: true },
      { name: "when", type: "uint256", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
      { name: "tokenAddress", type: "address", indexed: false },
      { name: "senderAddress", type: "address", indexed: false },
      { name: "receiverAddress", type: "address", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Claimed",
    inputs: [
      { name: "preImage", type: "bytes", indexed: false },
      { name: "hashValue", type: "bytes32", indexed: true },
      { name: "when", type: "uint256", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
      { name: "tokenAddress", type: "address", indexed: false },
      { name: "senderAddress", type: "address", indexed: false },
      { name: "receiverAddress", type: "address", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Retaken",
    inputs: [
      { name: "hashValue", type: "bytes32", indexed: true },
      { name: "when", type: "uint256", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
      { name: "tokenAddress", type: "address", indexed: false },
      { name: "senderAddress", type: "address", indexed: false },
      { name: "receiverAddress", type: "address", indexed: false },
    ],
  },
] as const;

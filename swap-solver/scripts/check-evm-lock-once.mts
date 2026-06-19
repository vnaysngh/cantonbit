#!/usr/bin/env npx tsx
import { createPublicClient, http, decodeFunctionResult, encodeFunctionData } from "viem";
import { baseSepolia } from "viem/chains";

const hashLock = process.argv[2];
const user = process.argv[3];
const preimage = process.argv[4];

if (!hashLock || !user) {
  console.error("Usage: check-evm-lock-once.mts <hashLock> <userEvm> [preimage]");
  process.exit(1);
}

const ESCROW = "0x1b19a764ab35db1833ae2137544dd84ba5bf8cf1" as const;
const locksAbi = [
  {
    type: "function",
    name: "locks",
    stateMutability: "view",
    inputs: [{ name: "hashValue", type: "bytes32" }],
    outputs: [
      { type: "uint256" },
      { type: "uint256" },
      { type: "address" },
      { type: "address" },
      { type: "address" }
    ]
  }
] as const;
const claimAbi = [
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [{ name: "preImage", type: "bytes" }],
    outputs: []
  }
] as const;

async function main() {
  const pub = createPublicClient({
    chain: baseSepolia,
    transport: http(process.env.ORIGIN_RPC_URL ?? "https://sepolia.base.org")
  });
  const raw = await pub.call({
    to: ESCROW,
    data: encodeFunctionData({
      abi: locksAbi,
      functionName: "locks",
      args: [hashLock as `0x${string}`]
    })
  });
  const [amount, unlock, sender, receiver, token] = decodeFunctionResult({
    abi: locksAbi,
    functionName: "locks",
    data: raw.data
  });
  const now = Math.floor(Date.now() / 1000);
  console.log(
    JSON.stringify(
      {
        amountSats: amount.toString(),
        unlockIso: new Date(Number(unlock) * 1000).toISOString(),
        sender,
        receiver,
        user,
        receiverOk: receiver.toLowerCase() === user.toLowerCase(),
        active: amount > 0n && Number(unlock) > now
      },
      null,
      2
    )
  );
  if (preimage) {
    try {
      const gas = await pub.estimateGas({
        account: user as `0x${string}`,
        to: ESCROW,
        data: encodeFunctionData({
          abi: claimAbi,
          functionName: "claim",
          args: [preimage as `0x${string}`]
        })
      });
      console.log("estimateGas OK:", gas.toString());
    } catch (e) {
      console.log("estimateGas FAIL:", e instanceof Error ? e.message : e);
    }
  }
}

main();

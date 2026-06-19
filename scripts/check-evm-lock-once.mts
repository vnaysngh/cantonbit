#!/usr/bin/env npx tsx
/** Read HTLCEscrow lock + simulate claim gas for a reverse swap. */
import { createPublicClient, http, decodeFunctionResult, encodeFunctionData } from "viem";
import { baseSepolia } from "viem/chains";

const hashLock = process.argv[2];
const user = process.argv[3];
const preimage = process.argv[4]; // optional — if omitted, only read lock

if (!hashLock || !user) {
  console.error("Usage: check-evm-lock-once.mts <hashLock> <userEvmAddress> [preimageHex]");
  process.exit(1);
}

const ESCROW = (process.env.NEXT_PUBLIC_HTLC_ESCROW ??
  "0x1b19a764ab35db1833ae2137544dd84ba5bf8cf1") as `0x${string}`;

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

  const lockData = encodeFunctionData({
    abi: locksAbi,
    functionName: "locks",
    args: [hashLock as `0x${string}`]
  });
  const raw = await pub.call({ to: ESCROW, data: lockData });
  const [amount, unlock, sender, receiver, token] = decodeFunctionResult({
    abi: locksAbi,
    functionName: "locks",
    data: raw.data
  });

  const now = Math.floor(Date.now() / 1000);
  console.log("\n=== EVM lock ===");
  console.log(
    JSON.stringify(
      {
        hashLock,
        amountSats: amount.toString(),
        unlockTs: unlock.toString(),
        unlockIso: new Date(Number(unlock) * 1000).toISOString(),
        sender,
        receiver,
        token,
        userEvm: user,
        receiverMatchesUser:
          receiver.toLowerCase() === user.toLowerCase(),
        lockActive: amount > 0n && unlock > BigInt(now),
        expired: Number(unlock) <= now
      },
      null,
      2
    )
  );

  if (preimage) {
    const claimData = encodeFunctionData({
      abi: claimAbi,
      functionName: "claim",
      args: [preimage as `0x${string}`]
    });
    try {
      const gas = await pub.estimateGas({
        account: user as `0x${string}`,
        to: ESCROW,
        data: claimData
      });
      console.log("\n=== claim estimateGas ===");
      console.log("gas:", gas.toString(), "OK");
    } catch (e) {
      console.log("\n=== claim estimateGas FAILED (MetaMask would show likely fail) ===");
      console.log(e instanceof Error ? e.message : String(e));
    }
  } else {
    console.log("\n(pass preimage as 3rd arg to simulate claim gas)");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

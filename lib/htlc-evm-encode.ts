/**
 * Minimal ABI encoders for the HTLCEscrow calls the FRONTEND submits via MetaMask
 * (useEvmWallet.sendTransaction takes raw {to,data}). No viem in the app, so we
 * encode by hand — function selector (keccak of the signature) + ABI-packed args.
 *
 * Functions:
 *   lock(bytes32 hashValue, uint64 unlockTime, uint256 amount, address token, address receiver)
 *   claim(bytes preImage)
 *   retake(bytes32 hashValue)
 *   approve(address spender, uint256 amount)   [ERC20]
 */
import { keccak_256 } from "@noble/hashes/sha3";

function selector(sig: string): string {
  const bytes = new TextEncoder().encode(sig);
  const h = keccak_256(bytes);
  return "0x" + Array.from(h.slice(0, 4)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const hex = (s: string) => (s.startsWith("0x") ? s.slice(2) : s);
const pad32 = (h: string) => h.replace(/^0x/, "").padStart(64, "0");
const padAddr = (a: string) => hex(a).toLowerCase().padStart(64, "0");
const uintTo32 = (v: bigint | number) => BigInt(v).toString(16).padStart(64, "0");

/** approve(spender, amount) */
export function encodeApprove(spender: string, amount: bigint): string {
  return selector("approve(address,uint256)") + padAddr(spender) + uintTo32(amount);
}

/** lock(hashValue, unlockTime, amount, token, receiver) */
export function encodeLock(p: {
  hashValue: string; unlockTime: number; amount: bigint; token: string; receiver: string;
}): string {
  return (
    selector("lock(bytes32,uint64,uint256,address,address)") +
    pad32(p.hashValue) +
    uintTo32(p.unlockTime) +
    uintTo32(p.amount) +
    padAddr(p.token) +
    padAddr(p.receiver)
  );
}

/** claim(bytes preImage) — dynamic bytes: offset(32) | length(32) | data(padded). */
export function encodeClaim(preImage: string): string {
  const data = hex(preImage).toLowerCase();
  const byteLen = data.length / 2;
  const offset = uintTo32(32);
  const length = uintTo32(byteLen);
  const padded = data.padEnd(Math.ceil(byteLen / 32) * 64, "0");
  return selector("claim(bytes)") + offset + length + padded;
}

/** retake(bytes32 hashValue) */
export function encodeRetake(hashValue: string): string {
  return selector("retake(bytes32)") + pad32(hashValue);
}

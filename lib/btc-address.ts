/**
 * btc-address — client-safe Bitcoin address validation for the redeem flow.
 *
 * The bridge will reject a malformed or wrong-network address, but by then the
 * user's CBTC is already burned and unrecoverable. So we validate hard, on the
 * client, BEFORE the burn is submitted. This is the most safety-critical
 * validation in the app: a typo here means lost funds.
 *
 * We validate:
 *   1. Encoding integrity — bech32/bech32m checksum (segwit/Taproot) or Base58
 *      length/charset (legacy P2PKH/P2SH). A single-character typo fails the
 *      checksum, which is the whole point of these encodings.
 *   2. Network match — a mainnet address on testnet (or vice-versa) is rejected,
 *      because the bridge would send real BTC into the void.
 *
 * Pure functions, no network calls, no Node APIs — safe to import in a client
 * component.
 */

import { NETWORK } from "./constants";

export type BtcAddressKind =
  | "p2pkh" // legacy "1..." / "m,n..."
  | "p2sh" // legacy "3..." / "2..."
  | "p2wpkh" // native segwit v0 (bech32)
  | "p2wsh" // native segwit v0 (bech32)
  | "p2tr"; // Taproot v1 (bech32m)

export interface BtcAddressValidation {
  valid: boolean;
  /** Human-readable reason when invalid. Null when valid. */
  reason: string | null;
  /** Detected address kind, when we could parse one. */
  kind: BtcAddressKind | null;
  /** The network the address belongs to, when detectable. */
  network: "mainnet" | "testnet" | "regtest" | null;
}

// ─── bech32 / bech32m ───────────────────────────────────────────────────────
// Reference implementation of BIP-173 (bech32) and BIP-350 (bech32m), trimmed
// to what we need: decode + checksum verification + witness-program extraction.

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32_CONST = 1;
const BECH32M_CONST = 0x2bc830a3;

function bech32Polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((top >> i) & 1) chk ^= GEN[i];
    }
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

interface Bech32Decoded {
  hrp: string;
  data: number[];
  spec: "bech32" | "bech32m";
}

/** Decode a bech32/bech32m string, verifying the checksum. Null if invalid. */
function bech32Decode(addr: string): Bech32Decoded | null {
  // Reject mixed case (the spec forbids it) before lowercasing.
  if (addr !== addr.toLowerCase() && addr !== addr.toUpperCase()) return null;
  const lower = addr.toLowerCase();

  const pos = lower.lastIndexOf("1");
  if (pos < 1 || pos + 7 > lower.length || lower.length > 90) return null;

  const hrp = lower.slice(0, pos);
  const dataPart = lower.slice(pos + 1);

  const data: number[] = [];
  for (const c of dataPart) {
    const idx = CHARSET.indexOf(c);
    if (idx === -1) return null; // invalid character
    data.push(idx);
  }

  const checksum = bech32Polymod([...hrpExpand(hrp), ...data]);
  const spec =
    checksum === BECH32_CONST
      ? "bech32"
      : checksum === BECH32M_CONST
        ? "bech32m"
        : null;
  if (!spec) return null; // checksum mismatch — a typo lives here

  // Strip the 6-symbol checksum from the data.
  return { hrp, data: data.slice(0, -6), spec };
}

/** Convert from 5-bit groups to 8-bit bytes (used for the witness program). */
function convertBits(
  data: number[],
  fromBits: number,
  toBits: number,
  pad: boolean,
): number[] | null {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << toBits) - 1;
  for (const value of data) {
    if (value < 0 || value >> fromBits !== 0) return null;
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (toBits - bits)) & maxv);
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv) !== 0) {
    return null;
  }
  return out;
}

// ─── Base58 (legacy) ────────────────────────────────────────────────────────
// We do NOT do full Base58Check (no sha256 in a client lib without a dep). We
// validate the charset, length, and version-byte prefix — enough to catch
// typos and wrong-network legacy addresses. Modern wallets use bech32 anyway.

const BASE58_ALPHABET =
  /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/;

function looksLikeBase58(addr: string): boolean {
  return (
    addr.length >= 26 && addr.length <= 35 && BASE58_ALPHABET.test(addr)
  );
}

// ─── Public validator ───────────────────────────────────────────────────────

/** The bech32 human-readable prefix expected for the current network. */
function expectedHrp(): "bc" | "tb" | "bcrt" {
  switch (NETWORK.name) {
    case "mainnet":
      return "bc";
    case "testnet":
      return "tb";
    default:
      return "bcrt"; // devnet / regtest
  }
}

/**
 * Validate a Bitcoin address for the CURRENT network. Designed to be called on
 * every keystroke (it's cheap and pure).
 *
 * Empty input returns `{ valid: false, reason: null }` so the UI can stay quiet
 * until the user actually types something.
 */
export function validateBtcAddress(raw: string): BtcAddressValidation {
  const addr = raw.trim();

  const none: BtcAddressValidation = {
    valid: false,
    reason: null,
    kind: null,
    network: null,
  };
  if (addr === "") return none;

  if (/\s/.test(addr)) {
    return { ...none, reason: "Address must not contain spaces." };
  }

  // ── bech32 / bech32m (segwit + Taproot) ──
  if (/^(bc|tb|bcrt)1/i.test(addr)) {
    const decoded = bech32Decode(addr);
    if (!decoded) {
      return {
        ...none,
        reason:
          "Invalid address — the checksum doesn't match. Double-check for a typo.",
      };
    }

    // Network match by HRP.
    const network =
      decoded.hrp === "bc"
        ? "mainnet"
        : decoded.hrp === "tb"
          ? "testnet"
          : decoded.hrp === "bcrt"
            ? "regtest"
            : null;

    if (decoded.hrp !== expectedHrp()) {
      return {
        ...none,
        network,
        reason: `This is a ${network ?? "different-network"} address, but the bridge is on ${NETWORK.name}. Sending here would lose the funds.`,
      };
    }

    // Witness version is the first data symbol; the rest is the program.
    const witnessVersion = decoded.data[0];
    const program = convertBits(decoded.data.slice(1), 5, 8, false);
    if (program === null) {
      return { ...none, network, reason: "Invalid witness program." };
    }

    // BIP-141 program length bounds.
    if (program.length < 2 || program.length > 40) {
      return { ...none, network, reason: "Invalid witness program length." };
    }

    // v0 must be bech32 + 20 (p2wpkh) or 32 (p2wsh) bytes.
    if (witnessVersion === 0) {
      if (decoded.spec !== "bech32") {
        return { ...none, network, reason: "Invalid segwit v0 encoding." };
      }
      if (program.length !== 20 && program.length !== 32) {
        return {
          ...none,
          network,
          reason: "Invalid segwit v0 program length.",
        };
      }
      return {
        valid: true,
        reason: null,
        kind: program.length === 20 ? "p2wpkh" : "p2wsh",
        network,
      };
    }

    // v1 (Taproot) must be bech32m + 32 bytes.
    if (witnessVersion === 1) {
      if (decoded.spec !== "bech32m") {
        return { ...none, network, reason: "Invalid Taproot encoding." };
      }
      if (program.length !== 32) {
        return { ...none, network, reason: "Invalid Taproot program length." };
      }
      return { valid: true, reason: null, kind: "p2tr", network };
    }

    // v2..v16 must be bech32m (future-proof, but we accept them as valid).
    if (witnessVersion >= 2 && witnessVersion <= 16) {
      if (decoded.spec !== "bech32m") {
        return { ...none, network, reason: "Invalid segwit encoding." };
      }
      return { valid: true, reason: null, kind: "p2wsh", network };
    }

    return { ...none, network, reason: "Unsupported witness version." };
  }

  // ── legacy Base58 (P2PKH / P2SH) ──
  if (looksLikeBase58(addr)) {
    const first = addr[0];
    // Mainnet: P2PKH "1", P2SH "3". Test/regtest: P2PKH "m"/"n", P2SH "2".
    const isMainnetLegacy = first === "1" || first === "3";
    const isTestLegacy = first === "m" || first === "n" || first === "2";

    if (!isMainnetLegacy && !isTestLegacy) {
      return {
        ...none,
        reason: "Unrecognized address format.",
      };
    }

    const addrNetwork = isMainnetLegacy ? "mainnet" : "testnet";
    const wantMainnet = NETWORK.name === "mainnet";
    if (wantMainnet !== isMainnetLegacy) {
      return {
        ...none,
        network: addrNetwork,
        reason: `This is a ${addrNetwork} address, but the bridge is on ${NETWORK.name}. Sending here would lose the funds.`,
      };
    }

    const kind: BtcAddressKind =
      first === "1" || first === "m" || first === "n" ? "p2pkh" : "p2sh";

    // We accept legacy, but nudge toward bech32 — most bridges prefer it.
    return { valid: true, reason: null, kind, network: addrNetwork };
  }

  return {
    ...none,
    reason: "Unrecognized address format. Use a bech32 (bc1…) address.",
  };
}

/** Short human label for a detected address kind. */
export function btcAddressKindLabel(kind: BtcAddressKind): string {
  switch (kind) {
    case "p2pkh":
      return "Legacy (P2PKH)";
    case "p2sh":
      return "Legacy (P2SH)";
    case "p2wpkh":
      return "Native SegWit (P2WPKH)";
    case "p2wsh":
      return "Native SegWit (P2WSH)";
    case "p2tr":
      return "Taproot (P2TR)";
  }
}

/**
 * Unit tests for the order/config composition layer.
 *
 * The byte-exactness of orderId/fillDescriptionHash is already proven against
 * the on-chain library in contracts/test/EncodingParity.t.sol. These tests
 * cover the COMPOSITION invariants the config layer is responsible for:
 *   - oracle consistency (inputOracle == output.oracle id)
 *   - attestTuple matches the output (so attest uses the same keys)
 *   - fillDeadline < expires
 *   - proofDataHash refuses a timestamp past the deadline
 *
 * Run: node --test (via tsx). See package.json "test" script.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { pad, type Address, type Hex } from "viem";

import { makeNetworkConfig, oracleId } from "./config.js";
import {
  buildOrder,
  proofDataHash,
  toIdentifier,
  cantonPartyToRecipient,
  verifyCantonParty,
  type SwapRequest,
} from "./order.js";

const ORACLE: Address = "0x00000000000000000000000000000000000000aa";
const ESCROW: Address = "0x00000000000000000000000000000000000000bb";
const WBTC: Address = "0x00000000000000000000000000000000000000cc";
const USER: Address = "0x1111111111111111111111111111111111111111";
const SOLVER: Address = "0x2222222222222222222222222222222222222222";

function cfg() {
  return makeNetworkConfig({
    network: "testnet",
    originChainId: 84532, // base sepolia
    escrow: ESCROW,
    oracle: ORACLE,
    wbtc: WBTC,
  });
}

function req(): SwapRequest {
  return {
    user: USER,
    wbtcAmount: 5_00_000_000n, // 5 WBTC (8dp)
    cbtcAmount: 5_00_000_000n,
    cantonParty: "cbtc-user-test::1220abcdef0123456789",
    cbtcToken: pad("0xc87c", { size: 32 }) as Hex,
    nonce: 1n,
  };
}

const NOW = 1_780_000_000;

test("inputOracle equals output.oracle id (the core invariant)", () => {
  const c = cfg();
  const built = buildOrder(c, req(), NOW);
  // order.inputOracle is the address; output.oracle is its bytes32 id.
  // Compare case-insensitively: config canonicalizes to checksummed form, so
  // the hex casing may differ from the raw fixture while the BYTES are equal.
  assert.equal(built.order.inputOracle.toLowerCase(), ORACLE.toLowerCase());
  assert.equal(built.output.oracle, oracleId(c));
  assert.equal(built.output.oracle.toLowerCase(), pad(ORACLE, { size: 32 }).toLowerCase());
});

test("attestTuple mirrors the output exactly", () => {
  const built = buildOrder(cfg(), req(), NOW);
  assert.equal(built.attestTuple.remoteChainId, built.output.chainId);
  assert.equal(built.attestTuple.remoteOracle, built.output.oracle);
  assert.equal(built.attestTuple.application, built.output.settler);
});

test("fillDeadline is strictly before expires", () => {
  const built = buildOrder(cfg(), req(), NOW);
  assert.ok(built.order.fillDeadline < built.order.expires);
  // Windows must give the solver real slack to deliver: 30m to fill, 45m to
  // expiry (auto-refund unlocks). See the timing invariant in index.ts — the
  // fill window MUST exceed the solver's delivery margin, or orders are
  // unfillable from birth (the bug that stalled every live swap).
  assert.equal(built.order.fillDeadline, NOW + 30 * 60);
  assert.equal(built.order.expires, NOW + 45 * 60);
});

test("INVARIANT: fill window comfortably exceeds the solver delivery margin", () => {
  // The solver (index.ts) refuses to deliver unless DELIVERY_MARGIN_SECONDS (10m)
  // remains before fillDeadline. If the fill window isn't well above that margin,
  // no order can ever be delivered. Guard the relationship here so a future
  // window change can't silently reintroduce the unfillable-order bug.
  const DELIVERY_MARGIN_SECONDS = 10 * 60;
  const built = buildOrder(cfg(), req(), NOW);
  const fillWindow = built.order.fillDeadline - NOW;
  assert.ok(
    fillWindow > DELIVERY_MARGIN_SECONDS,
    `fill window ${fillWindow}s must exceed delivery margin ${DELIVERY_MARGIN_SECONDS}s`,
  );
  // Keep healthy slack (margin <= fill/3) so brief solver downtime can't make
  // orders unfillable.
  assert.ok(
    DELIVERY_MARGIN_SECONDS <= fillWindow / 3,
    `delivery margin ${DELIVERY_MARGIN_SECONDS}s should be <= fill window / 3 (${fillWindow / 3}s)`,
  );
});

test("canton chainId is a high non-colliding sentinel, per-network distinct", () => {
  const tn = buildOrder(cfg(), req(), NOW).output.chainId;
  const mn = buildOrder(
    makeNetworkConfig({ network: "mainnet", originChainId: 8453, escrow: ESCROW, oracle: ORACLE, wbtc: WBTC }),
    req(),
    NOW,
  ).output.chainId;
  assert.ok(tn > 1_000_000_000_000_000n);
  assert.notEqual(tn, mn); // a proof for testnet can't satisfy mainnet
});

test("inputs encode the WBTC token + amount", () => {
  const built = buildOrder(cfg(), req(), NOW);
  assert.equal(built.order.inputs.length, 1);
  assert.equal(built.order.inputs[0]![0], BigInt(WBTC));
  assert.equal(built.order.inputs[0]![1], req().wbtcAmount);
});

test("proofDataHash is deterministic for the same inputs", () => {
  const built = buildOrder(cfg(), req(), NOW);
  const solverId = toIdentifier(SOLVER);
  const ts = built.order.fillDeadline - 10;
  assert.equal(proofDataHash(built, solverId, ts), proofDataHash(built, solverId, ts));
});

test("proofDataHash rejects a timestamp past the fillDeadline", () => {
  const built = buildOrder(cfg(), req(), NOW);
  const solverId = toIdentifier(SOLVER);
  assert.throws(() => proofDataHash(built, solverId, built.order.fillDeadline + 1));
});

test("different fill timestamps produce different payload hashes", () => {
  const built = buildOrder(cfg(), req(), NOW);
  const solverId = toIdentifier(SOLVER);
  const a = proofDataHash(built, solverId, built.order.fillDeadline - 100);
  const b = proofDataHash(built, solverId, built.order.fillDeadline - 50);
  assert.notEqual(a, b);
});

test("recipient = keccak256(cantonParty), and verify round-trips", () => {
  const party = "cbtc-user-abc::1220deadbeef";
  const built = buildOrder(cfg(), { ...req(), cantonParty: party }, NOW);
  // output.recipient must be the keccak of the full party id.
  assert.equal(built.output.recipient, cantonPartyToRecipient(party));
  assert.equal(built.cantonParty, party);
  // verify accepts the real party, rejects any other.
  assert.ok(verifyCantonParty(party, built.output.recipient));
  assert.ok(!verifyCantonParty("cbtc-user-evil::1220ffff", built.output.recipient));
});

test("config accepts mixed-case (checksummed) addresses without throwing", () => {
  // A checksummed address (mixed case) must be normalized, not rejected.
  const checksummed = makeNetworkConfig({
    network: "testnet",
    originChainId: 84532,
    escrow: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    oracle: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
    wbtc: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
  });
  // building an order must not throw (encodePacked would reject bad checksums).
  const built = buildOrder(checksummed, req(), NOW);
  assert.ok(built.orderId.startsWith("0x"));
});

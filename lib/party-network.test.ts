import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isPartyOnCurrentNetwork,
  partyParticipantSuffix
} from "./party-network";

test("partyParticipantSuffix parses Canton party id", () => {
  assert.equal(
    partyParticipantSuffix(
      "warpx-devnet-1::1220231c1885f289f90e0d08b448579c31a655b5826802c6d885258a27371039fba9"
    ),
    "1220231c1885f289f90e0d08b448579c31a655b5826802c6d885258a27371039fba9"
  );
});

test("isPartyOnCurrentNetwork matches active NETWORK.warpxPartyId suffix", () => {
  const devnetParty =
    "party-de08bc18::1220231c1885f289f90e0d08b448579c31a655b5826802c6d885258a27371039fba9";
  const mainnetParty =
    "oranj-user-777f5c935aa3::1220517bfd86ef5732610705a35b7b2d56e36112550d6a2b778971dbd099a3d36e99";

  // Test env defaults to devnet per lib/constants NEXT_PUBLIC_NETWORK.
  assert.equal(isPartyOnCurrentNetwork(devnetParty), true);
  assert.equal(isPartyOnCurrentNetwork(mainnetParty), false);
});

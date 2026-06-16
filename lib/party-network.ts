import { NETWORK } from "./constants";

/** Participant suffix from a Canton party id (`hint::suffix`). */
export function partyParticipantSuffix(party: string): string | null {
  const sep = party.indexOf("::");
  if (sep < 0) return null;
  return party.slice(sep + 2);
}

/** Expected hosting participant suffix for the active NETWORK stack. */
export function expectedParticipantSuffix(): string | null {
  const warpx = NETWORK.warpxPartyId?.trim();
  if (!warpx) return null;
  return partyParticipantSuffix(warpx);
}

/** True when the party is hosted on the current stack's WarpX participant. */
export function isPartyOnCurrentNetwork(party: string): boolean {
  const expected = expectedParticipantSuffix();
  const actual = partyParticipantSuffix(party);
  if (!expected || !actual) return true;
  return actual === expected;
}

export function formatPartyNetworkMismatch(party: string): string {
  const expected = expectedParticipantSuffix();
  const actual = partyParticipantSuffix(party);
  return (
    `party ${party.slice(0, 24)}… is on participant …${actual?.slice(-8) ?? "?"} ` +
    `but ${NETWORK.name} expects …${expected?.slice(-8) ?? "?"} — reprovision or use ${NETWORK.name === "mainnet" ? "dev:devnet" : "dev:mainnet"}`
  );
}

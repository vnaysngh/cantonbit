/** Truncate Canton party id for display (first 8…last 8 per project convention). */
export function truncatePartyId(party: string): string {
  if (party.length <= 20) return party;
  return `${party.slice(0, 8)}…${party.slice(-8)}`;
}

/** Truncate EVM address for display (first 8…last 8). */
export function truncateEvmAddress(address: string): string {
  if (address.length <= 20) return address;
  return `${address.slice(0, 8)}…${address.slice(-8)}`;
}

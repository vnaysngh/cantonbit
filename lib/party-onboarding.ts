/**
 * PARTICIPANT-MANAGED onboarding (R2) — host a user's Canton party on our warpx node.
 *
 * For email/password users (the proven trustless on-ledger swap path). On signup we:
 *   1. allocate a party on warpx (isLocal=true, on our participant where our DAR is vetted)
 *   2. grant the backend's ledger user CanActAs over it (so the backend signs the
 *      HtlcLock.Claim for them — the oranjswap-proven path)
 *   3. set up the CBTC TransferPreapproval (auto-accept) so CBTC delivery lands
 *
 * The party id is then stored in party_mappings against the user's Supabase row.
 */
import "server-only";

import { getLedgerJwt } from "./auth";
import { NETWORK } from "./constants";

const TAG = "[party-onboarding]";

function ledger(path: string): string {
  return `${NETWORK.ledgerHost}${path}`;
}

/** Decode the JWT's subject (the ledger user id the m2m token maps to). */
async function ledgerUserId(jwt: string): Promise<string> {
  const payload = JSON.parse(
    Buffer.from(jwt.split(".")[1], "base64").toString()
  );
  return String(payload.sub);
}

/** STEP 1 — allocate a fresh party on warpx (local to our participant). */
export async function allocateUserParty(hint?: string): Promise<string> {
  const jwt = await getLedgerJwt();
  const body: Record<string, unknown> = {};
  if (hint) body.partyIdHint = hint;
  const r = await fetch(ledger("/v2/parties"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`
    },
    body: JSON.stringify(body)
  });
  if (!r.ok)
    throw new Error(`allocate party failed (${r.status}): ${await r.text()}`);
  const j = (await r.json()) as { partyDetails?: { party?: string } };
  const party = j.partyDetails?.party;
  if (!party) throw new Error("allocate party: no party in response");
  console.log(`${TAG} allocated party ${party.slice(0, 28)}…`);
  return party;
}

/** STEP 2 — grant the backend's ledger user CanActAs over the party (idempotent). */
export async function grantCanActAs(party: string): Promise<void> {
  const jwt = await getLedgerJwt();
  const userId = await ledgerUserId(jwt);
  const r = await fetch(
    ledger(`/v2/users/${encodeURIComponent(userId)}/rights`),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`
      },
      body: JSON.stringify({
        userId,
        rights: [{ kind: { CanActAs: { value: { party } } } }]
      })
    }
  );
  if (!r.ok) {
    const text = await r.text();
    // already-granted is fine (idempotent)
    if (!/already|exists/i.test(text))
      throw new Error(`grant CanActAs failed (${r.status}): ${text}`);
  }
  console.log(`${TAG} backend granted CanActAs over ${party.slice(0, 28)}…`);
}

/**
 * Onboard a user party: allocate + grant CanActAs. (Preapproval/EnableCC handled
 * separately so each step can be verified independently.) Returns the party id.
 */
export async function onboardParticipantManagedParty(
  hint?: string
): Promise<{ party: string }> {
  const party = await allocateUserParty(hint);
  await grantCanActAs(party);
  return { party };
}

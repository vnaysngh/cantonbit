import "server-only";

import { fetchUpdateEventsById } from "./canton-swap-leg-verify";
import { getDsoPartyId } from "./cc-registry";
import { ccNetworkFeePaidInEvents } from "./network-fee-verify-logic";

/** Verify a Loop wallet submit actually paid the CC network fee. */
export async function verifyLoopNetworkFeeSettlement(params: {
  updateId: string;
  userParty: string;
  receiverParty: string;
  minFeeCc: string;
}): Promise<void> {
  const events = await fetchUpdateEventsById(params.updateId, [
    params.userParty,
    params.receiverParty
  ]);
  const dso = await getDsoPartyId();
  const ok = ccNetworkFeePaidInEvents(events, {
    userParty: params.userParty,
    receiverParty: params.receiverParty,
    minFeeCc: params.minFeeCc,
    expectedInstrument: { admin: dso, id: "Amulet" }
  });
  if (!ok) {
    throw new Error(
      "settlement update does not prove CC network fee payment"
    );
  }
}

import "server-only";

import { fetchUpdateEventsById } from "./canton-swap-leg-verify";
import { getDsoPartyId } from "./cc-registry";
import { ccNetworkFeeRejectReason } from "./network-fee-verify-logic";

/** Verify a Loop wallet submit actually paid the CC network fee. */
export async function verifyLoopNetworkFeeSettlement(params: {
  updateId: string;
  userParty: string;
  receiverParty: string;
  minFeeCc: string;
  /** Exact CID disclosed when the fee transfer command was prepared. */
  expectedPreapprovalCid: string;
}): Promise<void> {
  // SECURITY: transaction-tree evidence must come from the ledger. Never accept a
  // browser-supplied tree here because it is not cryptographically bound to updateId.
  let events: Record<string, unknown> | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    events = await fetchUpdateEventsById(params.updateId, [
      params.userParty,
      params.receiverParty
    ]);
    if (events && Object.keys(events).length > 0) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (!events || Object.keys(events).length === 0) {
    throw new Error(
      "settlement update tree not found — fee may still be processing; retry shortly"
    );
  }
  const dso = await getDsoPartyId();
  const verifyParams = {
    userParty: params.userParty,
    receiverParty: params.receiverParty,
    minFeeCc: params.minFeeCc,
    expectedInstrument: { admin: dso, id: "Amulet" as const },
    expectedPreapprovalCid: params.expectedPreapprovalCid
  };
  const rejectReason = ccNetworkFeeRejectReason(events, verifyParams);
  if (rejectReason) {
    throw new Error(
      `settlement update does not prove CC network fee payment (${rejectReason})`
    );
  }
}

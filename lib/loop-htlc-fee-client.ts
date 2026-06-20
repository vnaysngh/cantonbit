/**
 * Browser Loop wallet — pay HTLC network fee (CC) before lock or claim.
 * Loop SDK supports one command per submit; fee is always a separate Loop sign.
 */
import { isNetworkFeeUiEnabled } from "@/lib/constants";
import { loopHtlcCollectsOranjNetworkFee } from "@/lib/loop-htlc-fee-policy";
import { extractSubmitUpdateId } from "@/lib/mint-processor-logic";
import { listLoopCcHoldingCids } from "@/lib/loop-holdings";
import { htlcApi } from "@/lib/htlc-client";

export type LoopFeeProvider = {
  party_id?: string;
  submitAndWaitForTransaction: (
    payload: unknown,
    options?: unknown
  ) => Promise<unknown>;
  getActiveContracts?: (params?: {
    interfaceId?: string;
    templateId?: string;
  }) => Promise<unknown[]>;
};

/** Pay Loop HTLC network fee when enabled and not yet recorded. Idempotent. */
export async function payLoopHtlcNetworkFeeIfNeeded(opts: {
  orderId: string;
  direction: "evm-to-canton" | "canton-to-evm";
  provider: LoopFeeProvider;
  networkFeeCollected?: boolean;
}): Promise<void> {
  if (!isNetworkFeeUiEnabled()) return;
  if (!loopHtlcCollectsOranjNetworkFee(opts.direction)) return;
  if (opts.networkFeeCollected === true) return;

  const ccCids = await listLoopCcHoldingCids(
    opts.provider as Parameters<typeof listLoopCcHoldingCids>[0]
  );
  if (!ccCids.length) {
    throw new Error(
      "Insufficient CC in Loop wallet for Canton network fee — send CC to your Loop wallet first."
    );
  }

  const prep = await htlcApi.prepareNetworkFee(opts.orderId, ccCids);

  const userParty = opts.provider.party_id ?? "";
  if (!userParty) throw new Error("Loop wallet party unavailable — reconnect Loop.");

  const result = await opts.provider.submitAndWaitForTransaction(
    {
      commands: [prep.command],
      disclosedContracts: prep.disclosedContracts,
      packageIdSelectionPreference: [],
      actAs: [userParty],
      readAs: [userParty],
      synchronizerId: prep.synchronizerId
    },
    undefined
  );
  const updateId = extractSubmitUpdateId(result);
  if (!updateId) {
    throw new Error("Loop fee submit succeeded but update id missing — retry shortly.");
  }
  await htlcApi.recordNetworkFee(opts.orderId, updateId);
}

/**
 * cBTC transfer flow — send and accept TransferInstructions via Loop SDK.
 *
 * Send flow uses provider.transfer() — Loop's native transfer method that
 * calls cantonloop.com/.../transfer to prepare commands, then submits via
 * the standard WebSocket path. This works for Splice DAR tokens (including
 * cBTC) because Loop knows about the TransferFactory interface natively.
 *
 * Accept flow uses provider.submitTransaction() with disclosed contracts
 * fetched from the Token Standard registry API. The registry is public and
 * doesn't require any auth.
 *
 * Neither flow uses the server-side m2m JWT or lib/canton.ts — all
 * transaction submission goes through the user's Loop session.
 */

import { NETWORK } from "./constants";
import type { LoopProvider } from "@/hooks/useWallet";

const TRANSFER_INSTRUCTION_TEMPLATE_ID =
  "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction";

const TRANSFER_INSTRUCTION_ACCEPT_CHOICE = "TransferInstruction_Accept";

export interface TransferResult {
  /** The Canton update ID from the completed transaction. */
  updateId: string | null;
}

/**
 * Send cBTC to another Canton party.
 *
 * Uses provider.transfer() — Loop's native method that:
 *   1. POSTs to cantonloop.com/.../transfer to prepare the commands
 *      (Loop handles resolving the TransferFactory contract internally)
 *   2. Submits via the WebSocket RUN_TRANSACTION path (Loop popup)
 *   3. Returns the completed transaction payload
 *
 * The instrument is the cBTC instrument from NETWORK config.
 *
 * @param provider  Connected Loop provider
 * @param recipient Target party ID
 * @param amount    Decimal BTC string (e.g. "0.001")
 */
export async function sendCbtc(
  provider: LoopProvider,
  recipient: string,
  amount: string,
): Promise<TransferResult> {
  const result = await provider.transfer(
    recipient,
    amount,
    {
      instrument_admin: NETWORK.instrumentId.admin,
      instrument_id: NETWORK.instrumentId.id,
    },
    {
      message: `Send ${amount} cBTC to ${recipient.slice(0, 12)}…`,
      executionMode: "wait",
    },
  );

  return {
    updateId: extractUpdateId(result),
  };
}

/**
 * Accept an incoming TransferInstruction (receiver side).
 *
 * The accept choice requires disclosed contracts from the Token Standard
 * registry. We fetch these from the public registry API (no auth needed),
 * then submit via provider.submitTransaction() so the user signs it.
 *
 * @param provider                    Connected Loop provider
 * @param userParty                   The receiver's party ID
 * @param transferInstructionCid      The TransferInstruction contract ID to accept
 */
export async function acceptTransfer(
  provider: LoopProvider,
  userParty: string,
  transferInstructionCid: string,
): Promise<TransferResult> {
  // Fetch the accept choice context from the Token Standard registry.
  // This is a public GET — no JWT required.
  const { acceptChoiceContextUrl } = await import("./constants");
  const registryUrl = acceptChoiceContextUrl(transferInstructionCid);

  const registryRes = await fetch(registryUrl, {
    method: "GET",
    headers: { accept: "application/json" },
    cache: "no-store",
  });

  if (!registryRes.ok) {
    const text = await registryRes.text().catch(() => "<no body>");
    throw new Error(
      `Token Standard registry GET failed (${registryRes.status}): ${text}`,
    );
  }

  const context = (await registryRes.json()) as {
    disclosedContracts?: Array<{
      contractId: string;
      createdEventBlob: string;
      templateId?: string;
      synchronizerId?: string;
    }>;
  };

  const disclosedContracts = (context.disclosedContracts ?? []).map((dc) => ({
    templateId: dc.templateId ?? "",
    contractId: dc.contractId,
    createdEventBlob: dc.createdEventBlob,
    synchronizerId: dc.synchronizerId ?? "",
  }));

  const result = await provider.submitTransaction(
    {
      actAs: [userParty],
      disclosedContracts,
      commands: [
        {
          ExerciseCommand: {
            templateId: TRANSFER_INSTRUCTION_TEMPLATE_ID,
            contractId: transferInstructionCid,
            choice: TRANSFER_INSTRUCTION_ACCEPT_CHOICE,
            choiceArgument: {},
          },
        },
      ],
    },
    {
      message: "Accept incoming cBTC transfer",
      executionMode: "wait",
    },
  );

  return {
    updateId: extractUpdateId(result),
  };
}

/* ── helpers ── */

function extractUpdateId(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const r = result as {
    transactionTree?: { updateId?: string };
    transaction?: { updateId?: string };
    updateId?: string;
    update_id?: string;
  };
  return (
    r.transactionTree?.updateId ??
    r.transaction?.updateId ??
    r.updateId ??
    r.update_id ??
    null
  );
}

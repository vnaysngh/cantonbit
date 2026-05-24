"use client";

import { useEffect, useState } from "react";

import { NETWORK } from "@/lib/constants";
import type { ActivityRow } from "@/lib/types";
import { useWallet } from "./useWallet";

interface TransfersState {
  activity: ActivityRow[];
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

/**
 * TransferInstruction interface ID — covers pending send/receive instructions
 * that have been created but not yet accepted or rejected.
 *
 * We use the interface (not a concrete template) so this works across
 * different Splice package versions.
 */
const TRANSFER_INSTRUCTION_INTERFACE_ID =
  "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction";

export function useTransfers(): TransfersState {
  const { isConnected, partyId, provider } = useWallet();

  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!isConnected || !provider || !partyId) return;

    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsLoading(true);
    setError(null);

    (async () => {
      try {
        /**
         * provider.getActiveContracts({ interfaceId: TRANSFER_INSTRUCTION_INTERFACE_ID })
         * → GET cantonloop.com/.../active-contracts?interfaceId=...
         *
         * Returns all pending TransferInstruction contracts where this party
         * is either sender or receiver. Scoped to this party by Loop's
         * auth_token. We additionally filter by partyId involvement and
         * by instrumentId (cBTC only) before mapping to ActivityRow.
         */
        const contracts = await provider.getActiveContracts({
          interfaceId: TRANSFER_INSTRUCTION_INTERFACE_ID,
        });
        if (cancelled) return;

        const rows: ActivityRow[] = [];

        for (const c of contracts) {
          const cAny = c as unknown as Record<string, unknown>;

          // Extract the interface view payload — Loop may return it under
          // different keys depending on SDK version.
          const viewValue =
            (cAny.interface_views as Array<{ view_value?: Record<string, unknown> }> | undefined)?.[0]?.view_value ??
            (cAny.interfaceViews as Array<{ viewValue?: Record<string, unknown> }> | undefined)?.[0]?.viewValue ??
            (cAny.payload as Record<string, unknown> | undefined) ??
            cAny;

          const v = viewValue as {
            sender?: string;
            receiver?: string;
            amount?: string;
            instrumentId?: { admin?: string; id?: string };
            meta?: Record<string, unknown>;
          };

          // Only include cBTC transfers.
          if (
            v.instrumentId?.id !== NETWORK.instrumentId.id ||
            v.instrumentId?.admin !== NETWORK.instrumentId.admin
          ) {
            continue;
          }

          // Only include if this party is the sender or receiver.
          const isSender = v.sender === partyId;
          const isReceiver = v.receiver === partyId;
          if (!isSender && !isReceiver) continue;

          rows.push({
            id: c.contract_id,
            kind: isSender ? "sent" : "received",
            amount: v.amount ?? "0",
            counterparty: isSender ? (v.receiver ?? "") : (v.sender ?? ""),
            // TransferInstruction contracts don't carry a timestamp in their
            // payload — we'd need the transaction tree for that. Use empty
            // string for now; the activity screen can show "pending" without it.
            timestamp: "",
            status: "pending",
            txid: c.contract_id,
          });
        }

        setActivity(rows);
        setIsLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isConnected, provider, partyId, tick]);

  return {
    activity: isConnected ? activity : [],
    isLoading: isConnected && isLoading,
    error: isConnected ? error : null,
    refetch: () => setTick((n) => n + 1),
  };
}

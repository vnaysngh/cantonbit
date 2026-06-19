import type { CantonSwapMvpAssetId, CantonSwapOrder } from "./canton-swap-types";

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    },
    cache: "no-store"
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      typeof (body as { error?: string }).error === "string"
        ? (body as { error: string }).error
        : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body as T;
}

export const cantonSwapApi = {
  quote(fromAsset: CantonSwapMvpAssetId, toAsset: CantonSwapMvpAssetId, amount: string, userParty?: string) {
    return json<{
      inAmount: string;
      outAmount: string;
      feeBps: number;
      expires: number;
      networkFeeCc?: string;
      networkFeeUsd?: number;
      minCcRequired?: string;
      networkFeeSource?: string;
    }>("/api/canton/swap/quote", {
      method: "POST",
      body: JSON.stringify({ fromAsset, toAsset, amount, userParty })
    });
  },

  estimateNetworkFee(body: Record<string, unknown>) {
    return json<{
      feeCc: string;
      feeUsd: number;
      minCcRequired: string;
      networkFeeSource: string;
      trafficBytes?: number;
      networkFeeTransactions?: import("@/lib/canton-network-fee-math").NetworkFeeTxLeg[];
      networkFeeCharged?: boolean;
      networkFeePreview?: boolean;
    }>("/api/canton/network-fee/estimate", {
      method: "POST",
      body: JSON.stringify(body)
    });
  },

  createOrder(params: {
    fromAsset: CantonSwapMvpAssetId;
    toAsset: CantonSwapMvpAssetId;
    inAmount: string;
    outAmount: string;
    userParty: string;
    walletMode: "managed" | "loop";
    id?: string;
  }) {
    return json<{ order: CantonSwapOrder }>("/api/canton/swap", {
      method: "POST",
      body: JSON.stringify(params)
    });
  },

  /** Managed: atomic create + settle (single HTTP round-trip). */
  submitManaged(params: {
    fromAsset: CantonSwapMvpAssetId;
    toAsset: CantonSwapMvpAssetId;
    inAmount: string;
    outAmount: string;
    userParty: string;
    id?: string;
  }) {
    return json<{ order: CantonSwapOrder }>("/api/canton/swap/submit", {
      method: "POST",
      body: JSON.stringify(params)
    });
  },

  settle(orderId: string) {
    return json<{ order: CantonSwapOrder }>(
      `/api/canton/swap/${encodeURIComponent(orderId)}/settle`,
      { method: "POST", body: "{}" }
    );
  },

  cancel(orderId: string) {
    return json<{ order: CantonSwapOrder }>(
      `/api/canton/swap/${encodeURIComponent(orderId)}/cancel`,
      { method: "POST", body: "{}" }
    );
  },

  get(orderId: string) {
    return json<{ order: CantonSwapOrder }>(
      `/api/canton/swap/${encodeURIComponent(orderId)}`
    );
  },

  history(party: string) {
    return json<{ orders: CantonSwapOrder[] }>(
      `/api/canton/swap/history?party=${encodeURIComponent(party)}`
    );
  },

  prepareUserLeg(orderId: string, inputHoldingCids: string[]) {
    return json<{
      command: unknown;
      disclosedContracts: unknown[];
      synchronizerId: string;
    }>(`/api/canton/swap/${encodeURIComponent(orderId)}/prepare-user-leg`, {
      method: "POST",
      body: JSON.stringify({ inputHoldingCids })
    });
  },

  confirmUserLeg(
    orderId: string,
    params?: { offerContractId?: string; submitUpdateId?: string }
  ) {
    return json<{ order: CantonSwapOrder }>(
      `/api/canton/swap/${encodeURIComponent(orderId)}/confirm-user-leg`,
      {
        method: "POST",
        body: JSON.stringify({
          offerContractId: params?.offerContractId,
          submitUpdateId: params?.submitUpdateId
        })
      }
    );
  },

  prepareCounterAccept(orderId: string) {
    return json<{
      command: unknown;
      disclosedContracts: unknown[];
      synchronizerId: string;
    }>(
      `/api/canton/swap/${encodeURIComponent(orderId)}/prepare-counter-accept`,
      { method: "POST", body: "{}" }
    );
  },

  confirmCounterAccept(orderId: string) {
    return json<{ order: CantonSwapOrder }>(
      `/api/canton/swap/${encodeURIComponent(orderId)}/confirm-counter-accept`,
      { method: "POST", body: "{}" }
    );
  }
};

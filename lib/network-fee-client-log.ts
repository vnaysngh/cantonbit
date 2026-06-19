/** Browser console helper for network fee debugging. */

export interface NetworkFeeLogPayload {
  feeCc?: string;
  feeUsd?: number;
  trafficBytes?: number;
  minCcRequired?: string;
  networkFeeSource?: string;
  networkFeeCharged?: boolean;
  networkFeePreview?: boolean;
}

export function logNetworkFeeInBrowser(
  label: string,
  payload: NetworkFeeLogPayload
): void {
  console.info("[OranjSwap network-fee]", label, payload);
}

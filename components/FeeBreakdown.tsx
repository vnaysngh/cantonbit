"use client";

import type { NetworkFeeTxLeg } from "@/lib/canton-network-fee-math";

export interface FeeBreakdownProps {
  platformFeeLabel: string;
  networkFeeCc?: string;
  networkFeeUsd?: number;
  networkFeeSource?: string;
  /** Kept for API compatibility; not shown in user UI. */
  trafficBytes?: number;
  networkFeeTransactions?: NetworkFeeTxLeg[];
  /** Kept for API compatibility; not shown in user UI. */
  networkFeePreview?: boolean;
  /** Loop wallet paths where Canton traffic is Loop-billed, not an Oranj CC line item. */
  hideCantonNetworkFee?: boolean;
  loading?: boolean;
  evmGasLabel?: string;
}

/** Temporarily hide USD on the network fee line; restore by setting true. */
const SHOW_NETWORK_FEE_USD = false;

function formatUsd(usd: number | undefined): string {
  if (usd == null || !Number.isFinite(usd) || usd <= 0) return "";
  if (usd < 0.01) return "< $0.01";
  return `≈ $${usd.toFixed(2)}`;
}

function formatCantonNetworkFee(cc: string | undefined, usd: number | undefined): string {
  if (!cc || Number.parseFloat(cc) <= 0) return "—";
  const usdSuffix = formatUsd(usd);
  return usdSuffix ? `~${cc} CC ${usdSuffix}` : `~${cc} CC`;
}

export function FeeBreakdown({
  platformFeeLabel,
  networkFeeCc,
  networkFeeUsd,
  networkFeeSource,
  networkFeePreview,
  hideCantonNetworkFee,
  loading,
  evmGasLabel
}: FeeBreakdownProps) {
  const serverQuotedFee =
    !!networkFeeSource && networkFeeSource !== "disabled";
  const showCantonNetworkFee =
    !hideCantonNetworkFee &&
    (serverQuotedFee || networkFeePreview === true || loading);

  if (!showCantonNetworkFee) {
    return (
      <div className="flex flex-col gap-1.5 text-sm">
        <DetailRow label="Platform fee" value={platformFeeLabel} />
        {evmGasLabel ? (
          <DetailRow label="Network fee (EVM)" value={evmGasLabel} />
        ) : null}
      </div>
    );
  }

  let networkLabel = "—";
  if (loading) {
    networkLabel = "Estimating…";
  } else {
    networkLabel = formatCantonNetworkFee(
      networkFeeCc,
      SHOW_NETWORK_FEE_USD ? networkFeeUsd : undefined
    );
  }

  return (
    <div className="flex flex-col gap-1.5 text-sm">
      <DetailRow label="Platform fee" value={platformFeeLabel} />
      <DetailRow label="Network fee" value={networkLabel} />
      {evmGasLabel ? <DetailRow label="EVM gas" value={evmGasLabel} /> : null}
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right text-foreground">{value}</span>
    </div>
  );
}

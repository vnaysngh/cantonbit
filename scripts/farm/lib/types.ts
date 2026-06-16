export type FarmAsset = "CBTC" | "CC";

export interface FarmTrader {
  hint: string;
  party: string;
}

export interface FarmFleetCalibration {
  bytesPerSwap?: number;
  measuredAt?: string;
  source?: "lighthouse" | "ledger-estimate";
}

export interface FarmFleetConfig {
  network: "mainnet";
  createdAt: string;
  vault: string;
  treasury: string;
  traders: FarmTrader[];
  calibration?: FarmFleetCalibration;
}

export interface FarmSwapResult {
  swapId: string;
  fromAsset: FarmAsset;
  toAsset: FarmAsset;
  inAmount: string;
  outAmount: string;
  traderParty: string;
  offerUpdateId: string;
  fillUpdateId: string;
  counterPendingAccept: boolean;
  counterLegOfferCid?: string;
  ccBurnSuspected?: boolean;
  burnChoices?: string[];
}

export interface PacingConfig {
  targetUtilization: number;
  bytesPerSwap: number | null;
  calibrateEvery: number;
  minIntervalSec: number;
  maxIntervalSec: number;
  /** Fixed trader input when selling CBTC. */
  cbtcInAmount: string;
  /** Fixed trader input when selling CC. */
  ccInAmount: string;
  cbtcDirectionBias: number;
  refillBytesPerSec: number;
}

export interface OrganicPick {
  traderIndex: number;
  traderParty: string;
  fromAsset: FarmAsset;
  toAsset: FarmAsset;
  inAmount: string;
}

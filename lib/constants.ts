export type NetworkName = "devnet" | "testnet" | "mainnet";

// Mirrors the @fivenorth/loop-sdk Network union. Re-declared here to avoid
// a runtime import from the SDK in code paths that don't need the SDK loaded.
export type LoopNetwork =
  | "local"
  | "devnet"
  | "testnet"
  | "mainnet"
  | "dev"
  | "test"
  | "main";

export interface InstrumentId {
  admin: string;
  id: string;
}

/** The `chain` string passed in coordinator request bodies. */
export type CantonChain = "canton-devnet" | "canton-testnet" | "canton-mainnet";

export interface NetworkConfig {
  name: NetworkName;
  ledgerHost: string;
  registryUrl: string;
  coordinatorUrl: string;
  decentralizedPartyId: string;
  instrumentId: InstrumentId;
  loopNetwork: LoopNetwork;
  /** Used as the `chain` field in every coordinator POST body. */
  chain: CantonChain;
}

const CBTC_DEVNET_ADMIN =
  "cbtc-network::12202a83c6f4082217c175e29bc53da5f2703ba2675778ab99217a5a881a949203ff";

const CBTC_TESTNET_ADMIN =
  "cbtc-network::12201b1741b63e2494e4214cf0bedc3d5a224da53b3bf4d76dba468f8e97eb15508f";

const CBTC_MAINNET_ADMIN =
  "cbtc-network::12205af3b949a04776fc48cdcc05a060f6bda2e470632935f375d1049a8546a3b262";

export const NETWORKS: Record<NetworkName, NetworkConfig> = {
  devnet: {
    name: "devnet",
    ledgerHost: "https://ledger-api.validator.devnet.warpx.fivenorth.io",
    registryUrl: "https://api.utilities.digitalasset-dev.com",
    coordinatorUrl: "https://devnet.dlc.link/attestor-2",
    decentralizedPartyId: CBTC_DEVNET_ADMIN,
    instrumentId: { admin: CBTC_DEVNET_ADMIN, id: "CBTC" },
    loopNetwork: "devnet",
    chain: "canton-devnet",
  },
  testnet: {
    name: "testnet",
    // Testnet ledger host not yet published — fall back to devnet until confirmed.
    // TODO(testnet-ledger): replace with the real testnet ledger API host.
    ledgerHost: "https://ledger-api.validator.devnet.warpx.fivenorth.io",
    registryUrl: "https://api.utilities.digitalasset-staging.com",
    coordinatorUrl: "https://testnet.dlc.link/attestor-1",
    decentralizedPartyId: CBTC_TESTNET_ADMIN,
    instrumentId: { admin: CBTC_TESTNET_ADMIN, id: "CBTC" },
    loopNetwork: "testnet",
    chain: "canton-testnet",
  },
  mainnet: {
    name: "mainnet",
    ledgerHost: "https://ledger-api.validator.warpx.fivenorth.io",
    registryUrl: "https://api.utilities.digitalasset.com",
    coordinatorUrl: "https://mainnet.dlc.link/attestor-1",
    decentralizedPartyId: CBTC_MAINNET_ADMIN,
    instrumentId: { admin: CBTC_MAINNET_ADMIN, id: "CBTC" },
    loopNetwork: "mainnet",
    chain: "canton-mainnet",
  },
};

function resolveNetworkName(): NetworkName {
  const raw = process.env.NEXT_PUBLIC_NETWORK?.toLowerCase();
  if (raw === "testnet" || raw === "mainnet" || raw === "devnet") {
    return raw;
  }
  return "devnet";
}

export const NETWORK: NetworkConfig = NETWORKS[resolveNetworkName()];

// Token Standard endpoint helpers — built from NETWORK so screens never
// concatenate URLs themselves.
export const tokenStandardBase = (): string =>
  `${NETWORK.registryUrl}/api/token-standard/v0/registrars/${NETWORK.decentralizedPartyId}/registry`;

export const instrumentsMetadataUrl = (): string =>
  `${tokenStandardBase()}/metadata/v1/instruments`;

export const acceptChoiceContextUrl = (transferInstructionCid: string): string =>
  `${tokenStandardBase()}/transfer-instruction/v1/${transferInstructionCid}/choice-contexts/accept`;

// Display constraints (from CLAUDE.md).
export const UTXO_WARN_THRESHOLD = 8;
export const UTXO_HARD_LIMIT = 10;
export const BITCOIN_CONFIRMATIONS_REQUIRED = 6;
export const JWT_REFRESH_BUFFER_SECONDS = 5 * 60;

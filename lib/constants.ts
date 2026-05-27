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
  /**
   * WarpX-hosted party ID used as actAs for mint/burn operations.
   * This party lives directly on the WarpX node (not cantonloop.com),
   * so the m2m JWT has authority over it and cBTC DARs are already vetted.
   */
  warpxPartyId: string;
  /**
   * Minter credential contract ID issued by BitSafe.
   * Required in choiceArgument.credentialCids for CreateDepositAccount
   * and CBTCWithdrawAccount_Withdraw choices.
   */
  credentialCid: string;
  /**
   * Base64-encoded createdEventBlob for the minter credential contract.
   * The credential lives on BitSafe's node — must be included as a
   * disclosedContract so our WarpX node can validate credentialCids.
   */
  credentialBlob: string;
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
    coordinatorUrl: "https://api.devnet.bitsafe.finance",
    decentralizedPartyId: CBTC_DEVNET_ADMIN,
    instrumentId: { admin: CBTC_DEVNET_ADMIN, id: "CBTC" },
    loopNetwork: "devnet",
    chain: "canton-devnet",
    warpxPartyId: "warpx-devnet-1::1220231c1885f289f90e0d08b448579c31a655b5826802c6d885258a27371039fba9",
    credentialCid: "", // TODO: get devnet credential from BitSafe
    credentialBlob: "", // TODO: get devnet credential blob from BitSafe
  },
  testnet: {
    name: "testnet",
    // Testnet ledger host not yet confirmed — fall back to devnet until provided.
    // TODO(testnet-ledger): replace with the real testnet ledger API host.
    ledgerHost: "https://ledger-api.validator.devnet.warpx.fivenorth.io",
    registryUrl: "https://api.utilities.digitalasset-staging.com",
    coordinatorUrl: "https://api.testnet.bitsafe.finance",
    decentralizedPartyId: CBTC_TESTNET_ADMIN,
    instrumentId: { admin: CBTC_TESTNET_ADMIN, id: "CBTC" },
    loopNetwork: "testnet",
    chain: "canton-testnet",
    warpxPartyId: "", // TODO: allocate a testnet party on WarpX node
    credentialCid: "", // TODO: get testnet credential from BitSafe
    credentialBlob: "", // TODO: get testnet credential blob from BitSafe
  },
  mainnet: {
    name: "mainnet",
    ledgerHost: "https://ledger-api.validator.warpx.fivenorth.io",
    registryUrl: "https://api.utilities.digitalasset.com",
    coordinatorUrl: "https://api.mainnet.bitsafe.finance",
    decentralizedPartyId: CBTC_MAINNET_ADMIN,
    instrumentId: { admin: CBTC_MAINNET_ADMIN, id: "CBTC" },
    loopNetwork: "mainnet",
    chain: "canton-mainnet",
    warpxPartyId: "warpx-mainnet-1::1220517bfd86ef5732610705a35b7b2d56e36112550d6a2b778971dbd099a3d36e99",
    credentialCid: "00bca91447e080bf755cef860f1a91b6273798251298b92fdad71a20522c15d636ca1212208d066116e7056524c5d348d284f9afeae4f28d3befa5ca4bf4e401fd1543a8c9",
    credentialBlob: "CgMyLjESkwgKRQC8qRRH4IC/dVzvhg8akbYnN5glEpi5L9rXGiBSLBXWNsoSEiCNBmEW5wVlJMXTSNKE+a/q5PKNO++lykv05AH9FUOoyRIVdXRpbGl0eS1jcmVkZW50aWFsLXYwGnMKQDVhMjllYWQ2MTFhMGFiZDVmNWIzZmMzY2FmN2QwZjY3YzBmZjgwMjAzMmFiNmQzOTI4MjRhYTkwNjBlNTZkNzASB1V0aWxpdHkSCkNyZWRlbnRpYWwSAlYwEgpDcmVkZW50aWFsGgpDcmVkZW50aWFsIvMDavADClYKVDpSY2J0Yy1uZXR3b3JrOjoxMjIwNWFmM2I5NDlhMDQ3NzZmYzQ4Y2RjYzA1YTA2MGY2YmRhMmU0NzA2MzI5MzVmMzc1ZDEwNDlhODU0NmEzYjI2MgpZClc6VXdhcnB4LW1haW5uZXQtMTo6MTIyMDUxN2JmZDg2ZWY1NzMyNjEwNzA1YTM1YjdiMmQ1NmUzNjExMjU1MGQ2YTJiNzc4OTcxZGJkMDk5YTNkMzZlOTkKEgoQQg53YXJweC1taW50ZXItMQoaChhCFkNCVEMgTWludGVyIENyZWRlbnRpYWwKBAoCUgAKBAoCUgAKgAEKflp8CnpqeApZCldCVXdhcnB4LW1haW5uZXQtMTo6MTIyMDUxN2JmZDg2ZWY1NzMyNjEwNzA1YTM1YjdiMmQ1NmUzNjExMjU1MGQ2YTJiNzc4OTcxZGJkMDk5YTNkMzZlOTkKDwoNQgtoYXNDQlRDUm9sZQoKCghCBk1pbnRlcgp8CnpqeAp2CnRicgpwCmo6aGF1dGgwXzAwN2M2NjQzNTM4ZjJlYWRkM2U1NzNkZDA1Yjk6OjEyMjA1YmNjMTA2ZWZhMGVhYTdmMThkYzQ5MWU1YzZmNWZiOWIwY2M2OGRjMTEwYWU2NmY0ZWQ2NDY3NDc1ZDdjNzhlEgIKACpSY2J0Yy1uZXR3b3JrOjoxMjIwNWFmM2I5NDlhMDQ3NzZmYzQ4Y2RjYzA1YTA2MGY2YmRhMmU0NzA2MzI5MzVmMzc1ZDEwNDlhODU0NmEzYjI2MipVd2FycHgtbWFpbm5ldC0xOjoxMjIwNTE3YmZkODZlZjU3MzI2MTA3MDVhMzViN2IyZDU2ZTM2MTEyNTUwZDZhMmI3Nzg5NzFkYmQwOTlhM2QzNmU5OTJoYXV0aDBfMDA3YzY2NDM1MzhmMmVhZGQzZTU3M2RkMDViOTo6MTIyMDViY2MxMDZlZmEwZWFhN2YxOGRjNDkxZTVjNmY1ZmI5YjBjYzY4ZGMxMTBhZTY2ZjRlZDY0Njc0NzVkN2M3OGU50p3ncKRSBgBCKgomCiQIARIgmlAEdJptO6UkR+iR5hxgkWC637UN80vmB3Smfi+cVm8QHg==",
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

// Warn when holding count is high. No hard block — Canton enforces its own limits.
export const UTXO_WARN_THRESHOLD = 20;
export const BITCOIN_CONFIRMATIONS_REQUIRED = 6;
export const JWT_REFRESH_BUFFER_SECONDS = 5 * 60;

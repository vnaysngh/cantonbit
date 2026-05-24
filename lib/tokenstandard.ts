/**
 * NOTE: server-only guard removed. getAcceptChoiceContext is now called
 * client-side from lib/transfer.ts. getInstrumentsMetadata and
 * getTransferFactoryContractId are kept here for any server route that
 * needs them (e.g. future admin routes).
 */
import {
  acceptChoiceContextUrl,
  instrumentsMetadataUrl,
} from "./constants";
import type { DisclosedContract } from "./types";

/**
 * Public Token Standard registrar API. No JWT required — these are
 * public registry endpoints served by the CN utilities host.
 *
 * Reference:
 *   https://docs.dev.sync.global/app_dev/token_standard/index.html#api-references
 */

export interface RegistryInstrument {
  id: string;
  admin: string;
  name?: string;
  symbol?: string;
  decimals?: number;
  /** Contract id of the TransferFactory backing this instrument. */
  transferFactoryContractId?: string;
  /** Some registrars publish this as a nested object instead. */
  transferFactory?: { contractId: string };
  /** Anything else the registrar wants to publish. */
  [key: string]: unknown;
}

interface InstrumentsMetadataResponse {
  // Registrars in the wild use one of these two wrappers; accept both.
  instruments?: RegistryInstrument[];
  result?: RegistryInstrument[];
}

interface AcceptChoiceContextResponse {
  disclosedContracts: DisclosedContract[];
  choiceContextData?: unknown;
}

async function registryFetch<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    method: "GET",
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "<no body>");
    throw new Error(
      `Token Standard GET ${url} failed (${res.status} ${res.statusText}): ${text}`,
    );
  }
  return (await res.json()) as T;
}

/** GET <REGISTRY_URL>/.../registry/metadata/v1/instruments */
export async function getInstrumentsMetadata(): Promise<RegistryInstrument[]> {
  const resp = await registryFetch<InstrumentsMetadataResponse>(
    instrumentsMetadataUrl(),
  );
  return resp.instruments ?? resp.result ?? [];
}

/**
 * Find the CBTC instrument entry and pull out the TransferFactory contract
 * id. Used by the sender flow to know which factory contract to exercise.
 */
export async function getTransferFactoryContractId(): Promise<string | null> {
  const instruments = await getInstrumentsMetadata();
  const cbtc = instruments.find((i) => i.id === "CBTC");
  if (!cbtc) return null;
  return cbtc.transferFactoryContractId ?? cbtc.transferFactory?.contractId ?? null;
}

/**
 * GET <REGISTRY_URL>/.../transfer-instruction/v1/<cid>/choice-contexts/accept
 *
 * Returns the disclosed contracts the receiver needs to include when
 * exercising TransferInstruction_Accept on the ledger.
 */
export async function getAcceptChoiceContext(
  transferInstructionContractId: string,
): Promise<AcceptChoiceContextResponse> {
  return registryFetch<AcceptChoiceContextResponse>(
    acceptChoiceContextUrl(transferInstructionContractId),
  );
}

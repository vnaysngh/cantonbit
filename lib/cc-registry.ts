import "server-only";

import { getLedgerJwt } from "./auth";
import { NETWORK } from "./constants";

const TAG = "[cc-registry]";

let cachedDsoParty: string | null = null;
const cachedTransferPreapprovalCids = new Map<
  string,
  { contractId: string; until: number }
>();

function validatorUrl(path: string): string {
  return `${NETWORK.validatorHost}/api/validator${path}`;
}

/** DSO party id for this network (Amulet admin). Cached per process. */
export async function getDsoPartyId(): Promise<string> {
  if (cachedDsoParty) return cachedDsoParty;
  const jwt = await getLedgerJwt();
  const r = await fetch(validatorUrl("/v0/scan-proxy/dso-party-id"), {
    headers: { Authorization: `Bearer ${jwt}` },
    cache: "no-store"
  });
  if (!r.ok) {
    throw new Error(
      `DSO party lookup failed (${r.status}): ${await r.text().catch(() => "")}`
    );
  }
  const j = (await r.json()) as { dso_party_id?: string };
  const dso = j.dso_party_id?.trim();
  if (!dso) throw new Error("DSO party lookup returned no dso_party_id");
  cachedDsoParty = dso;
  console.log(`${TAG} DSO party ${dso.slice(0, 28)}…`);
  return dso;
}

/**
 * CC (Amulet) Token Standard registry path on the validator scan-proxy.
 * Public Scan URLs require auth and return 403 without it — always use this
 * helper (via fetchCcRegistry) instead of calling scan.sv-* directly.
 */
export function ccRegistryPath(suffix: string): string {
  const path = suffix.startsWith("/") ? suffix : `/${suffix}`;
  return validatorUrl(`/v0/scan-proxy/registry${path}`);
}

/** Authenticated POST/GET to the CC registry via validator scan-proxy. */
export async function fetchCcRegistry(
  suffix: string,
  init: RequestInit = {}
): Promise<Response> {
  const jwt = await getLedgerJwt();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${jwt}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(ccRegistryPath(suffix), {
    ...init,
    headers,
    cache: "no-store"
  });
}

/** Active Splice CC TransferPreapproval contract for a receiver. */
export async function getCcTransferPreapprovalContractId(
  receiverParty: string
): Promise<string> {
  const cached = cachedTransferPreapprovalCids.get(receiverParty);
  if (cached && cached.until > Date.now()) return cached.contractId;
  const jwt = await getLedgerJwt();
  const r = await fetch(
    validatorUrl(
      `/v0/scan-proxy/transfer-preapprovals/by-party/${encodeURIComponent(receiverParty)}`
    ),
    {
      headers: { Authorization: `Bearer ${jwt}` },
      cache: "no-store"
    }
  );
  if (!r.ok) {
    throw new Error(
      `CC TransferPreapproval lookup failed (${r.status}): ${await r.text().catch(() => "")}`
    );
  }
  const body = (await r.json().catch(() => null)) as {
    transfer_preapproval?: {
      contract?: { contract_id?: string; contractId?: string };
    };
  } | null;
  const contract = body?.transfer_preapproval?.contract;
  const contractId = contract?.contract_id ?? contract?.contractId;
  if (!contractId) {
    throw new Error(
      "CC TransferPreapproval lookup returned no active contract id"
    );
  }
  cachedTransferPreapprovalCids.set(receiverParty, {
    contractId,
    until: Date.now() + 60_000
  });
  return contractId;
}

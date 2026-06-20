/**
 * Server-side Loop wallet signing for scripts and smoke tests.
 * Uses @fivenorth/loop-sdk/server with DEVNET_LOOP_PRIVATE_KEY from env.
 */
import crypto from "node:crypto";

import forge from "node-forge";
import { LoopSDK } from "@fivenorth/loop-sdk/server";

import { loopWebBase } from "@/lib/constants";
import { extractSubmitUpdateId } from "@/lib/mint-processor-logic";

/** Devnet Loop party tied to the repo's smoke key (fingerprint from purpose-12 hash). */
export const DEFAULT_DEVNET_LOOP_PARTY =
  "8f5ca108eb208e8826f868952ede00a5::12200fe103931833a6cb6f080dff41df997dbb9abd8d06384e6405434a04efcf8e2b";

export function cantonFingerprintFromLoopPrivateKey(privateKeyHex: string): string {
  const privateKey = forge.util.hexToBytes(privateKeyHex);
  const pubBytes = forge.pki.ed25519.publicKeyFromPrivateKey({ privateKey });
  const purpose = Buffer.from([0, 0, 0, 12]);
  const hash = crypto
    .createHash("sha256")
    .update(Buffer.concat([purpose, Buffer.from(pubBytes, "binary")]))
    .digest("hex");
  return `1220${hash}`;
}

export function resolveLoopPartyId(): string {
  const explicit =
    process.env.DEVNET_LOOP_PARTY?.trim() ||
    process.env.DEVNET_LOOP_PARTY_ID?.trim();
  if (explicit) return explicit;

  const pk = process.env.DEVNET_LOOP_PRIVATE_KEY?.trim();
  if (pk) {
    const fp = cantonFingerprintFromLoopPrivateKey(pk);
    if (fp === DEFAULT_DEVNET_LOOP_PARTY.split("::")[1]) {
      return DEFAULT_DEVNET_LOOP_PARTY;
    }
  }
  return DEFAULT_DEVNET_LOOP_PARTY;
}

export type LoopServerProvider = ReturnType<LoopSDK["getProvider"]>;

export async function connectLoopServer(): Promise<{
  sdk: LoopSDK;
  provider: LoopServerProvider;
  partyId: string;
}> {
  const privateKey = process.env.DEVNET_LOOP_PRIVATE_KEY?.trim();
  if (!privateKey) {
    throw new Error(
      "DEVNET_LOOP_PRIVATE_KEY is required — export from Loop settings or set in .env.devnet"
    );
  }
  const partyId = resolveLoopPartyId();
  const sdk = new LoopSDK();
  sdk.init({
    privateKey,
    partyId,
    network: "devnet",
    apiUrl: loopWebBase()
  });
  await sdk.authenticate();
  const provider = sdk.getProvider();
  const acct = await provider.getAccount();
  if (acct.party_id !== partyId) {
    throw new Error(
      `Loop auth party mismatch: expected ${partyId.slice(0, 24)}… got ${acct.party_id?.slice(0, 24)}…`
    );
  }
  return { sdk, provider, partyId };
}

export type LoopSubmitPayload = {
  commands: unknown[];
  disclosedContracts: unknown[];
  packageIdSelectionPreference?: string[];
  actAs?: string[];
  readAs?: string[];
  synchronizerId?: string;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Pay outstanding Loop network gas (CC) before the next Server SDK submit. */
export async function ensureLoopGasPaid(sdk: LoopSDK): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const pending = await sdk.checkDueGas();
    if (!pending.pending) return;
    const trackingId = pending.tracking_id?.trim();
    if (!trackingId) {
      throw new Error("Loop pending network gas has no tracking_id");
    }
    await sdk.payGas(trackingId);
    await sleep(2500);
  }
  const still = await sdk.checkDueGas();
  if (still.pending) {
    throw new Error(
      "There is pending network gas from an earlier transaction. Please pay it before submitting another Server SDK transaction."
    );
  }
}

function isRetriableLoopSubmitError(msg: string): boolean {
  return (
    msg.includes("CONTRACT_NOT_FOUND") ||
    msg.includes("pending network gas") ||
    msg.includes("502") ||
    msg.includes("consensus") ||
    msg.includes("FAILED_TO_PREPARE_TRANSACTION")
  );
}

export async function loopSubmitAndWait(
  sdk: LoopSDK,
  partyId: string,
  payload: LoopSubmitPayload
): Promise<{ updateId: string; raw: unknown }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await ensureLoopGasPaid(sdk);
      try {
        const est = await sdk.estimateGas({
          commands: payload.commands,
          disclosedContracts: payload.disclosedContracts,
          packageIdSelectionPreference: payload.packageIdSelectionPreference ?? [],
          actAs: payload.actAs ?? [partyId],
          readAs: payload.readAs ?? [partyId],
          synchronizerId: payload.synchronizerId
        });
        if (est.requires_gas && !est.can_execute) {
          await ensureLoopGasPaid(sdk);
        }
      } catch {
        // estimate is advisory — proceed to submit
      }
      const result = await sdk.executeTransaction({
        commands: payload.commands,
        disclosedContracts: payload.disclosedContracts,
        packageIdSelectionPreference: payload.packageIdSelectionPreference ?? [],
        actAs: payload.actAs ?? [partyId],
        readAs: payload.readAs ?? [partyId],
        synchronizerId: payload.synchronizerId
      });
      await ensureLoopGasPaid(sdk);
      const updateId = extractSubmitUpdateId(result) ?? "";
      return { updateId, raw: result };
    } catch (e) {
      lastError = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (!isRetriableLoopSubmitError(msg) || attempt >= 3) throw e;
      await ensureLoopGasPaid(sdk);
      await sleep(2000 * (attempt + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

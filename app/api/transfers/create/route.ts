/**
 * POST /api/transfers/create
 *
 * Phase 1: create a TransferOffer from the authenticated user's party to a
 * recipient party. Looks up the sender's holdings server-side via the m2m
 * JWT, so the client only sends recipient + amount + asset.
 *
 * Body: { recipient, amount, asset?: "CBTC" | "CC", memo?, expirationSeconds? }
 * Response: { updateId, offerContractId, transferKind }
 */

import { NextResponse } from "next/server";

import { getAmuletHoldings, getHoldings } from "@/lib/canton";
import {
  getTransferAsset,
  parseTransferAssetId,
  type CantonTransferAssetId
} from "@/lib/canton-assets";
import { getDsoPartyId } from "@/lib/cc-registry";
import { NETWORK } from "@/lib/constants";
import { formatSatoshis, parseBtc } from "@/lib/format";
import { DEFAULT_TRANSFER_EXPIRATION_SECONDS } from "@/lib/transfer-options";
import { requireManagedTransferSession } from "@/lib/transfer-session";
import { createTransfer } from "@/lib/transfer";

const TAG = "[transfers/create]";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  console.log(`${TAG} request received`);

  const session = await requireManagedTransferSession();
  if (session.error) return session.error;
  const senderParty = session.partyId;

  let body: {
    recipient?: unknown;
    amount?: unknown;
    amountBtc?: unknown;
    asset?: unknown;
    memo?: unknown;
    expirationSeconds?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const recipient = typeof body.recipient === "string" ? body.recipient.trim() : "";
  const amountRaw =
    typeof body.amount === "string"
      ? body.amount.trim()
      : typeof body.amountBtc === "string"
        ? body.amountBtc.trim()
        : "";

  const assetId: CantonTransferAssetId =
    parseTransferAssetId(body.asset) ?? "CBTC";
  const asset = getTransferAsset(assetId);

  if (!recipient || !recipient.includes("::")) {
    return NextResponse.json(
      { error: "recipient must be a Canton party id (includes '::')" },
      { status: 400 }
    );
  }
  if (recipient === senderParty) {
    return NextResponse.json(
      { error: "Cannot transfer to yourself" },
      { status: 400 }
    );
  }

  let amountSats: bigint;
  try {
    amountSats = parseBtc(amountRaw);
  } catch {
    return NextResponse.json(
      { error: "amount must be a valid decimal amount" },
      { status: 400 }
    );
  }
  if (amountSats <= 0n) {
    return NextResponse.json(
      { error: "amount must be greater than zero" },
      { status: 400 }
    );
  }
  const amount = formatSatoshis(amountSats);
  const memo = typeof body.memo === "string" ? body.memo.trim() : undefined;
  let expirationSeconds = DEFAULT_TRANSFER_EXPIRATION_SECONDS;
  if (body.expirationSeconds != null) {
    const n = Number(body.expirationSeconds);
    if (!Number.isFinite(n) || n < 60 || n > 72 * 3600) {
      return NextResponse.json(
        { error: "expirationSeconds must be between 60 and 259200" },
        { status: 400 }
      );
    }
    expirationSeconds = Math.floor(n);
  }

  try {
    if (assetId === "CBTC") {
      const allHoldings = await getHoldings(senderParty);
      const unlocked = allHoldings.filter(
        (h) =>
          h.payload.instrumentId.id === NETWORK.instrumentId.id &&
          h.payload.instrumentId.admin === NETWORK.instrumentId.admin &&
          (h.payload.lock === null || h.payload.lock === undefined)
      );

      const result = await createTransfer({
        senderParty,
        receiverParty: recipient,
        amountBtc: amount,
        inputHoldings: unlocked,
        memo,
        expirationSeconds,
        assetSymbol: asset.symbol
      });
      return NextResponse.json(result);
    }

    const dsoParty = await getDsoPartyId();
    const amuletHoldings = await getAmuletHoldings(senderParty);
    const instrumentId = { admin: dsoParty, id: "Amulet" as const };

    const result = await createTransfer({
      senderParty,
      receiverParty: recipient,
      amountBtc: amount,
      inputHoldings: amuletHoldings,
      memo,
      expirationSeconds,
      instrumentId,
      registrarAdmin: dsoParty,
      registryKind: "cc",
      assetSymbol: asset.symbol
    });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${TAG} createTransfer failed:`, err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

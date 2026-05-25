/**
 * POST /api/mint/bitcoin-address
 *
 * Server-side proxy for coordinator /app/get-bitcoin-address.
 * Coordinator blocks direct browser calls with CORS — must go through server.
 *
 * Body: { depositAccountContractId: string }
 * Response: { address: string }
 */

import { NextRequest, NextResponse } from "next/server";

import { getBitcoinAddress } from "@/lib/bitsafe";

const TAG = "[mint/bitcoin-address]";

export async function POST(req: NextRequest) {
  console.log(`${TAG} request received`);

  try {
    const { depositAccountContractId } = await req.json() as { depositAccountContractId?: string };

    if (!depositAccountContractId) {
      console.error(`${TAG} missing depositAccountContractId`);
      return NextResponse.json({ error: "depositAccountContractId required" }, { status: 400 });
    }

    console.log(`${TAG} depositAccountContractId=${depositAccountContractId.slice(0, 30)}...`);
    const address = await getBitcoinAddress(depositAccountContractId);
    console.log(`${TAG} bitcoin address=${address}`);

    return NextResponse.json({ address });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${TAG} error:`, err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

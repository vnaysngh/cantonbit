/**
 * GET /api/mint/account-contract-rules
 *
 * Server-side proxy for coordinator /app/get-account-contract-rules.
 * Coordinator blocks direct browser calls with CORS — must go through server.
 *
 * Response: { da_rules: CoordinatorContract, wa_rules: CoordinatorContract }
 */

import { NextResponse } from "next/server";

import { getAccountContractRules } from "@/lib/bitsafe";

const TAG = "[mint/account-contract-rules]";

export async function GET() {
  console.log(`${TAG} request received`);

  try {
    const rules = await getAccountContractRules();
    console.log(`${TAG} da_rules contractId=${rules.da_rules.contract_id}`);
    console.log(`${TAG} wa_rules contractId=${rules.wa_rules.contract_id}`);
    return NextResponse.json(rules);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${TAG} error:`, err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

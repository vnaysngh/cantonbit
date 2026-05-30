/**
 * POST /api/redeem/find-withdraw-account
 *
 * Server-side handler for checking if the user already has a CBTCWithdrawAccount
 * for a given destination address. Queries LEDGER_HOST directly (m2m JWT).
 *
 * Body: { partyId: string; destinationBtcAddress: string }
 * Response: { contractId: string; createdEventBlob: string } | { contractId: null }
 */

import { NextRequest, NextResponse } from "next/server";

import { getLedgerJwt, invalidateLedgerJwtCache } from "@/lib/auth";
import { getAccountContractRules } from "@/lib/bitsafe";
import { captureReset, captureStep } from "@/lib/burn-capture";
import { NETWORK } from "@/lib/constants";

// active-contracts TemplateFilter requires package NAME alias, not hash.
// "#cbtc" alias is confirmed working via live test against the mainnet ledger.
const WITHDRAW_ACCOUNT_TEMPLATE_ID =
  "#cbtc:CBTC.WithdrawAccount:CBTCWithdrawAccount";

const TAG = "[redeem/find-withdraw-account]";

export async function POST(req: NextRequest) {
  console.log(`${TAG} request received`);

  try {
    const { partyId, destinationBtcAddress } = await req.json() as {
      partyId?: string;
      destinationBtcAddress?: string;
    };

    if (!partyId || !destinationBtcAddress) {
      console.error(`${TAG} missing partyId or destinationBtcAddress`);
      return NextResponse.json(
        { error: "partyId and destinationBtcAddress required" },
        { status: 400 },
      );
    }

    console.log(`${TAG} partyId=${partyId.slice(0, 30)}... btcAddress=${destinationBtcAddress}`);
    console.log(`${TAG} network=${NETWORK.name} ledgerHost=${NETWORK.ledgerHost}`);

    const queryLedger = async (token: string) => {
      // Get ledger end offset
      console.log(`${TAG} fetching ledger end offset...`);
      const ledgerEndRes = await fetch(`${NETWORK.ledgerHost}/v2/state/ledger-end`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      console.log(`${TAG} ledger-end status=${ledgerEndRes.status}`);
      if (ledgerEndRes.status === 401) return { status: 401 as const };
      if (!ledgerEndRes.ok) throw new Error(`getLedgerEnd failed (${ledgerEndRes.status})`);
      const { offset } = await ledgerEndRes.json() as { offset?: number };
      console.log(`${TAG} ledger end offset=${offset}`);

      const body = {
        filter: {
          filtersByParty: {
            [partyId]: {
              cumulative: [
                {
                  identifierFilter: {
                    TemplateFilter: {
                      value: {
                        templateId: WITHDRAW_ACCOUNT_TEMPLATE_ID,
                        includeCreatedEventBlob: true,
                      },
                    },
                  },
                },
              ],
            },
          },
        },
        verbose: false,
        activeAtOffset: offset ?? 0,
      };

      console.log(`${TAG} querying active-contracts for CBTCWithdrawAccount...`);
      const res = await fetch(`${NETWORK.ledgerHost}/v2/state/active-contracts`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        cache: "no-store",
      });

      console.log(`${TAG} active-contracts status=${res.status}`);
      if (res.status === 401) return { status: 401 as const };
      if (!res.ok) {
        const text = await res.text().catch(() => "<no body>");
        throw new Error(`active-contracts failed (${res.status}): ${text}`);
      }

      // The v2 active-contracts endpoint returns a plain JSON array, not a wrapped object.
      const raw = await res.json() as unknown;
      const entries = Array.isArray(raw) ? raw : ((raw as { contractEntries?: unknown[] }).contractEntries ?? (raw as { result?: unknown[] }).result ?? []);
      console.log(`${TAG} found ${entries.length} CBTCWithdrawAccount entries`);
      return { status: 200 as const, entries };
    };

    console.log(`${TAG} fetching JWT...`);
    let jwt = await getLedgerJwt();
    console.log(`${TAG} JWT obtained, length=${jwt.length}`);

    let result = await queryLedger(jwt);

    if (result.status === 401) {
      console.warn(`${TAG} 401 from ledger — invalidating JWT cache and retrying...`);
      invalidateLedgerJwtCache();
      jwt = await getLedgerJwt();
      result = await queryLedger(jwt);
      if (result.status === 401) {
        console.error(`${TAG} still 401 after JWT refresh — auth failure`);
        return NextResponse.json({ error: "Authentication failed — JWT invalid after refresh" }, { status: 401 });
      }
    }

    const entries = result.entries ?? [];

    // Determine the CURRENT withdraw-account package from the coordinator's
    // wa_rules. We must only reuse a withdraw account on the SAME package — a
    // stale older-package account (e.g. f240dd5d) has a different Withdraw
    // choice that throws "Credential CIDs required" at burn time. If the only
    // existing account is stale, we ignore it and let the caller create a fresh
    // one (which will be on the current package).
    let currentWaPackage: string | null = null;
    try {
      const rules = await getAccountContractRules();
      // template_id is "<packageHash>:CBTC.WithdrawAccount:CBTCWithdrawAccountRules"
      currentWaPackage = rules.wa_rules.template_id.split(":")[0] || null;
      console.log(`${TAG} current wa package=${currentWaPackage?.slice(0, 12)}...`);
    } catch (e) {
      console.warn(`${TAG} could not fetch current wa package (will not filter by version):`, e);
    }

    for (const entry of entries) {
      // Ledger v2 response: entry.contractEntry.JsActiveContract.createdEvent
      const e = entry as {
        contractEntry?: {
          JsActiveContract?: {
            createdEvent?: {
              contractId?: string;
              templateId?: string;
              createArgument?: Record<string, unknown>;
              createdEventBlob?: string;
            };
          };
        };
        JsActiveContract?: {
          createdEvent?: {
            contractId?: string;
            templateId?: string;
            createArgument?: Record<string, unknown>;
            createdEventBlob?: string;
          };
        };
      };
      const ev =
        e.contractEntry?.JsActiveContract?.createdEvent ??
        e.JsActiveContract?.createdEvent;
      if (!ev?.contractId) continue;

      const arg = ev.createArgument ?? {};
      const owner = arg.owner as string | undefined;
      const addr = arg.destinationBtcAddress as string | undefined;

      console.log(`${TAG} checking contract=${ev.contractId.slice(0, 20)}... owner=${String(owner).slice(0, 20)}... addr=${addr}`);

      if (owner && owner !== partyId) continue;
      if (addr !== destinationBtcAddress) continue;

      // Skip stale-package accounts. The deployed current package's Withdraw
      // choice takes {tokens, amount}; older packages demand credentials and
      // fail the burn. Only reuse an account on the current package.
      const evPackage = ev.templateId?.split(":")[0] ?? "";
      if (currentWaPackage && evPackage !== currentWaPackage) {
        console.log(`${TAG} skipping stale-package withdraw account ${ev.contractId.slice(0, 16)} (pkg=${evPackage.slice(0, 12)} != current ${currentWaPackage.slice(0, 12)})`);
        continue;
      }

      // ── FIND DIFF LOG ──────────────────────────────────────────────────
      // The UI REUSES this existing account for the burn. Its templateId +
      // blob must be a consistent pair (both from this ACS row). If the UI
      // reuses a stale-package account, the burn behaves differently than a
      // freshly-created one — this log makes that visible.
      console.log(`${TAG} ===== FIND DIFF LOG (REUSING existing account) =====`);
      console.log(`${TAG} reuse.contractId=${ev.contractId}`);
      console.log(`${TAG} reuse.templateId=${ev.templateId}`);
      console.log(`${TAG} reuse.package=${(ev.templateId ?? "").split(":")[0]}`);
      console.log(`${TAG} reuse.createdEventBlob.length=${(ev.createdEventBlob ?? "").length}`);
      console.log(`${TAG} ===================================================`);
      // FULL CAPTURE: the UI is REUSING this account (create-withdraw-account
      // won't run), so start the snapshot here with auth + the reused account.
      await captureReset({ party: partyId, btcAddress: destinationBtcAddress, path: "REUSE existing account" });
      let jwtClaims: Record<string, unknown> = {};
      try {
        jwtClaims = JSON.parse(Buffer.from(jwt.split(".")[1], "base64").toString());
      } catch { /* ignore */ }
      await captureStep("auth", {
        scope: process.env.KEYCLOAK_SCOPE ?? "daml_ledger_api",
        clientId: process.env.KEYCLOAK_CLIENT_ID,
        jwtLength: jwt.length,
        jwtClaims,
      });
      await captureStep("fetchAccountFromACS", {
        foundContractId: ev.contractId,
        templateId: ev.templateId ?? "",
        package: (ev.templateId ?? "").split(":")[0],
        createdEventBlobLength: (ev.createdEventBlob ?? "").length,
        createdEventBlob: ev.createdEventBlob ?? "",
        reused: true,
      });
      return NextResponse.json({
        contractId: ev.contractId,
        templateId: ev.templateId ?? "",
        createdEventBlob: ev.createdEventBlob ?? "",
      });
    }

    console.log(`${TAG} no matching withdraw account found for btcAddress=${destinationBtcAddress}`);
    return NextResponse.json({ contractId: null });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${TAG} unexpected error:`, err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

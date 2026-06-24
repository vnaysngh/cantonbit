#!/usr/bin/env npx tsx
/** Audit the last N swap orders (C2C + HTLC) against ledger proof and design invariants. */
import Module from "node:module";

const origRequire = Module.prototype.require;
Module.prototype.require = function (id: string, ...rest: unknown[]) {
  if (id === "server-only") return {};
  return origRequire.call(this, id, ...rest);
};

const LIMIT = Number.parseInt(process.argv[2] ?? "10", 10);

type UnifiedOrder =
  | { kind: "c2c"; createdAt: string; row: Record<string, unknown> }
  | { kind: "htlc"; createdAt: string; row: Record<string, unknown> };

type AuditFinding = {
  severity: "ok" | "warn" | "fail";
  check: string;
  detail: string;
};

async function supabaseGet(
  table: string,
  query: string
): Promise<Record<string, unknown>[]> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const r = await fetch(`${url}/rest/v1/${table}?${query}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    cache: "no-store"
  });
  if (!r.ok) throw new Error(`${table} fetch failed (${r.status})`);
  return (await r.json()) as Record<string, unknown>[];
}

async function fetchLastOrders(limit: number): Promise<UnifiedOrder[]> {
  const [c2c, htlc] = await Promise.all([
    supabaseGet(
      "canton_swap_orders",
      `select=*&order=created_at.desc&limit=${limit}`
    ),
    supabaseGet("htlc_orders", `select=*&order=created_at.desc&limit=${limit}`)
  ]);
  const merged: UnifiedOrder[] = [
    ...c2c.map((row) => ({
      kind: "c2c" as const,
      createdAt: String(row.created_at),
      row
    })),
    ...htlc.map((row) => ({
      kind: "htlc" as const,
      createdAt: String(row.created_at),
      row
    }))
  ];
  merged.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return merged.slice(0, limit);
}

function partyTag(p: string): string {
  return p.includes("::") ? `${p.split("::")[0]?.slice(0, 16)}…` : p.slice(0, 16);
}

async function auditC2c(row: Record<string, unknown>): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];
  const {
    c2cVisibleCompleted,
    c2cCounterLegProofPresent
  } = await import("../lib/swap-product-invariants.js");
  const { projectC2cStatus } = await import("../lib/swap-status-projector.js");
  const {
    counterLegDeliveredToUserInEvents,
    counterOfferConsumedInEvents
  } = await import("../lib/canton-swap-leg-verify-logic.js");
  const { fetchUpdateEventsById } = await import(
    "../lib/canton-swap-leg-verify.js"
  );
  const { getSwapAsset } = await import("../lib/canton-assets.js");
  const { cantonSwapCounterLegMemo } = await import("../lib/swap-transfer-memo.js");
  const { swapParty } = await import("../lib/canton-swap-types.js");

  const id = String(row.id);
  const status = String(row.status);
  const user = String(row.user_party);
  const vault = String(row.settlement_party ?? row.solver_party);
  const fromAsset = String(row.from_asset);
  const toAsset = String(row.to_asset);
  const walletMode = String(row.wallet_mode);

  const proofInput = {
    status: status as import("../lib/canton-swap-types.js").CantonSwapOrder["status"],
    settlementUpdateId: row.settlement_update_id as string | undefined,
    counterLegOfferCid: row.counter_leg_offer_cid as string | undefined,
    counterReceiptUpdateId: row.counter_receipt_update_id as string | undefined
  };

  const dbProof = c2cCounterLegProofPresent(proofInput);
  const visible = c2cVisibleCompleted(proofInput);
  const projected = projectC2cStatus(proofInput);

  findings.push({
    severity: "ok",
    check: "db_snapshot",
    detail: `${status} ${fromAsset}→${toAsset} loop=${walletMode} in=${row.in_amount} out=${row.out_amount}`
  });

  if (status === "filled") {
    if (!visible) {
      findings.push({
        severity: "fail",
        check: "filled_requires_proof",
        detail: `status=filled but c2cVisibleCompleted=false (offer=${Boolean(row.counter_leg_offer_cid)} receipt=${Boolean(row.counter_receipt_update_id)})`
      });
    } else {
      findings.push({ severity: "ok", check: "filled_requires_proof", detail: "ok" });
    }
    if (projected.label !== "Completed") {
      findings.push({
        severity: "fail",
        check: "ui_projection",
        detail: `projected=${projected.label} expected Completed`
      });
    }
  } else if (status === "user_locked" && row.counter_leg_offer_cid) {
    if (visible) {
      findings.push({
        severity: "fail",
        check: "pending_not_complete",
        detail: "user_locked with pending counter but marked visible complete"
      });
    }
  } else if (["expired", "failed", "cancelled"].includes(status)) {
    findings.push({
      severity: "ok",
      check: "terminal_non_success",
      detail: `expected non-success terminal (${row.failure_reason ?? "no reason"})`
    });
    return findings;
  }

  if (!row.settlement_update_id) {
    if (["open", "filling"].includes(status)) {
      findings.push({
        severity: "ok",
        check: "settlement_update",
        detail: "no settlement yet (in progress)"
      });
    } else if (status === "user_locked" && !row.counter_leg_offer_cid) {
      findings.push({
        severity: "warn",
        check: "settlement_update",
        detail: "user_locked without settlement_update_id or counter offer"
      });
    }
    return findings;
  }

  const settlementUpdateId = String(row.settlement_update_id);
  const eventsById = await fetchUpdateEventsById(settlementUpdateId, [user, vault]);
  if (!eventsById || Object.keys(eventsById).length === 0) {
    findings.push({
      severity: "warn",
      check: "ledger_tree",
      detail: "settlement update not readable from ledger (403/413?) — cannot verify legs"
    });
    return findings;
  }

  const asset = getSwapAsset(toAsset as "CBTC" | "CC" | "USDCX");
  const createdAtSec = Math.floor(new Date(String(row.created_at)).getTime() / 1000);
  const counterMemo = cantonSwapCounterLegMemo(
    {
      id,
      fromAsset: fromAsset as "CBTC" | "CC" | "USDCX",
      toAsset: toAsset as "CBTC" | "CC" | "USDCX",
      inAmount: String(row.in_amount),
      outAmount: String(row.out_amount),
      userParty: user,
      solverParty: String(row.solver_party),
      settlementParty: vault,
      walletMode: walletMode as "loop" | "managed",
      status: status as import("../lib/canton-swap-types.js").CantonSwapOrder["status"],
      createdAt: createdAtSec
    },
    row.counter_reissue_attempt ? Number(row.counter_reissue_attempt) : 0
  );

  const counterDelivered = counterLegDeliveredToUserInEvents(eventsById, {
    senderParty: swapParty({
      id,
      solverParty: String(row.solver_party),
      settlementParty: vault,
      userParty: user,
      fromAsset: fromAsset as "CBTC",
      toAsset: toAsset as "CC",
      inAmount: String(row.in_amount),
      outAmount: String(row.out_amount),
      walletMode: walletMode as "loop",
      status: "filled",
      createdAt: createdAtSec
    } as import("../lib/canton-swap-types.js").CantonSwapOrder),
    receiverParty: user,
    amount: String(row.out_amount),
    amountDecimals: asset.decimals,
    expectedInstrument: asset.instrumentId,
    expectedMemo: counterMemo
  });

  const vaultGotSell = Object.values(eventsById).some((node) => {
        const created = (node as { CreatedTreeEvent?: { value?: { createArgument?: { owner?: string; amount?: string; instrument?: { id?: string }; instrumentId?: { id?: string } } } } })
          ?.CreatedTreeEvent?.value;
        if (!created?.createArgument?.owner) return false;
        if (created.createArgument.owner !== vault) return false;
        const inst =
          created.createArgument.instrumentId?.id ??
          created.createArgument.instrument?.id;
        return inst === fromAsset || (fromAsset === "CC" && inst === "Amulet");
      });

  if (vaultGotSell || eventsById) {
    const acceptUserLeg = Object.values(eventsById).some(
      (node) =>
        (node as { ExercisedTreeEvent?: { value?: { choice?: string } } })
          ?.ExercisedTreeEvent?.value?.choice === "TransferInstruction_Accept"
    );
    findings.push({
      severity: acceptUserLeg || vaultGotSell ? "ok" : "warn",
      check: "user_sell_consumed",
      detail: acceptUserLeg
        ? "vault exercised TransferInstruction_Accept on user sell leg"
        : vaultGotSell
          ? "vault received sell-asset holding in fill tx"
          : "could not confirm user sell leg consumption in tree"
    });
  }

  if (row.counter_leg_offer_cid && !row.counter_receipt_update_id) {
    findings.push({
      severity: status === "user_locked" ? "ok" : "warn",
      check: "counter_pending",
      detail: `pending counter offer ${String(row.counter_leg_offer_cid).slice(0, 16)}… — user must accept`
    });
    return findings;
  }

  if (status === "filled") {
    if (counterDelivered) {
      findings.push({
        severity: "ok",
        check: "counter_to_user",
        detail: `ledger proves ${toAsset} delivered to ${partyTag(user)}`
      });
    } else if (row.counter_receipt_update_id && row.counter_leg_offer_cid) {
      const acceptEvents = await fetchUpdateEventsById(
        String(row.counter_receipt_update_id),
        [user, vault]
      );
      const consumed = acceptEvents
        ? counterOfferConsumedInEvents(
            acceptEvents,
            String(row.counter_leg_offer_cid)
          )
        : false;
      findings.push({
        severity: consumed ? "ok" : "fail",
        check: "counter_accept",
        detail: consumed
          ? "counter offer accept proven on ledger"
          : "counter receipt update id present but accept not found in tree"
      });
    } else if (row.counter_receipt_update_id && !row.counter_leg_offer_cid) {
      findings.push({
        severity: counterDelivered ? "ok" : "fail",
        check: "direct_counter_receipt",
        detail: counterDelivered
          ? "direct delivery + counterReceiptUpdateId"
          : "counterReceiptUpdateId set but ledger does not prove user delivery"
      });
    } else {
      findings.push({
        severity: "fail",
        check: "counter_to_user",
        detail: "filled but no ledger proof of counter delivery"
      });
    }

    if (dbProof && !counterDelivered && !row.counter_leg_offer_cid) {
      findings.push({
        severity: counterDelivered ? "ok" : "fail",
        check: "db_vs_ledger",
        detail: dbProof
          ? "DB proof fields present"
          : "DB proof fields missing"
      });
    }
  }

  return findings;
}

async function auditHtlc(row: Record<string, unknown>): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];
  const { htlcVisibleCompleted, htlcCanMarkComplete } = await import(
    "../lib/swap-product-invariants.js"
  );
  const { projectHtlcStatus } = await import("../lib/swap-status-projector.js");
  const { fetchUpdateEventsById } = await import(
    "../lib/canton-swap-leg-verify.js"
  );

  const id = String(row.id);
  const status = String(row.status);
  const direction = String(row.direction);
  const counterMode = String(row.counter_mode ?? "managed");

  const htlcPick = {
    status: status as import("../lib/htlc-types.js").SwapOrder["status"],
    direction: direction as import("../lib/htlc-types.js").SwapOrder["direction"],
    counterMode: counterMode as import("../lib/htlc-types.js").SwapOrder["counterMode"],
    revealedPreimage: row.revealed_preimage as string | undefined,
    counterTransferUpdateId: row.counter_transfer_update_id as string | undefined,
    counterClaimUpdateId: row.counter_claim_update_id as string | undefined,
    mainClaimTx: row.main_claim_tx as string | undefined
  };

  findings.push({
    severity: "ok",
    check: "db_snapshot",
    detail: `${status} ${direction} mode=${counterMode} cbtc=${row.cbtc_amount} wbtc=${row.wbtc_amount}`
  });

  if (status === "main_claimed") {
    const complete = htlcCanMarkComplete(htlcPick);
    const visible = htlcVisibleCompleted(htlcPick);
    const projected = projectHtlcStatus({
      ...htlcPick,
      counterTransferOfferCid: row.counter_transfer_offer_cid as string | undefined
    });
    findings.push({
      severity: complete.ok ? "ok" : "fail",
      check: "htlc_completion",
      detail: complete.ok ? "htlcCanMarkComplete ok" : complete.reason
    });
    findings.push({
      severity: visible ? "ok" : "fail",
      check: "htlc_visible",
      detail: visible ? "ok" : "visible complete false"
    });
    if (projected.label === "Completed") {
      findings.push({ severity: "ok", check: "ui_projection", detail: "Completed" });
    } else {
      findings.push({
        severity: "fail",
        check: "ui_projection",
        detail: `projected=${projected.label}`
      });
    }
  } else if (["refunded", "cancelled", "failed"].includes(status)) {
    findings.push({
      severity: "ok",
      check: "terminal_non_success",
      detail: String(row.failure_reason ?? status)
    });
    return findings;
  } else {
    findings.push({
      severity: "ok",
      check: "in_progress",
      detail: `non-terminal status ${status}`
    });
  }

  const user = String(row.user_canton_party);
  const solver = String(row.solver_canton_party);

  if (direction === "evm-to-canton" && counterMode === "loop") {
    const deliveryId = row.counter_transfer_update_id as string | undefined;
    const acceptId = row.counter_claim_update_id as string | undefined;
    if (status === "main_claimed") {
      if (!deliveryId || !acceptId) {
        findings.push({
          severity: "fail",
          check: "loop_forward_proof",
          detail: `missing delivery=${Boolean(deliveryId)} accept=${Boolean(acceptId)}`
        });
      } else {
        findings.push({
          severity: "ok",
          check: "loop_forward_proof",
          detail: "counterTransferUpdateId + counterClaimUpdateId present"
        });
      }
    }
  }

  if (direction === "canton-to-evm" && counterMode === "loop") {
    const custodyId = row.counter_transfer_update_id as string | undefined;
    if (status === "main_claimed") {
      findings.push({
        severity: custodyId ? "ok" : "fail",
        check: "reverse_custody",
        detail: custodyId
          ? "counter custody transfer update recorded"
          : "missing counter_transfer_update_id"
      });
      const userWbtcTx = row.main_claim_tx as string | undefined;
      findings.push({
        severity: userWbtcTx ? "ok" : "fail",
        check: "user_wbtc_claim",
        detail: userWbtcTx ? String(userWbtcTx).slice(0, 18) + "…" : "missing main_claim_tx"
      });
    }
  }

  const claimUpdate = row.counter_claim_update_id as string | undefined;
  if (claimUpdate && direction === "evm-to-canton" && counterMode === "managed") {
    const events = await fetchUpdateEventsById(claimUpdate, [user, solver]);
    findings.push({
      severity: events ? "ok" : "warn",
      check: "managed_claim_tree",
      detail: events
        ? `${Object.keys(events).length} events in claim update`
        : "claim update not readable"
    });
  }

  return findings;
}

function printFindings(
  order: UnifiedOrder,
  findings: AuditFinding[]
): boolean {
  const row = order.row;
  const id = String(row.id);
  const fails = findings.filter((f) => f.severity === "fail");
  const warns = findings.filter((f) => f.severity === "warn");
  const ok = !fails.length;

  console.log(`\n${"=".repeat(72)}`);
  console.log(
    `${ok ? "PASS" : "FAIL"} | ${order.kind.toUpperCase()} | ${id.slice(0, 36)}${id.length > 36 ? "…" : ""}`
  );
  console.log(`created: ${order.createdAt}`);
  for (const f of findings) {
    const icon =
      f.severity === "ok" ? "✓" : f.severity === "warn" ? "!" : "✗";
    console.log(`  ${icon} [${f.check}] ${f.detail}`);
  }
  if (warns.length) console.log(`  (${warns.length} warning(s))`);
  return ok;
}

async function main() {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing Supabase env (use --env-file=.env.development.local)");
  }

  console.log(`=== Last ${LIMIT} swap orders audit ===\n`);
  const orders = await fetchLastOrders(LIMIT);
  if (!orders.length) {
    console.log("No orders found.");
    return;
  }

  let passed = 0;
  const failedIds: string[] = [];

  for (const order of orders) {
    const findings =
      order.kind === "c2c"
        ? await auditC2c(order.row)
        : await auditHtlc(order.row);
    if (printFindings(order, findings)) passed++;
    else failedIds.push(String(order.row.id));
  }

  console.log(`\n${"=".repeat(72)}`);
  console.log(`SUMMARY: ${passed}/${orders.length} passed`);
  if (failedIds.length) {
    console.log("FAILED:", failedIds.join(", "));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

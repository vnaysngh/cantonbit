#!/usr/bin/env npx tsx
/** One-off: print C2C order proof fields. */
import Module from "node:module";

const origRequire = Module.prototype.require;
Module.prototype.require = function (id: string, ...rest: unknown[]) {
  if (id === "server-only") return {};
  return origRequire.call(this, id, ...rest);
};

const orderId = process.argv[2];
if (!orderId) {
  console.error("Usage: trace-c2c-order-once.mts <orderId>");
  process.exit(1);
}

async function main() {
  const { c2cVisibleCompleted, c2cCounterLegProofPresent } = await import(
    "../lib/swap-product-invariants.js"
  );
  const { projectC2cStatus } = await import("../lib/swap-status-projector.js");

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const r = await fetch(
    `${supabaseUrl}/rest/v1/canton_swap_orders?id=eq.${encodeURIComponent(orderId)}&select=*`,
    {
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`
      },
      cache: "no-store"
    }
  );
  const rows = (await r.json()) as Record<string, unknown>[];
  const o = rows[0];
  if (!o) throw new Error(`Order not found: ${orderId}`);

  const mapped = {
    id: o.id,
    status: o.status,
    walletMode: o.wallet_mode,
    fromAsset: o.from_asset,
    toAsset: o.to_asset,
    inAmount: o.in_amount,
    outAmount: o.out_amount,
    userLegOfferCid: o.user_leg_offer_cid,
    settlementUpdateId: o.settlement_update_id,
    counterLegOfferCid: o.counter_leg_offer_cid,
    counterReceiptUpdateId: o.counter_receipt_update_id,
    failureReason: o.failure_reason,
    createdAt: o.created_at
  };

  console.log("\n=== C2C Order ===");
  console.log(JSON.stringify(mapped, null, 2));

  const proof = {
    counterLegProofPresent: c2cCounterLegProofPresent({
      status: String(o.status),
      settlementUpdateId: o.settlement_update_id as string | undefined,
      counterLegOfferCid: o.counter_leg_offer_cid as string | undefined,
      counterReceiptUpdateId: o.counter_receipt_update_id as string | undefined
    }),
    visibleCompleted: c2cVisibleCompleted({
      status: String(o.status),
      settlementUpdateId: o.settlement_update_id as string | undefined,
      counterLegOfferCid: o.counter_leg_offer_cid as string | undefined,
      counterReceiptUpdateId: o.counter_receipt_update_id as string | undefined
    }),
    projected: projectC2cStatus({
      status: String(o.status),
      settlementUpdateId: o.settlement_update_id as string | undefined,
      counterLegOfferCid: o.counter_leg_offer_cid as string | undefined,
      counterReceiptUpdateId: o.counter_receipt_update_id as string | undefined
    })
  };
  console.log("\n=== Proof projection ===");
  console.log(JSON.stringify(proof, null, 2));

  if (o.settlement_update_id) {
    const { fetchUpdateEventsById } = await import(
      "../lib/canton-swap-leg-verify.js"
    );
    const user = String(o.user_party);
    const solver = String(o.settlement_party ?? o.solver_party);
    const events = await fetchUpdateEventsById(String(o.settlement_update_id), [
      user,
      solver
    ]);
    console.log(
      "\n=== Settlement tree events ===",
      events ? Object.keys(events).length : null
    );
    if (events) {
      console.log(
        JSON.stringify(events, null, 2).slice(0, 15000)
      );
      const { buildLoopFillResultFromEvents, counterLegDeliveredToUserInEvents } =
        await import("../lib/canton-swap-leg-verify-logic.js");
      const { getSwapAsset } = await import("../lib/canton-assets.js");
      const toAsset = String(o.to_asset) as "CBTC" | "CC" | "USDCX";
      const asset = getSwapAsset(toAsset);
      let parsed;
      try {
        parsed = buildLoopFillResultFromEvents(
        {
          id: String(o.id),
          fromAsset: String(o.from_asset) as "CBTC" | "CC" | "USDCX",
          toAsset,
          inAmount: String(o.in_amount),
          outAmount: String(o.out_amount),
          userParty: user,
          solverParty: solver,
          settlementParty: solver,
          walletMode: String(o.wallet_mode) as "loop" | "managed",
          status: String(o.status) as CantonSwapOrder["status"]
        } as import("../lib/canton-swap-types.js").CantonSwapOrder,
        String(o.settlement_update_id),
        events,
        "unknown",
        asset.instrumentId
        );
      } catch (e) {
        parsed = {
          error: e instanceof Error ? e.message : String(e)
        };
      }
      console.log(JSON.stringify(parsed, null, 2));
      for (const [id, node] of Object.entries(events)) {
        const ex = (node as { ExercisedTreeEvent?: { value?: { choice?: string } } })
          ?.ExercisedTreeEvent?.value;
        const created = (node as { CreatedTreeEvent?: { value?: { templateId?: string } } })
          ?.CreatedTreeEvent?.value;
        if (ex?.choice) console.log("EX", id, ex.choice);
        if (created?.templateId)
          console.log("CR", id, created.templateId.split(":").slice(-2).join(":"));
      }
      const { cantonSwapCounterLegMemo } = await import(
        "../lib/swap-transfer-memo.js"
      );
      const memo = cantonSwapCounterLegMemo(
        {
          id: String(o.id),
          fromAsset: String(o.from_asset) as "CBTC" | "CC" | "USDCX",
          toAsset,
          inAmount: String(o.in_amount),
          outAmount: String(o.out_amount),
          userParty: user,
          solverParty: solver,
          settlementParty: solver,
          walletMode: String(o.wallet_mode) as "loop" | "managed",
          status: String(o.status) as import("../lib/canton-swap-types.js").CantonSwapOrder["status"]
        },
        0
      );
      console.log("\n=== SendV2 event ===");
      const sendV2Entry = Object.entries(events).find(
        ([, node]) =>
          (node as { ExercisedTreeEvent?: { value?: { choice?: string } } })
            ?.ExercisedTreeEvent?.value?.choice === "TransferPreapproval_SendV2"
      );
      if (sendV2Entry) {
        console.log("node", sendV2Entry[0]);
        const val = (sendV2Entry[1] as { ExercisedTreeEvent?: { value?: unknown } })
          ?.ExercisedTreeEvent?.value as {
          choiceArgument?: { amount?: string; description?: string; sender?: string };
          exerciseResult?: {
            result?: { summary?: { balanceChanges?: unknown } };
          };
        };
        console.log("amount", val?.choiceArgument?.amount);
        console.log("descriptionMatch", val?.choiceArgument?.description === memo);
        console.log(
          "balanceChanges",
          JSON.stringify(val?.exerciseResult?.result?.summary?.balanceChanges, null, 2)
        );
      }
      console.log("\n=== Direct delivery proven? ===");
      console.log(
        counterLegDeliveredToUserInEvents(events, {
          senderParty: solver,
          receiverParty: user,
          amount: String(o.out_amount),
          amountDecimals: asset.decimals,
          expectedInstrument: asset.instrumentId,
          expectedMemo: memo
        })
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

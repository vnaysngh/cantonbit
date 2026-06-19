#!/usr/bin/env npx tsx
/** One-off: trace ledger txs for an HTLC order id. */
import Module from "node:module";

const origRequire = Module.prototype.require;
Module.prototype.require = function (id: string, ...rest: unknown[]) {
  if (id === "server-only") return {};
  return origRequire.call(this, id, ...rest);
};

const orderId = process.argv[2];
if (!orderId) {
  console.error("Usage: trace-htlc-order-once.mts <orderId>");
  process.exit(1);
}

function isEvmTxHash(s: string | undefined): s is string {
  return !!s && /^0x[0-9a-fA-F]{64}$/.test(s);
}

function cantonClaimUpdateId(order: {
  direction?: string;
  counter_claim_update_id?: string;
}): string | undefined {
  const c = order.counter_claim_update_id;
  if (!c) return undefined;
  if (order.direction === "canton-to-evm" && isEvmTxHash(c)) return undefined;
  return c;
}

function userWbtcClaimTx(order: {
  direction?: string;
  main_claim_tx?: string;
  counter_claim_update_id?: string;
}): string | undefined {
  if (order.direction !== "canton-to-evm") return undefined;
  if (isEvmTxHash(order.main_claim_tx)) return order.main_claim_tx;
  if (isEvmTxHash(order.counter_claim_update_id))
    return order.counter_claim_update_id;
  return undefined;
}

async function main() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const r = await fetch(
    `${supabaseUrl}/rest/v1/htlc_orders?id=eq.${encodeURIComponent(orderId)}&select=*`,
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

  const { fetchTransactionTreeByUpdateId } = await import(
    "../lib/canton-command-recovery.js"
  );

  const user = String(o.user_canton_party);
  const vault = String(o.solver_canton_party);
  const direction = o.direction as string | undefined;
  const claimUpdate = cantonClaimUpdateId({
    direction,
    counter_claim_update_id: o.counter_claim_update_id as string | undefined
  });
  const userWbtc = userWbtcClaimTx({
    direction,
    main_claim_tx: o.main_claim_tx as string | undefined,
    counter_claim_update_id: o.counter_claim_update_id as string | undefined
  });

  console.log("\n=== Order ===");
  console.log(
    JSON.stringify(
      {
        id: o.id,
        status: o.status,
        direction: o.direction,
        counter_mode: o.counter_mode,
        solver: vault.slice(0, 28) + "…",
        user: user.slice(0, 28) + "…",
        cbtc: o.cbtc_amount,
        wbtc_sats: o.wbtc_amount,
        network_fee_cc: o.network_fee_cc,
        canton_claim_update: claimUpdate?.slice(0, 20) + "…",
        user_wbtc_claim: userWbtc?.slice(0, 20) + "…"
      },
      null,
      2
    )
  );

  if (!claimUpdate) {
    console.log(
      "\nNo Canton claim update on order — claim not recorded yet (or legacy EVM tx only in counter_claim_update_id)."
    );
    return;
  }

  const tree = await fetchTransactionTreeByUpdateId(
    claimUpdate,
    [user, vault],
    20_000
  );
  if (!tree) {
    console.log("\nClaim update not found in party scan (lookback 20k).");
    return;
  }

  const raw = tree as {
    commandId?: string;
    eventsById?: Record<string, unknown>;
    updateId?: string;
  };
  if (!raw.eventsById || Object.keys(raw.eventsById).length === 0) {
    console.log(
      "\nTree found but eventsById empty — dumping keys:",
      Object.keys(tree)
    );
    console.log(JSON.stringify(tree).slice(0, 1200));
  }

  const claimLabel =
    direction === "canton-to-evm"
      ? "Solver CBTC claim (claim-main)"
      : "User CBTC claim (claim-managed)";
  console.log(`\n=== ${claimLabel} ===`);
  console.log("commandId:", raw.commandId ?? "?");

  const events = Object.values(raw.eventsById ?? {});
  console.log("event count:", events.length);
  const exercised: string[] = [];
  const holdings: { owner: string; amount: unknown }[] = [];

  function walkEvent(node: unknown) {
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    const treeEx = n.ExercisedTreeEvent as
      | { value?: { choice?: string; templateId?: string } }
      | undefined;
    const treeCr = n.CreatedTreeEvent as {
      value?: {
        templateId?: string;
        createArgument?: { owner?: string; amount?: unknown };
      };
    } | undefined;
    const ex =
      treeEx?.value ??
      (n.ExercisedEvent as { choice?: string; templateId?: string } | undefined) ??
      (n.event as { ExercisedEvent?: { choice?: string; templateId?: string } })
        ?.ExercisedEvent;
    const cr =
      treeCr?.value ??
      (n.CreatedEvent as {
        templateId?: string;
        createArgument?: { owner?: string; amount?: unknown };
      } | undefined) ??
      (n.event as {
        CreatedEvent?: {
          templateId?: string;
          createArgument?: { owner?: string; amount?: unknown };
        };
      })?.CreatedEvent;
    if (ex?.choice) {
      const tpl = (ex.templateId ?? "").split(":").pop() ?? "?";
      exercised.push(`${tpl}.${ex.choice}`);
    }
    if (cr?.templateId?.includes("Holding") && cr.createArgument?.owner) {
      holdings.push({
        owner:
          cr.createArgument.owner.split("::")[0] ?? cr.createArgument.owner,
        amount: cr.createArgument.amount
      });
    }
  }

  for (const e of events) walkEvent(e);

  console.log("Exercised (in tree order):");
  for (const x of exercised) console.log(" ", x);

  console.log("\nHolding creates:");
  for (const h of holdings) console.log(" ", h);

  console.log("\n=== Verdict ===");
  console.log(
    "TransferInstruction_Accept on claim tx:",
    exercised.some((x) => x.endsWith(".TransferInstruction_Accept"))
  );
  console.log(
    "HtlcLock.Claim on claim tx:",
    exercised.some((x) => x.endsWith(".Claim"))
  );
  console.log(
    "Allocation_ExecuteTransfer on claim tx:",
    exercised.some((x) => x.includes("Allocation_ExecuteTransfer"))
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

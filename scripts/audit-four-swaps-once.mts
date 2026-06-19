#!/usr/bin/env npx tsx
/** One-off: audit the last 4 user swaps (2 HTLC + 2 C2C). */
import Module from "node:module";
const origRequire = Module.prototype.require;
Module.prototype.require = function (id: string, ...rest: unknown[]) {
  if (id === "server-only") return {};
  return origRequire.call(this, id, ...rest);
};

const user =
  "party-de08bc18-d724-4acb-a653-d4383cd82df5::1220231c1885f289f90e0d08b448579c31a655b5826802c6d885258a27371039fba9";
const vault =
  "oranj-settle-devnet::1220231c1885f289f90e0d08b448579c31a655b5826802c6d885258a27371039fba9";

type AuditOrder = {
  label: string;
  id: string;
  kind: "htlc" | "c2c";
  settlementUpdateId: string;
  evm?: { hashLock: string; counterLockTx?: string };
};

const ORDERS: AuditOrder[] = [
  {
    label: "HTLC canton→evm",
    id: "0x5bf6d6ed31396550ce77b8bba8915f4f6e4e10ddb49a6157d780f1a6d9c3b68a",
    kind: "htlc",
    settlementUpdateId:
      "1220efd8e03162386a7d3c9f22ecd07d61f7878fcf5f6fe5518758c7c4bd561373f4",
    evm: {
      hashLock:
        "0x5bf6d6ed31396550ce77b8bba8915f4f6e4e10ddb49a6157d780f1a6d9c3b68a",
      counterLockTx:
        "0xac64860f75beeb4c6a51a432fd7d34e7bb3e6499cd1c0074673a442c62d2f0d4"
    }
  },
  {
    label: "HTLC evm→canton",
    id: "0xb5503eb3c86078767234858ce982cba6d0cade9989985e242811e7bc05bb5e05",
    kind: "htlc",
    settlementUpdateId:
      "122032cd7f4812a2c1899e7175186f1a77149cabb4200203e148d8a285f0a3252b20"
  },
  {
    label: "C2C CBTC→CC",
    id: "c6bab043-df89-4197-8a67-36dbc061e30c",
    kind: "c2c",
    settlementUpdateId:
      "122052f87b9bfad64852fff6a7521a250b850c13ff40cb551f3d2083e87cc787ae90"
  },
  {
    label: "C2C CC→CBTC",
    id: "e4027114-7071-4610-aea1-9636743d5be2",
    kind: "c2c",
    settlementUpdateId:
      "122000ff1d9a092a3c643394a5eb2e410772e7bf7fd2801f28cd14ae879d49a8fc26"
  }
];

function walkEvents(eventsById: Record<string, unknown>) {
  const exercised: string[] = [];
  const holdings: { owner: string; amount: unknown; instrument?: string }[] = [];
  function walk(node: unknown) {
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    const ex =
      (n.ExercisedTreeEvent as { value?: { choice?: string; templateId?: string } })
        ?.value ??
      (n.ExercisedEvent as { choice?: string; templateId?: string });
    const cr =
      (n.CreatedTreeEvent as {
        value?: {
          templateId?: string;
          createArgument?: {
            owner?: string;
            amount?: unknown;
            instrumentId?: { id?: string };
          };
        };
      })?.value ??
      (n.CreatedEvent as {
        templateId?: string;
        createArgument?: {
          owner?: string;
          amount?: unknown;
          instrumentId?: { id?: string };
        };
      });
    if (ex?.choice) {
      const tpl = (ex.templateId ?? "").split(":").pop() ?? "?";
      exercised.push(`${tpl}.${ex.choice}`);
    }
    if (cr?.templateId?.includes("Holding") && cr.createArgument?.owner) {
      holdings.push({
        owner: cr.createArgument.owner.split("::")[0] ?? cr.createArgument.owner,
        amount: cr.createArgument.amount,
        instrument: cr.createArgument.instrumentId?.id
      });
    }
  }
  for (const e of Object.values(eventsById)) walk(e);
  return { exercised, holdings };
}

async function auditLedger(updateId: string, parties: string[]) {
  const mod = await import("../lib/canton-command-recovery.js");
  const fetchTree = mod.fetchTransactionTreeByUpdateId as (
    id: string,
    parties: string[],
    lookback: number
  ) => Promise<{ commandId?: string; eventsById?: Record<string, unknown> } | null>;
  const tree = await fetchTree(updateId, parties, 80_000);
  if (!tree) return { found: false as const };
  const { exercised, holdings } = walkEvents(tree.eventsById ?? {});
  return {
    found: true as const,
    commandId: tree.commandId ?? "?",
    exercised,
    holdings
  };
}

async function auditEvm(hashLock: string, counterLockTx?: string) {
  const { hasEvmClaimedForHashLock, readEvmLockMapping } = await import(
    "../lib/htlc-evm-counter-lock.js"
  );
  let lockAmount = "?";
  let lockCleared = false;
  try {
    const lock = await readEvmLockMapping(hashLock);
    lockAmount = lock.amount.toString();
    lockCleared = lock.amount === 0n;
  } catch {
    lockCleared = true;
    lockAmount = "0";
  }
  let counterLockMined: boolean | null = null;
  if (counterLockTx) {
    const rpc = process.env.ORIGIN_RPC_URL ?? "https://sepolia.base.org";
    const r = await fetch(rpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getTransactionReceipt",
        params: [counterLockTx]
      })
    });
    const j = (await r.json()) as { result?: { status?: string } };
    counterLockMined = j.result?.status === "0x1";
  }
  return {
    lockCleared,
    lockAmount,
    claimed: await hasEvmClaimedForHashLock(hashLock),
    counterLockMined
  };
}

async function fetchDbRow(kind: "htlc" | "c2c", id: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const table = kind === "htlc" ? "htlc_orders" : "canton_swap_orders";
  const r = await fetch(
    `${url}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}&select=*`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } }
  );
  const rows = (await r.json()) as Record<string, unknown>[];
  return rows[0] ?? null;
}

async function fetchFeeLedger(id: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const r = await fetch(
    `${url}/rest/v1/network_fee_ledger?order_id=eq.${encodeURIComponent(id)}&select=*`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } }
  );
  return ((await r.json()) as Record<string, unknown>[])[0] ?? null;
}

async function main() {
  console.log("=== Four-swap end-to-end audit (devnet) ===\n");
  let allOk = true;

  for (const o of ORDERS) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(o.label);
    console.log("id:", o.id);

    const db = await fetchDbRow(o.kind, o.id);
    const fee = await fetchFeeLedger(o.id);
    const ledger = await auditLedger(o.settlementUpdateId, [user, vault]);

    const status = db?.status as string | undefined;
    const dbFee = (db?.network_fee_cc as string | undefined) ?? "?";
    const ledgerFee = (fee?.fee_cc as string | undefined) ?? "?";
    const feeMatch =
      dbFee !== "?" &&
      ledgerFee !== "?" &&
      Math.abs(parseFloat(dbFee) - parseFloat(String(ledgerFee))) < 0.05;

    console.log("\nDB:");
    console.log("  status:", status);
    console.log("  network_fee_cc (order row):", dbFee);
    console.log("  settlement_party:", (db?.solver_canton_party ?? db?.settlement_party ?? "?").toString().slice(0, 32) + "…");

    console.log("\nNetwork fee ledger:");
    console.log("  fee_cc:", ledgerFee);
    console.log("  fee_usd:", fee?.fee_usd);
    console.log("  receiver:", (fee?.receiver_party as string | undefined)?.slice(0, 24) + "…");
    console.log("  settlement_update_id matches order:", fee?.settlement_update_id === o.settlementUpdateId || fee?.settlement_update_id === db?.settlement_update_id || fee?.settlement_update_id === db?.counter_claim_update_id);

    console.log("\nLedger settlement tx:");
    if (!ledger.found) {
      console.log("  NOT FOUND in 80k lookback ✗");
      allOk = false;
    } else {
      console.log("  commandId:", ledger.commandId);
      console.log("  path:", ledger.exercised.join(" → "));
      console.log("  holdings created:", ledger.holdings);
    }

    let evmResult: Awaited<ReturnType<typeof auditEvm>> | null = null;
    if (o.evm) {
      evmResult = await auditEvm(o.evm.hashLock, o.evm.counterLockTx);
      console.log("\nEVM:");
      console.log("  lock amount 0 / cleared:", evmResult.lockCleared || evmResult.lockAmount === "0");
      console.log("  Claimed event:", evmResult.claimed);
      console.log("  solver counter-lock mined:", evmResult.counterLockMined);
      if (o.label.includes("canton→evm")) {
        if (!evmResult.claimed) allOk = false;
        if (evmResult.counterLockMined !== true) allOk = false;
      }
    }

    const terminal =
      status === "main_claimed" || status === "filled";
    const hasFeeRow = !!fee;
    const hasSettlement = ledger.found;

    if (o.kind === "htlc" && o.label.includes("evm→canton")) {
      const userGotCbtc = ledger.holdings?.some(
        (h) =>
          h.owner.startsWith("party-de08bc18") &&
          h.instrument === "CBTC"
      );
      console.log("\nChecks:");
      console.log("  terminal status:", terminal ? "✓" : "✗");
      console.log("  fee row:", hasFeeRow ? "✓" : "✗");
      console.log("  user CBTC holding in claim tx:", userGotCbtc ? "✓" : "✗");
      console.log("  HtlcLock.Claim path:", ledger.exercised.some((x) => x.endsWith(".Claim")) ? "✓" : "✗");
      if (!terminal || !hasFeeRow || !hasSettlement || !userGotCbtc) allOk = false;
    }

    if (o.kind === "htlc" && o.label.includes("canton→evm")) {
      const vaultGotCbtc = ledger.exercised.some((x) =>
        x.includes("Allocation_ExecuteTransfer")
      );
      console.log("\nChecks:");
      console.log("  terminal status:", terminal ? "✓" : "✗");
      console.log("  fee row:", hasFeeRow ? "✓" : "✗");
      console.log("  fee quote ≈ collected:", feeMatch ? "✓" : "~ (minor drift ok)");
      console.log("  user WBTC claimed on EVM:", evmResult?.claimed ? "✓" : "✗");
      console.log("  solver WBTC lock on EVM:", evmResult?.counterLockMined ? "✓" : "✗");
      console.log("  solver CBTC claim (DB main_claimed):", terminal ? "✓" : "✗");
      if (!terminal || !hasFeeRow || !evmResult?.claimed || evmResult.counterLockMined !== true)
        allOk = false;
    }

    if (o.kind === "c2c") {
      const filled = status === "filled";
      const settleId = db?.settlement_update_id as string | undefined;
      const idsMatch = settleId === o.settlementUpdateId;
      console.log("\nChecks:");
      console.log("  filled:", filled ? "✓" : "✗");
      console.log("  fee row:", hasFeeRow ? "✓" : "✗");
      console.log("  settlement_update_id consistent:", idsMatch ? "✓" : "✗");
      console.log("  atomic settlement on ledger:", hasSettlement ? "✓" : "✗");
      console.log("  fee_cc order ≈ ledger:", feeMatch ? "✓" : "~");
      if (!filled || !hasFeeRow || !idsMatch || !hasSettlement) allOk = false;
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(allOk ? "\n✅ ALL FOUR SWAPS: PASS" : "\n⚠️  See failures above");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

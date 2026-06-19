#!/usr/bin/env npx tsx
/**
 * Post-swap fee audit — EVM gas + Canton ledger txs + Scan list-price + Lighthouse.
 *
 *   bash scripts/with-env.sh devnet npx tsx scripts/audit-htlc-swap-fees.mts <orderId>
 *
 * Optional: LIGHTHOUSE_BASELINE='{"total_consumed":...}' from before the swap.
 */
import {
  fetchAmuletPriceUsd,
  fetchExtraTrafficPriceUsdPerMb
} from "../lib/canton-price-scan.js";

const orderId = process.argv[2];
if (!orderId) {
  console.error("Usage: audit-htlc-swap-fees.mts <orderId>");
  process.exit(1);
}

const network = process.env.NEXT_PUBLIC_NETWORK ?? "devnet";
const ledgerHost =
  network === "mainnet"
    ? "https://ledger-api.validator.warpx.fivenorth.io"
    : "https://ledger-api.validator.devnet.warpx.fivenorth.io";
const vaultParty =
  process.env.CANTON_SWAP_SETTLEMENT_PARTY?.trim() ||
  process.env.NEXT_PUBLIC_CANTON_SWAP_SETTLEMENT_PARTY?.trim() ||
  process.env.SOLVER_CANTON_PARTY?.trim() ||
  process.env.NEXT_PUBLIC_SOLVER_CANTON?.trim() ||
  "";
const rpcUrl =
  process.env.ORIGIN_RPC_URL ??
  (network === "mainnet" ? "https://mainnet.base.org" : "https://sepolia.base.org");
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

type OrderRow = Record<string, unknown>;

function isEvmTxHash(s: string | undefined): s is string {
  return !!s && /^0x[0-9a-fA-F]{64}$/.test(s);
}

/** Canton claim update id (snake_case row). */
function cantonClaimUpdateId(order: OrderRow): string | undefined {
  const c = order.counter_claim_update_id as string | undefined;
  if (!c) return undefined;
  if (order.direction === "canton-to-evm" && isEvmTxHash(c)) return undefined;
  return c;
}

function userWbtcClaimTx(order: OrderRow): string | undefined {
  if (order.direction !== "canton-to-evm") return undefined;
  const main = order.main_claim_tx as string | undefined;
  const counter = order.counter_claim_update_id as string | undefined;
  if (isEvmTxHash(main)) return main;
  if (isEvmTxHash(counter)) return counter;
  return undefined;
}

function solverWbtcClaimTx(order: OrderRow): string | undefined {
  if (order.direction !== "evm-to-canton") return undefined;
  return order.main_claim_tx as string | undefined;
}

async function getJwt(): Promise<string> {
  const tokenUrl = process.env.KEYCLOAK_TOKEN_URL;
  const isDevnet = network === "devnet";
  const clientId = isDevnet
    ? process.env.KEYCLOAK_CLIENT_ID_DEVNET || process.env.KEYCLOAK_CLIENT_ID
    : process.env.KEYCLOAK_CLIENT_ID;
  const clientSecret = isDevnet
    ? process.env.KEYCLOAK_CLIENT_SECRET_DEVNET || process.env.KEYCLOAK_CLIENT_SECRET
    : process.env.KEYCLOAK_CLIENT_SECRET;
  if (!tokenUrl || !clientId || !clientSecret) {
    throw new Error("Missing KEYCLOAK_* env");
  }
  const r = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      scope: process.env.KEYCLOAK_SCOPE ?? "daml_ledger_api"
    })
  });
  if (!r.ok) throw new Error(`JWT ${r.status}: ${await r.text()}`);
  return ((await r.json()) as { access_token: string }).access_token;
}

async function fetchOrder(id: string): Promise<OrderRow> {
  if (!supabaseUrl || !supabaseKey) throw new Error("Missing Supabase env");
  const r = await fetch(
    `${supabaseUrl}/rest/v1/htlc_orders?id=eq.${encodeURIComponent(id)}&select=*`,
    {
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`
      },
      cache: "no-store"
    }
  );
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  const rows = (await r.json()) as OrderRow[];
  if (!rows[0]) throw new Error(`Order not found: ${id}`);
  return rows[0];
}

async function ethReceipt(txHash: string): Promise<{
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  feeEth: number;
  feeUsdEstimate: number | null;
}> {
  const r = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getTransactionReceipt",
      params: [txHash.startsWith("0x") ? txHash : `0x${txHash}`]
    })
  });
  const j = (await r.json()) as { result?: { gasUsed?: string; effectiveGasPrice?: string } };
  const rec = j.result;
  if (!rec?.gasUsed) throw new Error(`No receipt for ${txHash}`);
  const gasUsed = BigInt(rec.gasUsed);
  const effectiveGasPrice = BigInt(rec.effectiveGasPrice ?? "0");
  const feeWei = gasUsed * effectiveGasPrice;
  const feeEth = Number(feeWei) / 1e18;
  return { gasUsed, effectiveGasPrice, feeEth, feeUsdEstimate: null };
}

async function ethPriceUsd(): Promise<number | null> {
  try {
    const r = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
      { cache: "no-store" }
    );
    if (!r.ok) return null;
    const j = (await r.json()) as { ethereum?: { usd?: number } };
    return j.ethereum?.usd ?? null;
  } catch {
    return null;
  }
}

type TreeTx = {
  updateId?: string;
  commandId?: string;
  eventsById?: Record<string, unknown>;
};

function unwrapTree(item: unknown): TreeTx | null {
  const u = item as {
    update?: { TransactionTree?: { value?: TreeTx } };
  };
  return u.update?.TransactionTree?.value ?? null;
}

function eventsFromTree(tree: TreeTx): Record<string, unknown> {
  return tree.eventsById ?? {};
}

function findMeta(obj: unknown, out: Record<string, string> = {}): Record<string, string> {
  if (!obj || typeof obj !== "object") return out;
  if (Array.isArray(obj)) {
    for (const x of obj) findMeta(x, out);
    return out;
  }
  const o = obj as Record<string, unknown>;
  if (o.meta && typeof o.meta === "object") {
    const values = (o.meta as { values?: Record<string, unknown> }).values;
    if (values) {
      for (const [k, v] of Object.entries(values)) {
        if (typeof v === "string") out[k] = v;
      }
    }
  }
  for (const v of Object.values(o)) findMeta(v, out);
  return out;
}

function classifyTx(
  tree: TreeTx,
  order: OrderRow
): { leg: string; choices: string[]; created: string[] } {
  const events = Object.values(eventsFromTree(tree));
  const choices: string[] = [];
  const created: string[] = [];
  for (const ev of events) {
    const ex = (ev as { ExercisedTreeEvent?: { value?: { choice?: string } } })
      .ExercisedTreeEvent?.value;
    if (ex?.choice) choices.push(ex.choice);
    const cr = (ev as { CreatedTreeEvent?: { value?: { contractId?: string; templateId?: string } } })
      .CreatedTreeEvent?.value;
    if (cr?.contractId) {
      created.push(`${cr.templateId?.split(":").pop() ?? "?"}:${cr.contractId.slice(0, 16)}…`);
    }
  }
  const allocCid = order.allocation_cid as string | undefined;
  const htlcCid = order.htlc_cid as string | undefined;
  const claimId = cantonClaimUpdateId(order);

  let leg = "unknown";
  const claimLeg =
    order.direction === "canton-to-evm" ? "solver-claim-main" : "user-claim-managed";
  if (tree.updateId && claimId && tree.updateId === claimId) leg = claimLeg;
  else if (choices.some((c) => c.includes("Claim"))) leg = claimLeg;
  else if (
    allocCid &&
    events.some((ev) => {
      const cr = (ev as { CreatedTreeEvent?: { value?: { contractId?: string } } })
        .CreatedTreeEvent?.value;
      return cr?.contractId === allocCid;
    })
  )
    leg = "solver-allocate";
  else if (
    htlcCid &&
    events.some((ev) => {
      const cr = (ev as { CreatedTreeEvent?: { value?: { contractId?: string } } })
        .CreatedTreeEvent?.value;
      return cr?.contractId === htlcCid;
    })
  )
    leg = "solver-create-htlc";
  else if (choices.some((c) => c.includes("Allocate"))) leg = "solver-allocate";

  return { leg, choices, created };
}

async function scanPartyTrees(
  jwt: string,
  partyId: string,
  lookback = 20_000
): Promise<TreeTx[]> {
  const endRes = await fetch(`${ledgerHost}/v2/state/ledger-end`, {
    headers: { Authorization: `Bearer ${jwt}` },
    cache: "no-store"
  });
  if (!endRes.ok) throw new Error(`ledger-end ${endRes.status}`);
  const { offset } = (await endRes.json()) as { offset: number };
  const res = await fetch(`${ledgerHost}/v2/updates/trees`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`
    },
    body: JSON.stringify({
      beginExclusive: Math.max(0, offset - lookback),
      endInclusive: offset,
      filter: {
        filtersByParty: {
          [partyId]: {
            cumulative: [
              {
                identifierFilter: {
                  WildcardFilter: { value: { includeCreatedEventBlob: false } }
                }
              }
            ]
          }
        }
      },
      verbose: false
    }),
    cache: "no-store"
  });
  if (!res.ok) throw new Error(`updates/trees ${res.status}: ${await res.text()}`);
  const raw = (await res.json()) as unknown;
  const items = Array.isArray(raw) ? raw : ((raw as { updates?: unknown[] }).updates ?? []);
  return items.map(unwrapTree).filter(Boolean) as TreeTx[];
}

async function probeLighthouse(party: string): Promise<Record<string, unknown>> {
  const r = await fetch(
    `https://lighthouse.cantonloop.com/api/validators/${encodeURIComponent(party)}`,
    { cache: "no-store" }
  );
  if (!r.ok) return { ok: false, status: r.status, body: await r.text().catch(() => "") };
  return { ok: true, ...(await r.json()) };
}

async function main() {
  const order = await fetchOrder(orderId);
  const jwt = await getJwt();
  const ethUsd = await ethPriceUsd();
  const [amuletUsd, trafficUsdPerMb] = await Promise.all([
    fetchAmuletPriceUsd(),
    fetchExtraTrafficPriceUsdPerMb()
  ]);

  const parties = [
    ...new Set(
      [order.solver_canton_party, order.user_canton_party, vaultParty].filter(
        (p): p is string => typeof p === "string" && !!p
      )
    )
  ];

  const trees: TreeTx[] = [];
  for (const p of parties) {
    trees.push(...(await scanPartyTrees(jwt, p)));
  }

  const allocCid = order.allocation_cid as string | undefined;
  const htlcCid = order.htlc_cid as string | undefined;
  const claimUpdateId = cantonClaimUpdateId(order);

  const matched = new Map<string, TreeTx>();
  for (const tree of trees) {
    if (!tree.updateId) continue;
    const { leg } = classifyTx(tree, order);
    if (leg === "unknown") continue;
    if (!matched.has(leg)) matched.set(leg, tree);
  }
  if (claimUpdateId) {
    const hit = trees.find((t) => t.updateId === claimUpdateId);
    if (hit) {
      matched.set(
        order.direction === "canton-to-evm"
          ? "solver-claim-main"
          : "user-claim-managed",
        hit
      );
    }
  }

  const cantonLegs: Record<string, unknown>[] = [];

  for (const [leg, tree] of matched.entries()) {
    const meta = findMeta(tree);
    const burnedKeys = Object.entries(meta).filter(([k]) =>
      /burn|traffic|cost/i.test(k)
    );
    const info = classifyTx(tree, order);
    cantonLegs.push({
      leg,
      updateId: tree.updateId,
      commandId: tree.commandId,
      choices: info.choices,
      created: info.created,
      metaBurnHints: Object.fromEntries(burnedKeys)
    });
  }

  const evmLegs: Record<string, unknown>[] = [];
  let totalEvmEth = 0;
  const direction = order.direction as string | undefined;
  const evmTxCandidates: [string, string | undefined][] =
    direction === "canton-to-evm"
      ? [
          ["solver-wbtc-lock", order.counter_lock_tx as string | undefined],
          ["user-wbtc-claim", userWbtcClaimTx(order)]
        ]
      : [
          ["user-wbtc-lock", order.main_lock_tx as string | undefined],
          ["solver-wbtc-claim", solverWbtcClaimTx(order)]
        ];
  for (const [label, tx] of evmTxCandidates) {
    if (!tx || tx === "already-claimed") continue;
    try {
      const rec = await ethReceipt(tx);
      totalEvmEth += rec.feeEth;
      evmLegs.push({
        leg: label,
        txHash: tx,
        gasUsed: rec.gasUsed.toString(),
        effectiveGasPriceWei: rec.effectiveGasPrice.toString(),
        feeEth: rec.feeEth,
        feeUsd: ethUsd != null ? rec.feeEth * ethUsd : null
      });
    } catch (e) {
      evmLegs.push({
        leg: label,
        txHash: tx,
        error: e instanceof Error ? e.message : String(e)
      });
    }
  }

  const wbtc = BigInt((order.wbtc_amount as string) ?? "0");
  const cbtcSats = BigInt(
    Math.round(parseFloat((order.cbtc_amount as string) ?? "0") * 1e8)
  );
  const platformFeeSats = wbtc > cbtcSats ? wbtc - cbtcSats : 0n;

  const lighthouseParty = (order.solver_canton_party as string) || vaultParty;
  const lighthouse = await probeLighthouse(lighthouseParty);
  let lighthouseDelta: unknown = null;
  if (process.env.LIGHTHOUSE_BASELINE) {
    try {
      const base = JSON.parse(process.env.LIGHTHOUSE_BASELINE) as {
        total_consumed?: number;
      };
      const nowConsumed = (lighthouse as { total_consumed?: number }).total_consumed;
      if (typeof base.total_consumed === "number" && typeof nowConsumed === "number") {
        lighthouseDelta = { bytes: nowConsumed - base.total_consumed, after: nowConsumed };
      }
    } catch {
      /* ignore */
    }
  }

  const report = {
    auditedAt: new Date().toISOString(),
    orderId,
    direction: order.direction,
    status: order.status,
    counterMode: order.counter_mode,
    notionals: {
      wbtcBaseUnits: order.wbtc_amount,
      cbtcBtc: order.cbtc_amount,
      platformFeeBtc: (Number(platformFeeSats) / 1e8).toFixed(8)
    },
    pricing: { amuletUsd, trafficUsdPerMb, ethUsd },
    evm: {
      legs: evmLegs,
      totalFeeEth: totalEvmEth,
      totalFeeUsd: ethUsd != null ? totalEvmEth * ethUsd : null,
      paidBy: {
        user: evmLegs.filter((l) => String(l.leg).startsWith("user")),
        solver: evmLegs.filter((l) => String(l.leg).startsWith("solver"))
      }
    },
    canton: {
      legs: cantonLegs,
      expectedLegs:
        direction === "canton-to-evm"
          ? ["solver-allocate", "solver-create-htlc", "solver-claim-main"]
          : ["solver-allocate", "solver-create-htlc", "user-claim-managed"],
      missingLegs: (
        direction === "canton-to-evm"
          ? ["solver-allocate", "solver-create-htlc", "solver-claim-main"]
          : ["solver-allocate", "solver-create-htlc", "user-claim-managed"]
      ).filter((l) => !matched.has(l)),
      contractIds: { allocationCid: allocCid, htlcCid, claimUpdateId },
      networkFeeQuotedCc: order.network_fee_cc ?? null,
      networkFeeCollectionEnabled: process.env.NETWORK_FEE_ENABLED === "1",
      listPriceNote:
        "Per-tx byte cost: grep dev logs [solver-node-traffic] and [network-fee], or re-run prepare probes. Ledger trees rarely expose byte cost in meta on WarpX."
    },
    lighthouse: { party: lighthouseParty, snapshot: lighthouse, deltaFromBaseline: lighthouseDelta },
    grepHints: [
      `grep '${orderId.slice(0, 12)}' # dev/solver logs`,
      `grep 'solver-node-traffic' | grep '${orderId.slice(0, 12)}'`,
      `grep '\\[network-fee\\]' # quote + claim estimates`
    ]
  };

  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

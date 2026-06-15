/**
 * Helpers for reading the user's CBTC from their connected Loop wallet.
 *
 * The Loop SDK gives two views:
 *  - provider.getHolding()         → per-instrument AGGREGATE (unlocked/locked totals)
 *  - provider.getActiveContracts() → per-CONTRACT (each holding's contract_id)
 *
 * Balance display uses the aggregate; redeem (which must pick specific UTXOs to
 * burn) uses the per-contract view. Both filter to the network's CBTC instrument.
 */

import { fromBaseUnits, toBaseUnitsFloor } from "@/lib/amount-units";
import { CC_ASSET, matchesInstrument } from "@/lib/canton-assets";
import { NETWORK } from "@/lib/constants";
import type { InstrumentId } from "@/lib/constants";

/** Aggregate holding shape from provider.getHolding(). */
export interface LoopHolding {
  instrument_id: { admin: string; id: string };
  decimals: number;
  symbol: string;
  total_unlocked_coin: string;
  total_locked_coin: string;
}

/** A single active contract from provider.getActiveContracts(). */
export interface LoopActiveContract {
  template_id: string;
  contract_id: string;
  [key: string]: unknown;
}

interface ProviderLike {
  getHolding: () => Promise<unknown[]>;
  getActiveContracts: (params?: {
    templateId?: string;
    interfaceId?: string;
  }) => Promise<unknown[]>;
}

function isInstrument(h: LoopHolding, instrumentId: InstrumentId): boolean {
  return matchesInstrument(h.instrument_id, instrumentId);
}

function isOurCbtc(h: LoopHolding): boolean {
  return isInstrument(h, NETWORK.instrumentId);
}

/** Unlocked + locked totals (decimal strings) from the Loop aggregate. */
export async function readLoopInstrumentBalance(
  provider: ProviderLike,
  instrumentId: InstrumentId
): Promise<{ total: string; locked: string; count: number }> {
  const all = (await provider.getHolding()) as unknown as LoopHolding[];
  const matched = all.filter((h) => isInstrument(h, instrumentId));
  if (matched.length === 0) return { total: "0", locked: "0", count: 0 };
  const total = sumDecimals(matched.map((h) => h.total_unlocked_coin ?? "0"));
  const locked = sumDecimals(matched.map((h) => h.total_locked_coin ?? "0"));
  return { total, locked, count: matched.length };
}

/** Unlocked + locked CBTC totals (BTC decimal strings) from the Loop aggregate. */
export async function readLoopCbtcBalance(
  provider: ProviderLike
): Promise<{ total: string; locked: string; count: number }> {
  return readLoopInstrumentBalance(provider, NETWORK.instrumentId);
}

/** CC (Amulet) total from the Loop wallet aggregate — 10 dp CC precision. */
export async function readLoopCcBalance(provider: ProviderLike): Promise<string> {
  const all = (await provider.getHolding()) as unknown as LoopHolding[];
  const amulets = all.filter((h) => h.instrument_id?.id === "Amulet");
  if (amulets.length === 0) return fromBaseUnits(0n, CC_ASSET.decimals);
  let total = 0n;
  for (const h of amulets) {
    total += toBaseUnitsFloor(h.total_unlocked_coin ?? "0", CC_ASSET.decimals);
    total += toBaseUnitsFloor(h.total_locked_coin ?? "0", CC_ASSET.decimals);
  }
  return fromBaseUnits(total, CC_ASSET.decimals);
}

/** LOOP SELLER: the user's individual UNLOCKED CBTC holding contract-ids, read
 *  through THEIR wallet connection (we can't see a Loop party cross-participant).
 *  Defensive shape-matching — the SDK returns per-contract records whose payload
 *  layout varies; we match Holding templates carrying our CBTC instrument id and
 *  skip anything that looks locked. */
export async function listLoopInstrumentHoldingCids(
  provider: Pick<ProviderLike, "getActiveContracts">,
  instrumentId: InstrumentId
): Promise<string[]> {
  const HOLDING_IFACE =
    "#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding";
  // The CBTC registry's CONCRETE holding template (same FQN lib/transfer.ts uses).
  const HOLDING_TPL =
    "8107899ac4723ce986bf7d27416534e576e54b92161e46150a595fb78ff3d3a1:Utility.Registry.Holding.V0.Holding:Holding";

  // Loop requires templateId OR interfaceId — never call unfiltered (400).
  let raw: unknown[] = [];
  for (const params of [{ interfaceId: HOLDING_IFACE }, { templateId: HOLDING_TPL }] as const) {
    try {
      raw = await provider.getActiveContracts(
        params as { interfaceId?: string } | undefined
      );
      console.debug(
        `[loop-holdings] getActiveContracts(${JSON.stringify(params)}) → ${raw.length} item(s)`
      );
      if (raw.length > 0) break;
    } catch (e) {
      console.debug(
        `[loop-holdings] getActiveContracts(${JSON.stringify(params)}) threw:`,
        e
      );
    }
  }
  if (raw.length === 0) return [];

  const out: string[] = [];
  for (const item of raw as Array<Record<string, any>>) {
    // eslint-disable-line @typescript-eslint/no-explicit-any
    // REAL shape (observed live, contradicts the SDK typings): a raw JSON Ledger
    // API ACS entry — { contractEntry: { JsActiveContract: { createdEvent: {
    // contractId, templateId, ... } } } }. Tolerate the flat shape too.
    const ev = item?.contractEntry?.JsActiveContract?.createdEvent ?? item;
    const cid = (ev?.contractId ?? ev?.contract_id) as string | undefined;
    const tpl = String(ev?.templateId ?? ev?.template_id ?? "");
    if (!cid) continue;

    const isRegistryHolding =
      /Utility\.Registry.*:Holding$/.test(tpl) ||
      tpl.startsWith(
        "8107899ac4723ce986bf7d27416534e576e54b92161e46150a595fb78ff3d3a1"
      );
    const isAmuletHolding =
      instrumentId.id === "Amulet" &&
      (/Amulet/.test(tpl) ||
        /Splice\.Api\.Token\.HoldingV1/.test(tpl) ||
        /Splice\.Amulet/.test(tpl));

    if (!isRegistryHolding && !isAmuletHolding) continue;
    const json = JSON.stringify(ev);
    // If the payload is present, require our instrument id and skip locked holdings
    // ("lock":null is fine). If only the blob is present, the template match above
    // is the discriminator (the CBTC registry template carries only CBTC).
    const hasPayload =
      json.includes("createArgument") || json.includes("interfaceViews");
    if (hasPayload && !json.includes(instrumentId.id)) continue;
    if (instrumentId.id !== "Amulet" && instrumentId.admin && !json.includes(instrumentId.admin)) {
      continue;
    }
    if (/"lock"\s*:\s*\{/.test(json)) continue;
    out.push(cid);
  }
  console.debug(
    `[loop-holdings] matched ${out.length} unlocked ${instrumentId.id} holding(s) of ${raw.length} contract(s)`
  );
  if (out.length === 0 && raw.length > 0) {
    // Diagnostics for the next failure: show what the wallet actually returned.
    console.debug(
      "[loop-holdings] first item for diagnosis:",
      JSON.stringify(raw[0]).slice(0, 600)
    );
  }
  return out;
}

/** LOOP SELLER: individual UNLOCKED CBTC holding contract-ids (default instrument). */
export async function listLoopCbtcHoldingCids(
  provider: Pick<ProviderLike, "getActiveContracts">
): Promise<string[]> {
  return listLoopInstrumentHoldingCids(provider, NETWORK.instrumentId);
}

/** Sum decimal BTC strings via integer sats (no float drift, 8dp). */
export function sumDecimals(values: string[]): string {
  let sats = 0n;
  for (const v of values) sats += btcToSats(v);
  return satsToBtc(sats);
}

export function btcToSats(btc: string): bigint {
  const s = (btc ?? "0").trim();
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return 0n;
  const [whole = "0", frac = ""] = s.split(".");
  const fracPadded = (frac + "00000000").slice(0, 8);
  return BigInt(whole || "0") * 100_000_000n + BigInt(fracPadded || "0");
}

export function satsToBtc(sats: bigint): string {
  const whole = sats / 100_000_000n;
  const frac = (sats % 100_000_000n)
    .toString()
    .padStart(8, "0")
    .replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

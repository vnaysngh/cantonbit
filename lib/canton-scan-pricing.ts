/** Pure parsers for Splice scan-proxy AmuletRules / mining round payloads. */

export function parseExtraTrafficPriceFromPayload(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;

  const feeObjects: unknown[] = [];
  const config = p.config;
  if (config && typeof config === "object") {
    feeObjects.push((config as Record<string, unknown>).fees);
  }
  feeObjects.push(p.fees);

  const schedule = p.configSchedule;
  if (schedule && typeof schedule === "object") {
    const initial = (schedule as Record<string, unknown>).initialValue;
    if (initial && typeof initial === "object") {
      const iv = initial as Record<string, unknown>;
      feeObjects.push(iv.fees);
      const sync = iv.decentralizedSynchronizer;
      if (sync && typeof sync === "object") {
        feeObjects.push((sync as Record<string, unknown>).fees);
      }
    }
  }

  const sync = p.decentralizedSynchronizer;
  if (sync && typeof sync === "object") {
    feeObjects.push((sync as Record<string, unknown>).fees);
  }

  for (const fees of feeObjects) {
    if (!fees || typeof fees !== "object") continue;
    const raw =
      (fees as Record<string, unknown>).extraTrafficPrice ??
      (fees as Record<string, unknown>).extra_traffic_price;
    if (raw == null) continue;
    const n = Number.parseFloat(String(raw));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

export function parseAmuletRulesPayload(body: unknown): unknown {
  if (!body || typeof body !== "object") return undefined;
  const j = body as Record<string, unknown>;
  const rules =
    j.amulet_rules ??
    j.amulet_rules_update ??
    j.amuletRulesUpdate ??
    j.amuletRules;
  if (!rules || typeof rules !== "object") return undefined;
  return (rules as { contract?: { payload?: unknown } }).contract?.payload;
}

export function parseAmuletPriceFromMiningRounds(body: unknown): number | null {
  if (!body || typeof body !== "object") return null;
  const rawRounds =
    (body as { open_mining_rounds?: unknown }).open_mining_rounds ?? [];
  const rounds = Array.isArray(rawRounds)
    ? rawRounds
    : Object.values(rawRounds as Record<string, unknown>);
  for (const entry of rounds) {
    const raw = (entry as { contract?: { payload?: { amuletPrice?: string } } })
      ?.contract?.payload?.amuletPrice;
    if (raw == null) continue;
    const p = Number.parseFloat(String(raw));
    if (Number.isFinite(p) && p > 0) return p;
  }
  return null;
}

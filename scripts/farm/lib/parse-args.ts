export function parseArg(name: string, fallback?: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  const v = hit?.split("=", 2)[1]?.trim();
  return v || fallback;
}

export function parseFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

export function parseNumberArg(name: string, fallback: number): number {
  const raw = parseArg(name);
  if (raw == null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function requireMainnetGuard(): void {
  if (
    parseFlag("i-understand-mainnet") ||
    process.env.FARM_MAINNET_CONFIRMED === "1" ||
    process.env.RAILWAY_ENVIRONMENT
  ) {
    return;
  }
  console.error("Refusing mainnet operation without --i-understand-mainnet");
  process.exit(1);
}

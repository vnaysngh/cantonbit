import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

function readJson(path: string): unknown | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

const functionsConfig = readJson(
  join(root, ".next/server/functions-config-manifest.json")
) as { functions?: Record<string, unknown> } | null;

if (functionsConfig?.functions?.["/_middleware"]) {
  console.log("[assert-next-proxy] proxy compiled as /_middleware");
  process.exit(0);
}

// Compatibility for older Next.js versions that still populate the legacy
// middleware manifest instead of functions-config-manifest.
const middlewareManifest = readJson(
  join(root, ".next/server/middleware-manifest.json")
) as
  | {
      middleware?: Record<string, unknown>;
      sortedMiddleware?: unknown[];
    }
  | null;

if (
  middlewareManifest?.middleware &&
  Object.keys(middlewareManifest.middleware).length > 0
) {
  console.log("[assert-next-proxy] legacy middleware manifest is non-empty");
  process.exit(0);
}

if ((middlewareManifest?.sortedMiddleware?.length ?? 0) > 0) {
  console.log("[assert-next-proxy] legacy sorted middleware is non-empty");
  process.exit(0);
}

console.error(
  "[assert-next-proxy] security proxy/middleware did not compile. " +
    "Mainnet guard and security headers would be absent."
);
process.exit(1);

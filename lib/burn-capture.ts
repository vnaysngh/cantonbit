/**
 * burn-capture — DEBUG ONLY. When REDEEM_CAPTURE=1, the redeem routes append
 * every request/response into a single snapshot file so the UI burn can be
 * diffed byte-for-byte against the working script's snapshot.
 *
 * Each route writes its own `steps.<name>` key. Concurrent writes within one
 * burn are sequential (the routes are called in order), so a read-modify-write
 * is safe enough for this debug flow.
 *
 * Disabled entirely unless REDEEM_CAPTURE=1 — no-op in normal operation.
 */

import "server-only";

const FILE = "/Users/vinaysingh/Desktop/cantonops/cantonbit/snapshots/realburn-2-ui-FULL.json";

export function captureEnabled(): boolean {
  return process.env.REDEEM_CAPTURE === "1";
}

/** Reset the capture file at the start of a fresh burn (called by find/create). */
export async function captureReset(meta: Record<string, unknown>): Promise<void> {
  if (!captureEnabled()) return;
  try {
    const fs = await import("node:fs/promises");
    await fs.writeFile(
      FILE,
      JSON.stringify({ source: "UI", capturedAt: new Date().toISOString(), ...meta, steps: {} }, null, 2),
    );
  } catch (e) {
    console.error("[burn-capture] reset failed:", e);
  }
}

/** Append/overwrite one step in the capture file. */
export async function captureStep(name: string, data: unknown): Promise<void> {
  if (!captureEnabled()) return;
  try {
    const fs = await import("node:fs/promises");
    let current: { steps?: Record<string, unknown> } = {};
    try {
      current = JSON.parse(await fs.readFile(FILE, "utf8"));
    } catch {
      current = { steps: {} };
    }
    if (!current.steps) current.steps = {};
    current.steps[name] = data;
    await fs.writeFile(FILE, JSON.stringify(current, null, 2));
    console.log(`[burn-capture] wrote step "${name}"`);
  } catch (e) {
    console.error(`[burn-capture] step "${name}" failed:`, e);
  }
}

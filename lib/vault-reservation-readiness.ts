import "server-only";

import { createSupabaseServiceClient } from "./supabase/server";

const REQUIRED_VERSION = 3;

let readinessCheck: Promise<void> | undefined;

/** Fail closed if unified CBTC reservation math (040 + 041) is absent. */
export async function assertUnifiedVaultReservationReady(): Promise<void> {
  readinessCheck ??= (async () => {
    const sb = await createSupabaseServiceClient();
    const { data, error } = await sb.rpc(
      "vault_cbtc_reservation_schema_version"
    );
    if (error) {
      throw new Error(
        "database schema out of date — apply migrations 040 and 041 before accepting swaps. " +
          `Original: ${error.message}`
      );
    }
    const version = Number(data);
    if (!Number.isFinite(version) || version < REQUIRED_VERSION) {
      throw new Error(
        `database schema out of date — vault CBTC reservation version ${data ?? "unknown"} < ${REQUIRED_VERSION}`
      );
    }
  })();

  try {
    await readinessCheck;
  } catch (e) {
    readinessCheck = undefined;
    throw e;
  }
}

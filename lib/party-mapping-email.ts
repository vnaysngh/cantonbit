import "server-only";

import type { createSupabaseServiceClient } from "@/lib/supabase/server";

type ServiceClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type AuthUserEmail = { email?: string | null };

/** Lowercase trimmed email from Supabase auth, or null if missing. */
export function emailFromAuthUser(user: AuthUserEmail): string | null {
  const email = user.email?.trim().toLowerCase();
  if (!email || !email.includes("@")) return null;
  return email;
}

/** Fields to spread into party_mappings insert/update payloads. */
export function partyMappingEmailPayload(
  user: AuthUserEmail
): { email: string } | Record<string, never> {
  const email = emailFromAuthUser(user);
  return email ? { email } : {};
}

/** Keep email current when the user signs in again (e.g. OTP → Google link). */
export async function syncPartyMappingEmail(
  service: ServiceClient,
  userId: string,
  user: AuthUserEmail
): Promise<void> {
  const email = emailFromAuthUser(user);
  if (!email) return;
  await service.from("party_mappings").update({ email }).eq("user_id", userId);
}

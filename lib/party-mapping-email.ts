import "server-only";

import type { User } from "@supabase/supabase-js";

import type { createSupabaseServiceClient } from "@/lib/supabase/server";

type ServiceClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** Lowercase trimmed email from Supabase auth, or null if missing. */
export function emailFromAuthUser(user: Pick<User, "email">): string | null {
  const email = user.email?.trim().toLowerCase();
  if (!email || !email.includes("@")) return null;
  return email;
}

/** Fields to spread into party_mappings insert/update payloads. */
export function partyMappingEmailPayload(
  user: Pick<User, "email">
): { email: string } | Record<string, never> {
  const email = emailFromAuthUser(user);
  return email ? { email } : {};
}

/** Keep email current when the user signs in again (e.g. OTP → Google link). */
export async function syncPartyMappingEmail(
  service: ServiceClient,
  userId: string,
  user: Pick<User, "email">
): Promise<void> {
  const email = emailFromAuthUser(user);
  if (!email) return;
  await service.from("party_mappings").update({ email }).eq("user_id", userId);
}

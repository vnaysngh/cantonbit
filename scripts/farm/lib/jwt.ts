export function authEnv() {
  const isDevnet = process.env.NEXT_PUBLIC_NETWORK?.toLowerCase() === "devnet";
  const tokenUrl = process.env.KEYCLOAK_TOKEN_URL;
  const clientId = isDevnet
    ? process.env.KEYCLOAK_CLIENT_ID_DEVNET || process.env.KEYCLOAK_CLIENT_ID
    : process.env.KEYCLOAK_CLIENT_ID;
  const clientSecret = isDevnet
    ? process.env.KEYCLOAK_CLIENT_SECRET_DEVNET || process.env.KEYCLOAK_CLIENT_SECRET
    : process.env.KEYCLOAK_CLIENT_SECRET;
  const scope = process.env.KEYCLOAK_SCOPE ?? "daml_ledger_api";
  if (!tokenUrl || !clientId || !clientSecret) {
    throw new Error("Missing KEYCLOAK_* env vars");
  }
  return { tokenUrl, clientId, clientSecret, scope };
}

export async function getLedgerJwt(): Promise<string> {
  const auth = authEnv();
  const res = await fetch(auth.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: auth.clientId,
      client_secret: auth.clientSecret,
      scope: auth.scope
    })
  });
  if (!res.ok) {
    throw new Error(`JWT fetch failed (${res.status}): ${await res.text()}`);
  }
  return ((await res.json()) as { access_token: string }).access_token;
}

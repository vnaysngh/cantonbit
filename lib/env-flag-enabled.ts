/** Shared env flag semantics: unset = enabled; 0/false/no = disabled. */
export function envFlagEnabled(raw: string | undefined): boolean {
  if (raw == null || raw.trim() === "") return true;
  const v = raw.trim().replace(/\s+#.*$/, "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export function readEnvFlag(
  serverKey: string,
  publicKey: string
): boolean {
  const server = process.env[serverKey];
  if (server != null && server.trim() !== "") {
    return envFlagEnabled(server);
  }
  return envFlagEnabled(process.env[publicKey]);
}

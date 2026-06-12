export function bearerTokenFromHeader(header: string | null): string {
  const value = header ?? "";
  return value.startsWith("Bearer ") ? value.slice("Bearer ".length) : "";
}

export function isBearerAuthorized(params: {
  header: string | null;
  secret: string;
  nodeEnv?: string;
}): boolean {
  if (!params.secret && params.nodeEnv !== "production") return true;
  return !!params.secret && bearerTokenFromHeader(params.header) === params.secret;
}


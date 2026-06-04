/** Dump the RAW active-contracts response for the warpx party so we can see the
 *  exact holding/interfaceView shape. Read-only. */
import { randomUUID } from "node:crypto";

const HOST = "https://ledger-api.validator.devnet.warpx.fivenorth.io";
const PARTY = "warpx-devnet-1::1220231c1885f289f90e0d08b448579c31a655b5826802c6d885258a27371039fba9";

async function jwt(): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.KEYCLOAK_CLIENT_ID!,
    client_secret: process.env.KEYCLOAK_CLIENT_SECRET_DEVNET ?? process.env.KEYCLOAK_CLIENT_SECRET!,
    scope: process.env.KEYCLOAK_SCOPE ?? "daml_ledger_api",
  });
  const r = await fetch(process.env.KEYCLOAK_TOKEN_URL!, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!r.ok) throw new Error(`token ${r.status}: ${await r.text()}`);
  return (await r.json() as { access_token: string }).access_token;
}

async function main() {
  void randomUUID;
  const t = await jwt();
  const end = await (await fetch(`${HOST}/v2/state/ledger-end`, { headers: { Authorization: `Bearer ${t}` } })).json() as { offset: number };
  const res = await fetch(`${HOST}/v2/state/active-contracts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
    body: JSON.stringify({
      filter: { filtersByParty: { [PARTY]: { cumulative: [
        { identifierFilter: { InterfaceFilter: { value: {
          interfaceId: "#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding",
          includeInterfaceView: true, includeCreatedEventBlob: false } } } },
      ] } } },
      verbose: false, activeAtOffset: end.offset,
    }),
  });
  const raw = await res.json() as any[];
  console.log(`status=${res.status} entries=${raw.length}\n`);
  for (const e of raw) {
    const ev = e.contractEntry?.JsActiveContract?.createdEvent;
    if (!ev) continue;
    const tpl = ev.templateId?.split(":").slice(1).join(":");
    const iv = ev.interfaceViews?.[0];
    console.log(`--- ${tpl} ---`);
    console.log(`  viewStatus.code = ${iv?.viewStatus?.code ?? "OK(rendered)"}`);
    console.log(`  viewValue = ${JSON.stringify(iv?.viewValue)?.slice(0, 250)}`);
    console.log(`  createArgument.amount = ${JSON.stringify(ev.createArgument?.amount)?.slice(0, 150)}`);
    console.log(`  createArgument.owner = ${ev.createArgument?.owner?.slice(0, 30)}`);
    console.log(`  createArgument keys = ${Object.keys(ev.createArgument ?? {})}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

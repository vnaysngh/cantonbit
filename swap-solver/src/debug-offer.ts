/** Dump the receiver party's active contracts to find the just-created transfer
 *  offer and see its exact shape (templateId + createArgument). Read-only. */
const HOST = "https://ledger-api.validator.devnet.warpx.fivenorth.io";
const RECEIVER = "8f5ca108eb208e8826f868952ede00a5::12200fe103931833a6cb6f080dff41df997dbb9abd8d06384e6405434a04efcf8e2b";

async function jwt(): Promise<string> {
  const b = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.KEYCLOAK_CLIENT_ID!,
    client_secret: process.env.KEYCLOAK_CLIENT_SECRET_DEVNET ?? process.env.KEYCLOAK_CLIENT_SECRET!,
    scope: process.env.KEYCLOAK_SCOPE ?? "daml_ledger_api",
  });
  const r = await fetch(process.env.KEYCLOAK_TOKEN_URL!, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: b });
  return (await r.json() as { access_token: string }).access_token;
}

async function main() {
  const t = await jwt();
  const end = await (await fetch(`${HOST}/v2/state/ledger-end`, { headers: { Authorization: `Bearer ${t}` } })).json() as { offset: number };
  const res = await fetch(`${HOST}/v2/state/active-contracts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
    body: JSON.stringify({
      filter: { filtersByParty: { [RECEIVER]: { cumulative: [
        { identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } },
      ] } } },
      verbose: false, activeAtOffset: end.offset,
    }),
  });
  const raw = await res.json() as any[];
  console.log(`receiver active contracts: ${raw.length}\n`);
  for (const e of raw) {
    const ev = e.contractEntry?.JsActiveContract?.createdEvent;
    if (!ev) continue;
    const tpl = ev.templateId?.split(":").slice(1).join(":");
    console.log(`--- ${tpl} ---`);
    console.log(`  contractId: ${ev.contractId?.slice(0, 30)}…`);
    const arg = ev.createArgument ?? {};
    console.log(`  createArgument keys: ${Object.keys(arg)}`);
    // transfer offers carry the transfer sub-object
    if (arg.transfer) {
      console.log(`  transfer.sender: ${String(arg.transfer.sender).slice(0,24)}`);
      console.log(`  transfer.receiver: ${String(arg.transfer.receiver).slice(0,24)}`);
      console.log(`  transfer.amount: ${arg.transfer.amount}`);
      console.log(`  transfer.inputHoldingCids: ${JSON.stringify(arg.transfer.inputHoldingCids)?.slice(0,120)}`);
    } else {
      console.log(`  (no .transfer; sample: ${JSON.stringify(arg)?.slice(0,200)})`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

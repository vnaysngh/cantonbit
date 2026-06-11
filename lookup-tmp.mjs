import fs from "node:fs";
const env = fs.readFileSync(".env.local","utf8");
const get = k => (env.match(new RegExp("^"+k+"=(.+)$","m"))||[])[1]?.trim();
const TOKEN_URL = get("KEYCLOAK_TOKEN_URL");
const SECRET = get("KEYCLOAK_CLIENT_SECRET_DEVNET");
const LEDGER = "https://ledger-api.validator.devnet.warpx.fivenorth.io";
const PUBKEY_HEX = "f265853c632c122f921aae78f6755d63ef48d959d34cb666fa1b0d7dc5637beb";
const body = new URLSearchParams({grant_type:"client_credentials",client_id:"validator-devnet-m2m",client_secret:SECRET,scope:"daml_ledger_api"});
const tr = await fetch(TOKEN_URL,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body});
const jwt = (await tr.json()).access_token;
// list known parties on the participant
const r = await fetch(`${LEDGER}/v2/parties`,{headers:{Authorization:`Bearer ${jwt}`}});
const txt = await r.text();
console.log("parties endpoint status:", r.status);
// search the response for any party whose details include our pubkey, or just dump party ids
try {
  const j = JSON.parse(txt);
  const parties = j.partyDetails ?? j.parties ?? j;
  const ids = (Array.isArray(parties)?parties:[]).map(p=>p.party||p.identifier||p).filter(Boolean);
  console.log("party count:", ids.length);
  // print any party whose namespace might relate; print first 10 ids (truncated)
  ids.slice(0,15).forEach(id=>console.log("  ", String(id).slice(0,70)));
  // does any contain a fingerprint we can match? print full list tail
} catch(e){ console.log("raw (first 600):", txt.slice(0,600)); }

// Save raw ledger ACS JSON for warpx + user to repo snapshots/ for before/after
// comparison. Usage: node scripts/snapshot.mjs <label>
//   e.g. node scripts/snapshot.mjs 0-before-before
import { readFileSync, writeFileSync, mkdirSync } from "fs";

const label = process.argv[2];
if (!label) { console.error("usage: node scripts/snapshot.mjs <label>"); process.exit(1); }

const ROOT = "/Users/vinaysingh/Desktop/cantonops/cantonbit";
const env = Object.fromEntries(
  readFileSync(`${ROOT}/.env.local`,"utf8")
    .split("\n").filter(l=>l.includes("=")&&!l.startsWith("#"))
    .map(l=>{const i=l.indexOf("=");return [l.slice(0,i).trim(),l.slice(i+1).trim()];})
);
const tok = await (await fetch(env.KEYCLOAK_TOKEN_URL,{method:"POST",
  headers:{"Content-Type":"application/x-www-form-urlencoded"},
  body:new URLSearchParams({grant_type:"client_credentials",client_id:env.KEYCLOAK_CLIENT_ID,
    client_secret:env.KEYCLOAK_CLIENT_SECRET,scope:env.KEYCLOAK_SCOPE??"daml_ledger_api"})})).json();
const jwt = tok.access_token;
const LEDGER="https://ledger-api.validator.warpx.fivenorth.io";
const WARPX="warpx-mainnet-1::1220517bfd86ef5732610705a35b7b2d56e36112550d6a2b778971dbd099a3d36e99";
const USER="cbtc-user-008937fb-8b38-4791-a9e9-b4ebc19c4429::1220517bfd86ef5732610705a35b7b2d56e36112550d6a2b778971dbd099a3d36e99";

const offset = (await (await fetch(`${LEDGER}/v2/state/ledger-end`,{headers:{Authorization:`Bearer ${jwt}`}})).json()).offset;

async function acs(party){
  const r = await fetch(`${LEDGER}/v2/state/active-contracts`,{method:"POST",
    headers:{"Content-Type":"application/json",Authorization:`Bearer ${jwt}`,"Connection":"close"},
    body:JSON.stringify({filter:{filtersByParty:{[party]:{cumulative:[{identifierFilter:{WildcardFilter:{value:{includeCreatedEventBlob:false}}}}]}}},verbose:true,activeAtOffset:offset})});
  return await r.json();
}

const warpxRaw = await acs(WARPX);
const userRaw = await acs(USER);

// summarize holdings for a quick-read header
function holdings(raw){
  const out=[];
  for(const i of (Array.isArray(raw)?raw:[])){
    const ev=i.contractEntry?.JsActiveContract?.createdEvent;
    if(ev?.templateId?.includes("Holding.V0.Holding:Holding"))
      out.push({amount:ev.createArgument?.amount, contractId:ev.contractId});
  }
  return out;
}

const snapshot = {
  label,
  capturedAt: new Date().toISOString(),
  ledgerOffset: offset,
  summary: {
    warpxHoldings: holdings(warpxRaw),
    warpxTotal: holdings(warpxRaw).reduce((s,h)=>s+Number(h.amount),0).toFixed(8),
    userHoldings: holdings(userRaw),
    userTotal: holdings(userRaw).reduce((s,h)=>s+Number(h.amount),0).toFixed(8),
  },
  raw: {
    warpx: warpxRaw,
    user: userRaw,
  },
};

mkdirSync(`${ROOT}/snapshots`,{recursive:true});
const path = `${ROOT}/snapshots/${label}.json`;
writeFileSync(path, JSON.stringify(snapshot, null, 2));
console.log(`saved → snapshots/${label}.json  (offset ${offset})`);
console.log(`  warpx: ${snapshot.summary.warpxTotal} cBTC (${snapshot.summary.warpxHoldings.length} holdings)`);
console.log(`  user:  ${snapshot.summary.userTotal} cBTC (${snapshot.summary.userHoldings.length} holdings)`);

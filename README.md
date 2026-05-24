# cantonbit

A web app for converting between native Bitcoin (BTC) and cBTC — a token that represents Bitcoin 1:1 on the Canton Network blockchain.

You deposit real BTC, you get cBTC. You return cBTC, you get real BTC back.

---

## What problem does this solve?

Bitcoin and Canton Network don't natively talk to each other. Canton is used by institutional finance — think regulated asset transfers, tokenized securities. Bitcoin is, well, Bitcoin. If you want to use BTC value inside a Canton-based system, you need a bridge.

**cantonbit is the front door to that bridge.** It lets you:

- **Mint** — lock real BTC in the bridge, receive cBTC on Canton
- **Redeem** — burn cBTC on Canton, receive real BTC back

That's the entire product. It's not a Canton wallet, it's not a Bitcoin wallet, it doesn't send cBTC between users. Mint and redeem only.

---

## Who's involved in making this work

cantonbit doesn't run the bridge. It's a UI that coordinates between several independent parties:

| Party | What they do |
|---|---|
| **You** | You have a Loop wallet (Canton wallet) and a Bitcoin wallet. You click the buttons. |
| **Five North** | Runs the Canton validator node. Your party identity lives here. |
| **Loop wallet** | Your personal Canton wallet. It signs every transaction you make. You need it installed. |
| **BitSafe / DLC.link** | Runs the actual BTC-to-cBTC bridge. They watch Bitcoin, mint cBTC, and release BTC on redemption. |
| **Canton Network** | The underlying blockchain that records all cBTC contracts and balances. |

When you click "Mint", cantonbit talks to most of these in sequence. If any of them is down or misconfigured, you'll see an error — and the error message will tell you which one.

---

## Before you start

You need all of these. Nothing works without them.

### 1. Loop wallet
Download from [cantonloop.com](https://cantonloop.com). Install it, create or import a Canton account. Connect it to cantonbit using the button in the top-right corner of the app.

### 2. A Canton party ID on Five North's validator
Your Loop wallet gives you a party identity, but it has to be hosted on a validator. Five North runs the one cantonbit uses. Contact them to get your party onboarded.

### 3. Authentik OAuth credentials
These go in `.env.local`. cantonbit uses them to read Canton ledger state on the server side (not for your personal transactions — those go through Loop).

Get these from Five North (the Client ID and Client Secret from their Authentik instance):

```
KEYCLOAK_TOKEN_URL=https://auth.validator.devnet.warpx.fivenorth.io/application/o/token/
KEYCLOAK_CLIENT_ID=<from Five North>
KEYCLOAK_CLIENT_SECRET=<from Five North>
```

### 4. cBTC DARs installed on the validator
DARs are Canton smart contract packages. Without them, the Canton network doesn't know what a cBTC contract is. Five North installs these through their dashboard — you don't do this yourself. Ask them to confirm they're installed.

### 5. Bitcoin (the real kind, or testnet BTC)
- **DevNet**: regtest BTC (provided by the test environment)
- **Testnet**: free from a Bitcoin testnet faucet
- **Mainnet**: real BTC

### 6. BitSafe Minter/Holder credential
To create a deposit or withdraw account, your Canton party needs a credential issued by BitSafe authorizing it to use the bridge. Contact BitSafe at [docs.bitsafe.finance](https://docs.bitsafe.finance) to get this set up for your party.

---

## How minting works (BTC → cBTC)

Clicking "Generate deposit address" triggers a sequence of steps behind the scenes.

### Step 1 — cantonbit asks the bridge for its factory contract
The bridge publishes a shared contract called `CBTCDepositAccountRules`. cantonbit fetches its contract ID from the DLC.link coordinator. This is invisible to you — it happens in the background before the Loop popup appears.

### Step 2 — cantonbit creates a deposit account for you on Canton
A deposit account is a Canton contract that says: *"This party (you) wants to receive cBTC. When BTC arrives at the address linked to this account, mint cBTC for this party."*

Your Loop wallet pops up and asks you to approve creating this contract. Once created, it's reused on future mints — you won't be asked again.

### Step 3 — cantonbit asks the bridge for your Bitcoin deposit address
The bridge looks at your deposit account contract and assigns it a unique Bitcoin address. You'll see it as a QR code and copyable text. The address format depends on the network:
- DevNet: `bcrt1p…` (regtest)
- Testnet: `tb1p…` (testnet3)
- Mainnet: `bc1p…` (mainnet bech32m)

### Step 4 — You send BTC
Open your Bitcoin wallet, paste the address, send at least **0.001 BTC**. That's the minimum the bridge accepts.

### Step 5 — Wait (~60 minutes + a little more)
Bitcoin transactions need 6 confirmations before the bridge trusts them. That's roughly 60 minutes. After the 6th confirmation, the bridge's attestor network verifies the transaction — this takes an additional 60–120 seconds. Once complete, cBTC appears in your wallet.

cantonbit polls your balance every 30 seconds while you're on the mint page. You can also close the tab and come back — the bridge doesn't need cantonbit open to complete the mint.

### What can go wrong

| What you see | What it means |
|---|---|
| "Coordinator POST failed (530)" or "Cloudflare 1016" | The DLC.link bridge is temporarily down. Not fixable on your end. |
| Loop popup appears, then "transaction rejected" | Your party doesn't have a Minter credential from BitSafe, or the cBTC DARs aren't installed on the validator. |
| Loop popup never appears | Loop wallet isn't connected, or browser pop-ups are blocked. |
| BTC sent, 6 confirmations shown on a block explorer, but no cBTC after 2 hours | Contact BitSafe with your deposit account contract ID. |

---

## How redeeming works (cBTC → BTC)

You have cBTC. You want BTC back at a specific Bitcoin address.

### Step 1 — Enter amount and destination address
Pick how much cBTC to burn (minimum: 0.001 BTC). Paste a Bitcoin address you control.

**The address format must match the network** — a mainnet `bc1…` address will be rejected if you're on devnet.

### Step 2 — cantonbit creates a withdraw account
A withdraw account is the mirror of a deposit account: a Canton contract that says *"This party wants to withdraw to this specific Bitcoin address."*

If you've redeemed to this exact address before, the existing withdraw account is reused and no Loop popup appears for this step. If it's a new address, Loop asks you to approve creating one.

### Step 3 — cantonbit collects the burn context from the bridge
The burn transaction requires five additional contracts from the bridge to be included in the transaction data. cantonbit fetches these silently — no action needed from you.

### Step 4 — cantonbit selects which cBTC to burn
If you have multiple cBTC holdings (you might, if you've minted multiple times), cantonbit automatically selects the largest ones first until they cover the amount you requested.

### Step 5 — Loop popup: approve the burn
Approve. Canton burns the selected cBTC holdings. cantonbit shows the Canton transaction ID as confirmation.

### Step 6 — Bridge sends you BTC
The bridge's attestor network detects the burn on Canton and sends the matching BTC from its reserve to your destination address. This is out-of-band — cantonbit doesn't track this delivery. Check your destination Bitcoin address on a block explorer to confirm arrival.

### What can go wrong

| What you see | What it means |
|---|---|
| "Not enough spendable holdings" | You don't have enough cBTC, or some of it is locked in another in-flight transaction. Wait and try again. |
| "Transaction rejected" in Loop | The burn context from the bridge changed, or your party is missing a credential. |
| Burn confirmed on Canton, but BTC never arrives | Bridge issue. Share the Canton update ID shown in the app with BitSafe support. |

---

## UTXO limits

Canton tracks your cBTC as individual "holding" contracts — similar to Bitcoin UTXOs. There is a hard limit of **10 holdings** per party.

- At **8 holdings**: the app warns you that you're approaching the limit.
- At **10 holdings**: you cannot receive more cBTC until you redeem some.

If you're hitting this limit, redeem a portion of your cBTC first. This consolidates your holdings.

---

## Running cantonbit locally

```bash
# Install dependencies
npm install

# Set up environment
cp .env.example .env.local
# Edit .env.local — fill in KEYCLOAK_CLIENT_ID and KEYCLOAK_CLIENT_SECRET from Five North

# Start dev server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Connect your Loop wallet using the button in the top-right. Your cBTC balance will appear on the dashboard.

### Switching networks

In `.env.local`:

```
NEXT_PUBLIC_NETWORK=devnet    # or testnet or mainnet
```

Restart `npm run dev`. All URLs, party IDs, and BTC address format expectations update automatically.

---

## What this app deliberately does not do

- **Does not send cBTC between parties.** Out of scope for this version.
- **Does not show transaction history.** The activity tab is a placeholder — the history feed hasn't been built yet.
- **Does not custody anything.** cantonbit doesn't hold your keys. Your Loop wallet does. Your Bitcoin stays in the bridge's reserve, not in cantonbit.
- **Does not show real-time confirmation counts.** It polls your balance every 30 seconds. When the number goes up, mint is done.
- **Does not validate Bitcoin address formats client-side.** The bridge will reject a wrong-network address. Make sure you're pasting the right format.
- **Does not work if underlying services are down.** Five North validator, DLC.link coordinator, Loop wallet backend — any of these being unreachable breaks the relevant flow.

---

## Troubleshooting checklist

Work through these in order when something's broken:

1. **`.env.local` is missing or wrong.** Symptom: `/api/auth/token` returns 500, or the dashboard shows nothing. Fix: copy `.env.example`, fill in the three KEYCLOAK values, restart.

2. **DLC.link coordinator is down.** Symptom: "Generate deposit address" fails immediately with a 530 or 1016 error. Verify with:
   ```bash
   curl -X POST https://testnet.dlc.link/attestor-1/app/get-account-contract-rules \
     -H "Content-Type: application/json" \
     -d '{"chain":"canton-testnet"}'
   ```
   If testnet works but devnet doesn't, it's a DLC.link devnet outage. Contact them.

3. **Loop popup says transaction rejected.** Most likely: your party doesn't have a Minter/Holder credential from BitSafe. Contact [BitSafe support](https://docs.bitsafe.finance).

4. **Loop wallet not connected or stale session.** Symptom: clicking anything does nothing. Fix: disconnect and reconnect. If that fails, clear `localStorage` for `localhost:3000` in browser dev tools and reload.

5. **Balance shows 0 after a confirmed mint.** Check that cBTC DARs are installed on the validator: `curl http://localhost:3000/api/canton/packages` should return a count greater than 0. If not, ask Five North to install the DARs.

---

## Where to get help

| Who | What for | Link |
|---|---|---|
| **Five North** | Validator access, Authentik credentials, DAR installation | [docs.fivenorth.io](https://docs.fivenorth.io) |
| **BitSafe** | Minter/Holder credential, bridge issues, stuck mints | [docs.bitsafe.finance](https://docs.bitsafe.finance) |
| **DLC.link** | Coordinator outages | [github.com/DLC-link](https://github.com/DLC-link) |
| **Loop wallet** | Wallet connection, session issues | [cantonloop.com](https://cantonloop.com) |

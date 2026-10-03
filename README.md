# HoldPay

A mobile-first payment page for freelancers on Stellar. Set a price in USDC and a
short job note, share one link. The client opens it, connects a Stellar wallet,
and pays with **any asset they already hold** — the swap and the payment happen
in a single transaction, and the freelancer receives USDC.

No custom contract. No login. No backend database.

## How it works

The whole payment request lives **inside the link**. There is no invoice id and
nothing to look up: the freelancer's address, the price and the note are encoded
into the URL, and the client's browser decodes them locally. Clearing the link
leaves no trace anywhere.

Paying uses Stellar's **path payment, strict receive**:

- The price is fixed in USDC, so the destination amount is exact and the client
  authorises a `sendMax` in whatever asset they spend.
- `GET /paths/strict-receive` on Horizon prices the route across **every** asset
  the client holds, in one request.
- One transaction performs the swap and the payment. The freelancer receives
  exactly the price; the client never needs to hold USDC.

If Horizon returns no route for an asset, the page says **"cannot be quoted"** and
offers no number. A rate is never invented.

Everything runs in the browser. Horizon answers CORS for any origin, so there is
no server in the loop at all — the deployed app is fully static.

## Stack

- Next.js (App Router) + React + TypeScript, Tailwind v4, deployed on Vercel
- `@stellar/stellar-sdk` for quoting, transaction building and submission
- `@stellar/freighter-api` and `@lobstrco/signer-extension-api` for the two wallets

The wallets are talked to through their own official SDKs rather than an
all-in-one wallet kit, which would pull in WalletConnect, Reown, Trezor and
Ledger to sign a testnet payment.

## Wallet support

**Freighter** and **LOBSTR** browser extensions. Both sign a Stellar transaction
the same way; each is detected independently and a wallet that is not installed
says so rather than offering a button that cannot work.

Both must be set to **Testnet**. Freighter's network is read and a warning is
shown when it is pointed elsewhere. LOBSTR exposes no network query, so the page
asks the user to check rather than assuming.

## Running it

```bash
npm install
npm run dev          # http://localhost:3000
npm run typecheck
npm run build
```

## Verified against live testnet

`scripts/e2e.mjs` drives the real `lib/stellar.ts` — the same code the browser
runs — with a locally generated keypair standing in for the wallet. It creates
two funded testnet accounts, adds a USDC trustline for the payee, quotes a real
path, executes the payment, and reads the result back off the ledger.

```bash
node node_modules/typescript/lib/tsc.js lib/stellar.ts \
  --outDir .e2e-build --rootDir lib --module esnext --target es2022 \
  --moduleResolution bundler --skipLibCheck
node scripts/e2e.mjs
```

Last run, all checks passed: 5.00 USDC cost 5.2864221 XLM (1 USDC = 1.0573 XLM),
the freelancer received exactly 5 USDC, and an asset with no route produced no
quote.

## Receiving USDC

A Stellar account cannot hold USDC without a trustline. The freelancer page
checks the address as it is typed and, when it is missing, offers the two steps
that fix it — fund the account on testnet, then sign the USDC trustline with
their own wallet. Both are ordinary Stellar operations; neither involves a
contract.

The payment page performs the same check on the link's destination, so a client
is told up front when a link cannot be paid instead of after signing.

## Design

The UI is graded, not themed — one grade, amber into copper, used on the pay
button, the rate and a soft top wash, over warm paper (`#f4efe6`) with near-black
ink (`#1c1915`). Cards are off-white with a 1px warm border and a slight shadow.
Big price, small note, one button.

When a payment lands, the wash moves from amber to a muted olive (`#7d8f6a`), so
a settled page reads differently from an unpaid one at a glance.

The grade is defined once, as three RGB triplets in `app/globals.css`; every
surface derives from those, including the deepened amber used for the rate text.

## Scope

Stellar **testnet** only. Amounts, addresses and the price all sit in the link,
which is what makes it work with no backend — and also means a link is worth
exactly what it says and should be shared the way you would share a payment
request. Links the freelancer creates are remembered in that browser's local
storage and nowhere else.

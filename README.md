# HoldPay

A mobile-first payment page for freelancers on Stellar. Set a price in USDC and a
short job note, share one link. The client opens it, connects a Stellar wallet,
and pays with **any asset they already hold** — the swap, the payment and the
lock all happen in a single transaction, and the USDC is held for the freelancer
until they claim it.

No custom contract. No login. No backend database.

## How it works

There are two ways in, so a client who simply opens the site can still pay:

- **Get paid** — the freelancer sets an address, a price, a note and a hold
  period, and shares the resulting link.
- **Pay a link** — a client pastes a link, or a 72-character claim id, and lands
  straight on the payer page.

The payment request lives **inside the link**. There is no invoice id and nothing
to look up: the freelancer's address, the price, the note and the deadline are
encoded into the URL, and the client's browser decodes them locally. Clearing the
link leaves no trace anywhere.

### The lock

Paying does not send USDC straight across. One transaction does three things
atomically:

1. adds a USDC trustline for the client, if they do not have one;
2. runs a **path payment, strict receive, to the client's own address** — this is
   the swap that turns whatever they hold into exactly the USDC price;
3. **creates a claimable balance** of that USDC, with two claimants: the
   freelancer, unconditionally, and the client, only *after* the deadline.

The result is a lock with exactly three states:

| state | meaning |
| --- | --- |
| **waiting** | the balance is on the ledger, unclaimed |
| **paid** | the freelancer claimed it — the payment landed |
| **returned** | the deadline passed unclaimed, so the client took it back |

Claiming and reclaiming are the *same* Stellar operation
(`claimClaimableBalance`); the signer's address picks which claimant they are,
and the predicates decide whether it is allowed yet. So there is one code path
for both, and the ledger enforces the deadline rather than the page.

**The lock is funded by the client, and it has to be.** A claimable balance is
paid for out of its creator's own balance, and a freelancer setting up a link
holds no USDC — often not even a trustline. Naming a claimant costs nothing,
which is exactly why an account that cannot yet receive USDC can still be paid
this way. The freelancer adds the trustline at the moment they claim.

### No database

The claim id is derived from the client's transaction, so it is known **before**
anything is submitted, and it is what the client can hand back to the freelancer.
The page then resolves a lock's whole history from the chain:

- `GET /claimable_balances/{id}/operations` keeps returning a balance's operation
  history **even after the balance is claimed and deleted**, and it carries both
  the create operation (amount, claimants, predicates, funder) and the claim
  operation (who took it).
- `GET /claimable_balances?claimant={address}` lists every lock still standing
  for a freelancer — which is how their page shows what is waiting for them
  without storing anything.

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

## Wallet support, and the mobile limit

**Freighter** and **LOBSTR** browser extensions. Both sign a Stellar transaction
the same way; each is probed independently and a wallet that cannot answer says
so rather than offering a button that cannot work.

Both SDKs talk to their extension over `window.postMessage` and resolve when a
reply arrives. Neither rejects when there is no extension to answer, and only
*some* of their calls carry a timeout of their own:

| call | behaviour with no extension |
| --- | --- |
| `isConnected()` | settles after ~2 s, `false` |
| `requestAccess()` (Freighter) | **never settles** |
| `getPublicKey()` (LOBSTR) | **never settles** |
| `signTransaction()` (both) | **never settles** |

So the one call a page makes to *check* a wallet politely gives up, and the next
call — the one that connects — hangs for good. That is what an endless
"Connecting…" is. Every call in `lib/wallet.ts` is therefore bounded: detection
gives up after 2 seconds, connecting after 30, signing after 90, and each ceiling
becomes a sentence rather than a spinner.

**Inside the Freighter app on a phone**, the page is running in the wallet's own
browser, where the extension API is not injected — Freighter only sets
`window.stellar = { provider: "freighter", platform: "mobile" }`. That is
detectable, so the page detects it and says plainly that the app cannot sign for
a web page and the link should be opened in Safari or Chrome. The trustline step
is gated the same way, so it too fails with a sentence instead of hanging.

LOBSTR's in-app browser injects no documented API at all, so there is nothing to
detect and nothing to call; the page reports that no sign path is reachable here.

Neither wallet offers an in-app-browser signing API. The path that does work on a
phone is WalletConnect, which needs a Reown/WalletConnect project id — a
credential this app does not have. Rather than ship a button that spins forever,
HoldPay ships the bounded timeouts and says what it cannot do.

Both wallets must be set to **Testnet**. Freighter's network is read and a
warning is shown when it is pointed elsewhere. LOBSTR exposes no network query,
so the page asks the user to check rather than assuming.

## Running it

```bash
npm install
npm run dev          # http://localhost:3000
npm run typecheck
npm run build
```

## Verified against live testnet

`scripts/e2e.mjs` drives the real `lib/stellar.ts` — the same code the browser
runs — with locally generated keypairs standing in for the wallets. It funds two
testnet accounts and walks a payment through its whole life: lock, pay, and a
second lock left unclaimed so it can be returned.

```bash
node node_modules/typescript/lib/tsc.js lib/stellar.ts \
  --outDir .e2e-build --rootDir lib --module esnext --target es2022 \
  --moduleResolution bundler --skipLibCheck
node scripts/e2e.mjs
```

It checks, among other things, that:

- the freelancer is named as a claimant **while holding no USDC trustline**;
- the claim id computed before submitting is the one the ledger holds — for both
  operation layouts, with and without the client's trustline operation;
- the lock reads back as `waiting` → `paid` / `returned` purely from the chain;
- the claimed balance 404s, yet its history still resolves the state;
- the client's money comes back after an unclaimed lock expires;
- an asset with no route produces no quote.

Last run, all 28 checks passed. The three transactions it produced are on the
landing page under "A worked example, on testnet", and are kept in
`lib/proof.ts`. 5.00 USDC cost 5.2900451 XLM (1 USDC = 1.0580 XLM).

## Receiving USDC

A Stellar account cannot **hold** USDC without a trustline. The freelancer page
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

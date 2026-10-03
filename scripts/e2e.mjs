/**
 * End-to-end check against Stellar testnet.
 *
 * This drives the real `lib/stellar.ts` — the same code the browser runs — with
 * a locally generated keypair standing in for the wallet extension. It creates
 * two funded testnet accounts, adds a USDC trustline for the payee, quotes a
 * real path, executes the path payment, and reads the result back off the
 * ledger. Every step except the wallet's own signing UI is exercised.
 *
 *   node node_modules/typescript/lib/tsc.js lib/stellar.ts \
 *     --outDir .e2e-build --rootDir lib --module esnext --target es2022 \
 *     --moduleResolution bundler --skipLibCheck
 *   node scripts/e2e.mjs
 */
import { Asset, Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import {
  FRIENDBOT_URL,
  USDC,
  buildPathPayment,
  buildTrustline,
  checkDestination,
  loadAccount,
  nextSequence,
  quoteAll,
  readLandedPayment,
  shortAddress,
  submitSignedXdr,
  toStellarAmount,
} from "../.e2e-build/stellar.js";

const PRICE_USDC = 5;

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function friendbot(address) {
  const response = await fetch(`${FRIENDBOT_URL}/?addr=${encodeURIComponent(address)}`);
  if (!response.ok) throw new Error(`friendbot ${response.status}: ${await response.text()}`);
  return response.json();
}

/** Stands in for the wallet extension: sign the XDR, hand back the signed XDR. */
function walletSign(keypair, xdr) {
  const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
  tx.sign(keypair);
  return tx.toXDR();
}

async function main() {
  console.log("\n== HoldPay end-to-end on Stellar testnet ==\n");

  const payer = Keypair.random();
  const payee = Keypair.random();
  console.log(`payer (client)     ${shortAddress(payer.publicKey(), 8, 8)}`);
  console.log(`payee (freelancer) ${shortAddress(payee.publicKey(), 8, 8)}\n`);

  console.log("1. Fund both accounts from friendbot");
  await Promise.all([friendbot(payer.publicKey()), friendbot(payee.publicKey())]);
  check("both accounts funded", true);

  console.log("\n2. Destination check before the payee can receive USDC");
  const before = await checkDestination(payee.publicKey());
  check(
    "payee flagged as having no USDC trustline",
    before.kind === "no-trustline",
    before.kind,
  );

  console.log("\n3. Payee adds a USDC trustline (the same op the freelancer page signs)");
  const trustSequence = await nextSequence(payee.publicKey());
  const trustSigned = walletSign(payee, buildTrustline(payee.publicKey(), trustSequence).toXDR());
  const trustResult = await submitSignedXdr(trustSigned);
  check("trustline transaction succeeded", trustResult.successful, trustResult.hash);

  const after = await checkDestination(payee.publicKey());
  check("payee now ready to receive USDC", after.kind === "ok", after.kind);

  console.log("\n4. Quote: what does the payer hold, and what does the price cost?");
  const account = await loadAccount(payer.publicKey());
  check("payer holdings read", account.held.length > 0, account.held.map((h) => h.code).join(", "));

  const quotes = await quoteAll(account.held, PRICE_USDC);
  const native = account.held.find((held) => held.isNative);
  const quote = native ? quotes.get(native.key) : undefined;
  check("a real rate was quoted for XLM", Boolean(quote));

  if (!quote) {
    console.log("\nNo quote came back, so the payment cannot be attempted.");
    process.exit(1);
  }
  console.log(
    `     ${PRICE_USDC.toFixed(2)} USDC costs ${quote.sourceAmount} XLM` +
      ` (rate 1 USDC = ${quote.rate.toFixed(4)} XLM, sendMax ${quote.sendMax.toFixed(7)})`,
  );

  console.log("\n5. An asset with no route must not produce a rate");
  const noRoute = new Asset("ZZZZ", payee.publicKey());
  const emptyQuotes = await quoteAll(
    [{ asset: noRoute, key: noRoute.toString(), code: "ZZZZ", balance: 100, spendable: 100, isNative: false }],
    PRICE_USDC,
  );
  check("no path means no quote (nothing is invented)", emptyQuotes.size === 0);

  console.log("\n6. Pay: one transaction swaps and pays");
  const sequence = await nextSequence(payer.publicKey());
  const transaction = buildPathPayment(
    {
      sourceAddress: payer.publicKey(),
      destination: payee.publicKey(),
      sendAsset: native.asset,
      sendMax: toStellarAmount(Math.min(quote.sendMax, native.spendable)),
      destAmount: toStellarAmount(PRICE_USDC),
      path: quote.path,
    },
    sequence,
  );

  const signed = walletSign(payer, transaction.toXDR());
  const submitted = await submitSignedXdr(signed);
  check("path payment submitted", submitted.successful, submitted.hash);

  console.log("\n7. Read the receipt back off the ledger");
  const landed = await readLandedPayment(submitted.hash);
  check("transaction recorded as successful", landed.successful);
  check(
    "freelancer received exactly the price in USDC",
    landed.delivered === PRICE_USDC,
    `delivered ${landed.delivered} USDC`,
  );
  check(
    "the asset actually spent is reported",
    landed.spentCode === "XLM" && landed.spentAmount > 0,
    `spent ${landed.spentAmount} ${landed.spentCode}`,
  );

  const payeeAccount = await loadAccount(payee.publicKey());
  const usdcLine = payeeAccount.held.find((held) => held.key === USDC.toString());
  check(
    "USDC is now sitting in the freelancer's wallet",
    Boolean(usdcLine) && Math.abs(usdcLine.balance - PRICE_USDC) < 1e-6,
    usdcLine ? `${usdcLine.balance} USDC` : "no USDC line",
  );

  console.log(`\n  explorer: https://stellar.expert/explorer/testnet/tx/${submitted.hash}`);
  console.log(
    failures === 0
      ? "\nAll checks passed.\n"
      : `\n${failures} check(s) failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\nE2E run threw:", error?.response?.data ?? error);
  process.exit(1);
});

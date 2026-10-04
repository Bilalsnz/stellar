/**
 * End-to-end check against Stellar testnet.
 *
 * This drives the real `lib/stellar.ts` — the same code the browser runs — with
 * locally generated keypairs standing in for the wallet extensions. It creates
 * two funded testnet accounts and walks a payment through its whole life: the
 * client locks the money, the freelancer claims it, and a second lock is left
 * unclaimed so the client can take it back.
 *
 *   node node_modules/typescript/lib/tsc.js lib/stellar.ts \
 *     --outDir .e2e-build --rootDir lib --module esnext --target es2022 \
 *     --moduleResolution bundler --skipLibCheck
 *   node scripts/e2e.mjs
 */
import { Asset, Horizon, Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import {
  FRIENDBOT_URL,
  HORIZON_URL,
  USDC,
  buildClaim,
  buildLockedPayment,
  buildTrustline,
  checkDestination,
  loadAccount,
  nextSequence,
  quoteAll,
  readLandedPayment,
  readLock,
  shortAddress,
  submitSignedXdr,
  toStellarAmount,
} from "../.e2e-build/stellar.js";

const PRICE_USDC = 5;

/** How far ahead the throwaway lock's deadline is set, in seconds. */
const SHORT_DEADLINE_SECONDS = 12;

const server = new Horizon.Server(HORIZON_URL);

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

/**
 * Does Horizon itself index a balance under this id, for this claimant?
 *
 * A create_claimable_balance operation record carries the amount, the claimants
 * and the predicates, but not the balance id — so the claimant listing is where
 * the ledger's own answer lives. It is also exactly the call the freelancer's
 * page uses to find their locks with no database behind it.
 */
async function ledgerHoldsBalance(claimId, claimant) {
  const page = await server.claimableBalances().claimant(claimant).call();
  return page.records.some((record) => record.id === claimId);
}

async function balanceIsGone(claimId) {
  try {
    await server.claimableBalances().claimableBalance(claimId).call();
    return false;
  } catch (error) {
    return error?.response?.status === 404;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  console.log("\n== HoldPay end-to-end on Stellar testnet ==\n");

  const payer = Keypair.random();
  const payee = Keypair.random();
  console.log(`payer (client)     ${shortAddress(payer.publicKey(), 8, 8)}`);
  console.log(`payee (freelancer) ${shortAddress(payee.publicKey(), 8, 8)}\n`);

  console.log("1. Fund both accounts from friendbot");
  await Promise.all([friendbot(payer.publicKey()), friendbot(payee.publicKey())]);
  check("both accounts funded", true);

  console.log("\n2. The freelancer's starting point: an account with no USDC trustline");
  const before = await checkDestination(payee.publicKey());
  check("payee flagged as having no USDC trustline", before.kind === "no-trustline", before.kind);

  console.log("\n3. Lock: the client's one transaction swaps and locks the money");
  const held = await loadAccount(payer.publicKey());
  check("payer holdings read", held.held.length > 0, held.held.map((h) => h.code).join(", "));

  const quotes = await quoteAll(held.held, PRICE_USDC);
  const native = held.held.find((asset) => asset.isNative);
  const quote = native ? quotes.get(native.key) : undefined;
  check("a real rate was quoted for XLM", Boolean(quote));

  if (!quote) {
    console.log("\nNo quote came back, so the payment cannot be attempted.");
    process.exit(1);
  }
  console.log(
    `     ${PRICE_USDC.toFixed(2)} USDC costs ${quote.sourceAmount} XLM` +
      ` (rate 1 USDC = ${quote.rate.toFixed(4)} XLM)`,
  );

  const deadline = Math.floor(Date.now() / 1000) + 7 * 86_400;
  const lockPlan = {
    sourceAddress: payer.publicKey(),
    destination: payee.publicKey(),
    sendAsset: native.asset,
    sendMax: toStellarAmount(Math.min(quote.sendMax, native.spendable)),
    destAmount: toStellarAmount(PRICE_USDC),
    path: quote.path,
    deadline,
    // The payer holds no USDC line of their own yet, so the swap needs one.
    addTrustline: true,
  };

  const lockSequence = await nextSequence(payer.publicKey());
  const lock = buildLockedPayment(lockPlan, lockSequence);
  check(
    "claim id is known before submitting",
    /^[0-9a-f]{72}$/.test(lock.claimId),
    lock.claimId,
  );

  const lockResult = await submitSignedXdr(walletSign(payer, lock.transaction.toXDR()));
  check("lock submitted", lockResult.successful, lockResult.hash);

  const ledgerId = await ledgerHoldsBalance(lock.claimId, payee.publicKey());
  check(
    "the claim id we computed is the one the ledger holds",
    ledgerId,
    lock.claimId,
  );

  console.log("\n4. Read the lock back with no database of any kind");
  const waiting = await readLock(lock.claimId);
  check("state is waiting", waiting.status === "waiting", waiting.status);
  check("amount is the price", waiting.amount === PRICE_USDC, `${waiting.amount} USDC`);
  check("destined to the freelancer", waiting.destination === payee.publicKey());
  check("funded by the client", waiting.funder === payer.publicKey());
  check("deadline came back off the predicate", waiting.deadline === deadline, String(waiting.deadline));
  check("the lock transaction is recorded", waiting.lockHash === lockResult.hash);

  const receipt = await readLandedPayment(lockResult.hash);
  check(
    "the swap delivered exactly the price",
    receipt.delivered === PRICE_USDC,
    `delivered ${receipt.delivered} USDC for ${receipt.spentAmount} ${receipt.spentCode}`,
  );

  console.log("\n5. The freelancer adds the trustline they need to hold USDC");
  const trustSequence = await nextSequence(payee.publicKey());
  const trustResult = await submitSignedXdr(
    walletSign(payee, buildTrustline(payee.publicKey(), trustSequence).toXDR()),
  );
  check("trustline transaction succeeded", trustResult.successful, trustResult.hash);

  const after = await checkDestination(payee.publicKey());
  check("payee now ready to receive USDC", after.kind === "ok", after.kind);

  console.log("\n6. Pay: the freelancer claims the lock");
  const claimSequence = await nextSequence(payee.publicKey());
  const claimResult = await submitSignedXdr(
    walletSign(payee, buildClaim(lock.claimId, payee.publicKey(), claimSequence).toXDR()),
  );
  check("claim submitted", claimResult.successful, claimResult.hash);

  const paid = await readLock(lock.claimId);
  check("state is paid", paid.status === "paid", paid.status);
  check("the freelancer is who took it", paid.claimedBy === payee.publicKey());
  check("the claim transaction is recorded", paid.claimHash === claimResult.hash);

  const payeeAccount = await loadAccount(payee.publicKey());
  const usdcLine = payeeAccount.held.find((line) => line.key === USDC.toString());
  check(
    "USDC is now sitting in the freelancer's wallet",
    Boolean(usdcLine) && Math.abs(usdcLine.balance - PRICE_USDC) < 1e-6,
    usdcLine ? `${usdcLine.balance} USDC` : "no USDC line",
  );

  check(
    "the balance itself is gone, yet its history still resolves the state",
    (await balanceIsGone(lock.claimId)) && paid.status === "paid",
  );

  console.log("\n7. Return: a lock nobody claims goes back to the client");
  const payerBefore = await loadAccount(payer.publicKey());
  const payerUsdcBefore =
    payerBefore.held.find((line) => line.key === USDC.toString())?.balance ?? 0;

  // This payer now holds a USDC line, so no trustline op is added — a different
  // operation index, and therefore a different claim id derivation.
  const shortDeadline = Math.floor(Date.now() / 1000) + SHORT_DEADLINE_SECONDS;
  const secondPlan = { ...lockPlan, deadline: shortDeadline, addTrustline: false };

  const secondSequence = await nextSequence(payer.publicKey());
  const second = buildLockedPayment(secondPlan, secondSequence);

  const secondResult = await submitSignedXdr(walletSign(payer, second.transaction.toXDR()));
  check("second lock submitted", secondResult.successful, secondResult.hash);
  check(
    "its claim id is also the one the ledger holds",
    await ledgerHoldsBalance(second.claimId, payee.publicKey()),
    second.claimId,
  );

  const held2 = await readLock(second.claimId);
  check("second lock starts waiting", held2.status === "waiting", held2.status);

  // The predicate is evaluated against ledger close time, and ledgers close
  // every few seconds, so give it both the deadline and a close.
  const waitMs = (shortDeadline - Math.floor(Date.now() / 1000)) * 1000 + 8000;
  if (waitMs > 0) {
    console.log(`     waiting ${Math.ceil(waitMs / 1000)}s for the deadline to pass…`);
    await sleep(waitMs);
  }

  const reclaimSequence = await nextSequence(payer.publicKey());
  const reclaimResult = await submitSignedXdr(
    walletSign(payer, buildClaim(second.claimId, payer.publicKey(), reclaimSequence).toXDR()),
  );
  check("reclaim submitted", reclaimResult.successful, reclaimResult.hash);

  const returned = await readLock(second.claimId);
  check("state is returned", returned.status === "returned", returned.status);
  check("the client is who took it back", returned.claimedBy === payer.publicKey());
  check("the return transaction is recorded", returned.claimHash === reclaimResult.hash);

  const payerAfter = await loadAccount(payer.publicKey());
  const payerUsdcAfter = payerAfter.held.find((line) => line.key === USDC.toString())?.balance ?? 0;
  check(
    "the client has their money back",
    Math.abs(payerUsdcAfter - payerUsdcBefore - PRICE_USDC) < 1e-6,
    `${payerUsdcBefore} → ${payerUsdcAfter} USDC`,
  );

  console.log("\n8. An asset with no route must not produce a rate");
  const noRoute = new Asset("ZZZZ", payee.publicKey());
  const emptyQuotes = await quoteAll(
    [
      {
        asset: noRoute,
        key: noRoute.toString(),
        code: "ZZZZ",
        balance: 100,
        spendable: 100,
        isNative: false,
      },
    ],
    PRICE_USDC,
  );
  check("no path means no quote (nothing is invented)", emptyQuotes.size === 0);

  console.log("\n  the three transactions");
  console.log(`  lock   ${lockResult.hash}`);
  console.log(`  pay    ${claimResult.hash}`);
  console.log(`  return ${reclaimResult.hash}`);
  console.log("\n  explorer:");
  for (const [label, hash] of [
    ["lock  ", lockResult.hash],
    ["pay   ", claimResult.hash],
    ["return", reclaimResult.hash],
  ]) {
    console.log(`  ${label} https://stellar.expert/explorer/testnet/tx/${hash}`);
  }

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) failed.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\nE2E run threw:", error?.response?.data ?? error);
  process.exit(1);
});

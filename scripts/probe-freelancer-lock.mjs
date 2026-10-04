/**
 * Why the client funds the lock, in the ledger's own words.
 *
 * The brief asked for the freelancer to create the USDC claimable balance when
 * they create the link. This script tries every route a fresh freelancer
 * account could take, and prints the error code the network returns for each.
 *
 *   node scripts/probe-freelancer-lock.mjs
 *
 * The telling row is the third: the *same* account that cannot lock USDC locks
 * XLM without trouble, because XLM is what it actually holds.
 */
import {
  Asset,
  BASE_FEE,
  Claimant,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

const HORIZON = "https://horizon-testnet.stellar.org";
const FRIENDBOT = "https://friendbot.stellar.org";
const USDC = new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
const server = new Horizon.Server(HORIZON);

async function friendbot(address) {
  const response = await fetch(`${FRIENDBOT}/?addr=${encodeURIComponent(address)}`);
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
}

async function addTrustline(keypair) {
  const tx = new TransactionBuilder(await server.loadAccount(keypair.publicKey()), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.changeTrust({ asset: USDC }))
    .setTimeout(60)
    .build();
  tx.sign(keypair);
  await server.submitTransaction(tx);
}

async function attempt(label, keypair, buildOperation) {
  const tx = new TransactionBuilder(await server.loadAccount(keypair.publicKey()), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(buildOperation())
    .setTimeout(60)
    .build();
  tx.sign(keypair);

  try {
    const result = await server.submitTransaction(tx);
    console.log(`  succeeded  ${label}\n             ${result.hash}`);
    return true;
  } catch (error) {
    const data = error?.response?.data;
    const codes = data?.extras?.result_codes;
    console.log(`  rejected   ${label}`);
    console.log(
      `             transaction=${codes?.transaction} operations=${JSON.stringify(
        codes?.operations ?? [],
      )}`,
    );
    return false;
  }
}

async function main() {
  console.log("\n== Who can fund the lock? ==\n");

  const freelancer = Keypair.random();
  const client = Keypair.random();
  console.log(`freelancer ${freelancer.publicKey()}`);
  console.log(`client     ${client.publicKey()}\n`);

  await Promise.all([friendbot(freelancer.publicKey()), friendbot(client.publicKey())]);

  const deadline = Math.floor(Date.now() / 1000) + 86_400;
  const claimants = [
    new Claimant(freelancer.publicKey()),
    new Claimant(
      client.publicKey(),
      Claimant.predicateNot(Claimant.predicateBeforeAbsoluteTime(String(deadline))),
    ),
  ];

  console.log("1. The freelancer's account as the form leaves it: funded, no USDC line");
  await attempt("lock 5 USDC with no trustline", freelancer, () =>
    Operation.createClaimableBalance({ asset: USDC, amount: "5.0000000", claimants }),
  );

  console.log("\n2. The freelancer opens the trustline, still holding nothing");
  await addTrustline(freelancer);
  console.log("  trustline added");
  await attempt("lock 5 USDC holding 0 USDC", freelancer, () =>
    Operation.createClaimableBalance({ asset: USDC, amount: "5.0000000", claimants }),
  );

  console.log("\n3. The same account, locking an asset it does hold");
  await attempt("lock 1 XLM", freelancer, () =>
    Operation.createClaimableBalance({ asset: Asset.native(), amount: "1.0000000", claimants }),
  );

  console.log("\n4. And the client, once it holds the USDC the swap produced");
  await addTrustline(client);
  await attempt("lock 0.0000001 USDC holding 0 USDC", client, () =>
    Operation.createClaimableBalance({ asset: USDC, amount: "0.0000001", claimants }),
  );

  console.log(
    "\nAn account can only lock what it holds. The client is the one that holds\n" +
      "USDC — for one operation, between the swap and the lock.\n",
  );
}

main().catch((error) => {
  console.error("probe threw:", error?.response?.data ?? error);
  process.exit(1);
});

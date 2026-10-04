/**
 * Does the WalletConnect path actually reach Freighter?
 *
 * There is one thing a script cannot do: approve on a phone. Everything up to
 * that point is checkable, and it is the part most likely to be wrong — a bad
 * project id, a namespace the relay refuses, a chain id it does not know, a
 * malformed deep link. So this drives the real `lib/walletconnect.ts` and stops
 * at the moment a human would pick up their phone.
 *
 *   node scripts/probe-walletconnect.mjs
 *
 * It proves:
 *   1. the relay accepts the project id and opens a pairing topic;
 *   2. the `stellar:testnet` namespace survives relay validation;
 *   3. a pairing code is emitted — the thing the QR code and deep link carry;
 *   4. the deep link is well formed for Freighter's registered scheme.
 *
 * It cannot prove a wallet approved, and it does not claim to.
 */
import {
  FREIGHTER_DEEP_LINK,
  WC_CHAIN,
  WC_PROJECT_ID,
  connectWalletConnect,
  freighterDeepLink,
} from "../.e2e-build/walletconnect.js";

const results = [];
function check(label, passed, detail) {
  results.push({ label, passed, detail });
  console.log(`  ${passed ? "pass" : "FAIL"}  ${label}${detail ? `\n        ${detail}` : ""}`);
}

const started = Date.now();
let uri = null;
let connectError = null;
let connectedAs = null;

const attempt = connectWalletConnect((emitted) => {
  uri = emitted;
})
  .then((address) => {
    connectedAs = address;
  })
  .catch((error) => {
    connectError = error instanceof Error ? error.message : String(error);
  });

// Give the relay time to answer, then stop. Nothing here waits for a phone.
while (!uri && !connectError && Date.now() - started < 25_000) {
  await new Promise((resolve) => setTimeout(resolve, 250));
}

console.log("\n== Can this page reach Freighter over WalletConnect? ==\n");
console.log(`project id   ${WC_PROJECT_ID}`);
console.log(`chain        ${WC_CHAIN}\n`);

check(
  "the relay answered at all",
  Boolean(uri) || Boolean(connectError),
  uri ? null : `connect said: ${connectError}`,
);

if (uri) {
  // A pairing code only exists if the relay accepted the project id and
  // published the proposal, so its presence is the whole of checks 1 and 2.
  check("a pairing code was produced", uri.startsWith("wc:"), `${uri.slice(0, 48)}…`);

  const relay = new URLSearchParams(uri.split("?")[1] ?? "");
  check(
    "the code carries a pairing topic and a symmetric key",
    /^wc:[0-9a-f]{64}@2$/.test(uri.split("?")[0]) && Boolean(relay.get("symKey")),
    uri.split("?")[0],
  );

  const deepLink = freighterDeepLink(uri);
  check(
    "the deep link uses Freighter's registered scheme",
    deepLink.startsWith(`${FREIGHTER_DEEP_LINK}?uri=`),
    `${deepLink.slice(0, 64)}…`,
  );
  check(
    "the deep link round-trips to the same code",
    decodeURIComponent(deepLink.split("uri=")[1]) === uri,
  );
} else {
  check("a pairing code was produced", false, "no code arrived");
}

check(
  "the connect call was still waiting for a wallet, not failed",
  connectedAs === null && connectError === null,
  connectedAs
    ? `unexpectedly connected as ${connectedAs}`
    : connectError
      ? `failed early: ${connectError}`
      : "waiting for approval, as expected",
);

console.log("");
const failed = results.filter((result) => !result.passed);
console.log(
  failed.length === 0
    ? `All ${results.length} checks passed. The page can reach Freighter; a phone still has to approve.\n`
    : `${failed.length} of ${results.length} checks failed.\n`,
);

// The pairing is deliberately left open; there is no wallet here to answer it.
void attempt;
process.exit(failed.length === 0 ? 0 : 1);

/**
 * Freighter over WalletConnect.
 *
 * This is the path that works on a phone. Freighter's mobile app injects no
 * extension API into a web page — it only announces itself — so there is nothing
 * a page can `postMessage` to. WalletConnect is the route Freighter actually
 * supports on mobile, and it needs no injected object at all: the page asks a
 * relay for a pairing code, the wallet scans or opens it, and signing travels
 * back over the relay.
 *
 * Because there is no injected object to probe, this option is always offered.
 * That is what keeps "Not installed in this browser" from ever being the only
 * thing a phone user is shown.
 *
 * The pairing code is available *before* the connection completes — the provider
 * emits it while it is still waiting for the wallet — which is what lets the page
 * draw a QR code and offer a deep link for the whole time it is waiting.
 *
 * ## The deep link
 *
 * There is no documented `freighter://` scheme, and the docs say not to invent
 * one. The real one is published in Freighter's own entry in the WalletConnect
 * wallet registry (the same registry the standard modal reads):
 *
 *   mobile.native = "freighterwallet://wc-redirect"
 *
 * WalletConnect's convention is to append `?uri=<percent-encoded pairing code>`
 * to that base, the same way `metamask://wc?uri=…` is built. The registry entry
 * also lists `chains: ["stellar:pubnet", "stellar:testnet"]`, which is where the
 * chain id below is confirmed rather than guessed.
 *
 * Nothing in this file runs on the server: the provider is imported lazily and
 * only from a click handler.
 */

/**
 * Reown project id. This is a public, client-side identifier — it is designed to
 * ship in the bundle, and it is what the relay uses to attribute the connection.
 */
export const WC_PROJECT_ID = "dbda47890bb3cdfd40d3cccca99970cc";

/** CAIP-2 chain id. Freighter's registry entry lists both pubnet and testnet. */
export const WC_CHAIN = "stellar:testnet";

/**
 * The methods the wallet must agree to before the session is approved. A method
 * missing from this list is not routed to the wallet at all, so the signing call
 * below would fail rather than prompt.
 */
const WC_METHODS = [
  "stellar_signXDR",
  "stellar_signAndSubmitXDR",
  "stellar_signMessage",
  "stellar_signAuthEntry",
];

/** Freighter's registered deep-link base, from the WalletConnect wallet registry. */
export const FREIGHTER_DEEP_LINK = "freighterwallet://wc-redirect";

/**
 * The pairing code is useless without somewhere to send the user, and the two
 * cases differ: a phone cannot scan its own screen, and a desktop cannot open a
 * phone app. So the page offers both and lets the person pick.
 *
 * Whether to join with `?` or `&` depends on the *base* URL — never on the code,
 * which always carries a query of its own (`…@2?relay-protocol=irn&symKey=…`)
 * and would otherwise produce a link with no query at all.
 */
export function freighterDeepLink(uri: string): string {
  const separator = FREIGHTER_DEEP_LINK.includes("?") ? "&" : "?";
  return `${FREIGHTER_DEEP_LINK}${separator}uri=${encodeURIComponent(uri)}`;
}

/** Same ceilings as the extension path, so no wallet waits longer than another. */
const CONNECT_TIMEOUT_MS = 30_000;
const SIGN_TIMEOUT_MS = 90_000;

/**
 * `UniversalProvider` is the default export of the package, so the instance type
 * has to be taken from it rather than from a named type export.
 */
type Provider = InstanceType<typeof import("@walletconnect/universal-provider").default>;

/** CAIP-10 accounts, keyed by namespace, as they come back in a session. */
type SessionNamespaces = Record<string, { accounts?: string[] } | undefined>;

/** Reject rather than hang. The relay can go quiet without ever saying so. */
function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

let pending: Promise<Provider> | null = null;

/**
 * One provider for the page. It is created on first use and kept, because it
 * holds the session: signing later must not have to pair again.
 */
async function provider(): Promise<Provider> {
  if (!pending) {
    pending = (async () => {
      const { UniversalProvider } = await import("@walletconnect/universal-provider");
      return UniversalProvider.init({
        projectId: WC_PROJECT_ID,
        metadata: {
          name: "HoldPay",
          description: "A one-link USDC payment page for freelancers, on Stellar.",
          url: typeof window === "undefined" ? "" : window.location.origin,
          icons: [],
        },
      });
    })();
    // A failed init must not be cached, or every later tap would fail too.
    pending.catch(() => {
      pending = null;
    });
  }
  return pending;
}

/**
 * The address the wallet approved, read out of the session's CAIP-10 accounts
 * (`stellar:testnet:G…`). Testnet is preferred, since that is what was asked for,
 * but any Stellar account is better than refusing a session that did connect.
 */
function addressOf(instance: Provider): string | null {
  const namespaces = (instance.session?.namespaces ?? {}) as SessionNamespaces;
  const candidates: string[] = [];

  for (const [key, namespace] of Object.entries(namespaces)) {
    if (!key.startsWith("stellar")) continue;
    for (const account of namespace?.accounts ?? []) {
      const parts = account.split(":");
      if (parts.length >= 3 && parts[2]) candidates.push(parts.slice(1).join(":"));
    }
  }

  const testnet = candidates.find((account) => account.startsWith("testnet:"));
  const chosen = testnet ?? candidates[0];
  return chosen ? chosen.slice(chosen.indexOf(":") + 1) : null;
}

/** The pairing code currently on screen, for the QR code and the deep link. */
let currentUri: string | null = null;
const uriListeners = new Set<(uri: string | null) => void>();

function publishUri(uri: string | null): void {
  currentUri = uri;
  for (const listener of uriListeners) listener(uri);
}

export function walletConnectUri(): string | null {
  return currentUri;
}

export function subscribeWalletConnectUri(listener: (uri: string | null) => void): () => void {
  uriListeners.add(listener);
  return () => {
    uriListeners.delete(listener);
  };
}

/** Called by the page once the flow is over, so a stale code is not left up. */
export function clearWalletConnectUri(): void {
  publishUri(null);
}

/**
 * Pair with Freighter, and return the address once the wallet approves.
 *
 * `onUri` fires as soon as the pairing code exists — which is before the wallet
 * has done anything — so the caller can put a QR code and a deep link on screen
 * for the whole wait.
 */
export async function connectWalletConnect(
  onUri?: (uri: string) => void,
): Promise<string> {
  const instance = await withTimeout(
    provider(),
    CONNECT_TIMEOUT_MS,
    "Could not reach the WalletConnect relay. Check the connection and tap again.",
  );

  // A previous attempt may have been approved after we stopped waiting for it.
  const existing = addressOf(instance);
  if (existing) return existing;

  const report = (uri: string) => {
    publishUri(uri);
    onUri?.(uri);
  };

  instance.on("display_uri", report);
  try {
    await withTimeout(
      instance.connect({
        namespaces: {
          stellar: { chains: [WC_CHAIN], methods: WC_METHODS, events: ["accountsChanged"] },
        },
      }),
      CONNECT_TIMEOUT_MS,
      "No wallet answered that code. Nothing was sent — tap again for a fresh one.",
    );
  } finally {
    instance.off("display_uri", report);
  }

  const address = addressOf(instance);
  if (!address) {
    throw new Error("Freighter connected but returned no Stellar address. Tap again.");
  }
  return address;
}

/**
 * Sign with the paired wallet. The relay returns the signed envelope under
 * `signedXDR` — note that the extension API calls the same thing `signedTxXdr`,
 * and reading the wrong one silently looks like an empty response.
 */
export async function signWalletConnect(xdr: string): Promise<string> {
  const instance = await provider();

  if (!instance.session) {
    throw new Error("Freighter is not connected. Connect it, then try again.");
  }

  const result = await withTimeout(
    instance.request<{ signedXDR?: string }>(
      { method: "stellar_signXDR", params: { xdr } },
      WC_CHAIN,
    ),
    SIGN_TIMEOUT_MS,
    "Freighter did not answer. The transaction was not signed and nothing was sent.",
  );

  const signed = result?.signedXDR;
  if (!signed) {
    throw new Error("Freighter returned nothing to submit.");
  }
  return signed;
}

/** Drop the session. Best-effort: a failure here must not block the page. */
export async function disconnectWalletConnect(): Promise<void> {
  const instance = await pending?.catch(() => null);
  publishUri(null);
  if (!instance?.session) return;
  try {
    await instance.disconnect();
  } catch {
    /* The session is going away either way. */
  }
}

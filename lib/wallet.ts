import { NETWORK_PASSPHRASE } from "./stellar";

/**
 * One small adapter per wallet, talking to each wallet's own official SDK.
 * We deliberately avoid the all-in-one wallet kits: they pull in WalletConnect,
 * Reown, Trezor and Ledger, and none of that is needed to sign a testnet
 * payment with the two wallets this page supports.
 *
 * Both SDKs are imported lazily so nothing touches `window` while the page is
 * being rendered on the server.
 *
 * ## Why every call here is bounded
 *
 * Both SDKs speak to their extension over `window.postMessage` and resolve when
 * a reply comes back. Neither one ever rejects when there is no extension to
 * answer, and only *some* of their message types carry a timeout of their own:
 *
 *   isConnected()      — settles after ~2s with `false`
 *   requestAccess()    — never settles          (Freighter)
 *   getPublicKey()     — never settles          (LOBSTR)
 *   signTransaction()  — never settles          (both)
 *
 * So the one call a page makes to *check* a wallet politely gives up, and the
 * very next call — the one that actually connects — hangs for good. On a phone
 * that is what an endless "Connecting…" is. Nothing below is allowed to wait
 * forever: detection gives up fast, and connecting and signing have real
 * ceilings that turn into a sentence the user can read.
 */

export type WalletId = "freighter" | "lobstr";

export interface WalletOption {
  id: WalletId;
  name: string;
  blurb: string;
}

export const WALLETS: WalletOption[] = [
  { id: "freighter", name: "Freighter", blurb: "Browser extension" },
  { id: "lobstr", name: "LOBSTR", blurb: "Browser extension" },
];

/**
 * Detection is a yes/no question about this browser, so it must not be allowed
 * to take longer than a glance. This is the ceiling the page waits before it
 * decides a wallet is not reachable.
 */
const DETECT_TIMEOUT_MS = 2000;

/** Long enough to unlock a wallet and approve, short enough to be an answer. */
const CONNECT_TIMEOUT_MS = 30_000;

/** Signing a payment is deliberate, so it is given more room than connecting. */
const SIGN_TIMEOUT_MS = 90_000;

export interface Connection {
  address: string;
  /** Set when the wallet is reachable but pointed at another network. */
  warning?: string;
}

/** One line each about where a wallet stands in *this* browser. */
export interface WalletProbe {
  id: WalletId;
  name: string;
  /** A sign path is genuinely reachable from this page right now. */
  usable: boolean;
  /** Said plainly, so a button that cannot work never looks like it might. */
  detail: string;
}

function messageOf(error: unknown, fallback: string): string {
  if (typeof error === "string" && error) return error;
  if (error && typeof error === "object") {
    const candidate = error as { message?: unknown; error?: { message?: unknown } };
    if (typeof candidate.message === "string" && candidate.message) return candidate.message;
    if (typeof candidate.error?.message === "string" && candidate.error.message) {
      return candidate.error.message;
    }
  }
  return fallback;
}

/** Reject rather than hang. The SDKs will not do this for us. */
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

async function freighter() {
  return import("@stellar/freighter-api");
}

async function lobstr() {
  return import("@lobstrco/signer-extension-api");
}

/**
 * Freighter's mobile app runs dapps in its own browser, but it injects only a
 * marker saying who it is — not the extension API. A page there can detect the
 * situation and say something true, but it cannot sign. The mobile signing path
 * Freighter supports is WalletConnect; see `probeWallet`.
 */
function inFreighterApp(): boolean {
  if (typeof window === "undefined") return false;
  const injected = (window as { stellar?: { provider?: string; platform?: string } }).stellar;
  return injected?.provider === "freighter" && injected?.platform === "mobile";
}

/**
 * Freighter's injected provider is `window.freighterApi`; `window.freighter` is
 * the legacy alias, and other wallets' in-app browsers inject that same
 * Freighter interface. Checking only the legacy name would report a working
 * sign path as missing — and a button that cannot connect is exactly what this
 * file exists to avoid, in both directions.
 */
function hasFreighterApi(): boolean {
  if (typeof window === "undefined") return false;
  const injected = window as { freighterApi?: unknown; freighter?: unknown };
  return Boolean(injected.freighterApi ?? injected.freighter);
}

function hasLobstrExtension(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean((window as { lobstrSignerExtension?: unknown }).lobstrSignerExtension);
}

export function walletName(id: WalletId): string {
  return WALLETS.find((wallet) => wallet.id === id)?.name ?? id;
}

/**
 * Ask each wallet where it stands. Everything here is bounded, so this settles
 * within the detection ceiling no matter what the page is running inside.
 *
 * The order matters: a real injected provider is checked *first*, and the
 * Freighter-mobile marker only decides the message once no provider was found.
 * That way a wallet browser which does inject the API stays usable, and one
 * that only announces itself is reported honestly instead of being probed and
 * left to hang.
 */
export async function probeWallet(id: WalletId): Promise<WalletProbe> {
  const name = walletName(id);
  let usable = false;

  try {
    if (id === "freighter") {
      usable = hasFreighterApi();
      if (!usable) {
        // No injected object, so ask the SDK anyway — it reads the same global,
        // and `isConnected` is the one call that gives up on its own.
        const api = await freighter();
        const result = await withTimeout(api.isConnected(), DETECT_TIMEOUT_MS, "no answer");
        usable = Boolean(result?.isConnected);
      }
    } else {
      usable = hasLobstrExtension();
      if (!usable) {
        const api = await lobstr();
        usable = Boolean(await withTimeout(api.isConnected(), DETECT_TIMEOUT_MS, "no answer"));
      }
    }
  } catch {
    usable = false;
  }

  if (!usable && id === "freighter" && inFreighterApp()) {
    return {
      id,
      name,
      usable: false,
      detail:
        "You are in the Freighter app, which cannot sign for a web page. Open this link in Safari or Chrome on a computer — Freighter signs for web pages over WalletConnect, which this page does not have.",
    };
  }

  return {
    id,
    name,
    usable,
    detail: usable ? "Ready to sign in this browser" : "Not installed in this browser",
  };
}

export async function probeAll(): Promise<WalletProbe[]> {
  return Promise.all(WALLETS.map((wallet) => probeWallet(wallet.id)));
}

/**
 * Refuse up front, in the caller's own frame of reference, when there is
 * nothing here that could possibly answer. Whether the extension has injected
 * its flag yet is `probeWallet`'s question — and the call below is bounded
 * either way, so a late injection cannot turn into a hang.
 */
function assertReachable(id: WalletId): void {
  if (id === "freighter" && !hasFreighterApi() && inFreighterApp()) {
    throw new Error(
      "The Freighter app cannot sign for a web page. Open this link in Safari or Chrome, where the Freighter extension can.",
    );
  }
}

export async function connect(id: WalletId): Promise<Connection> {
  assertReachable(id);
  const name = walletName(id);

  if (id === "freighter") {
    const api = await freighter();

    const result = await withTimeout(
      api.requestAccess(),
      CONNECT_TIMEOUT_MS,
      `${name} did not answer. Make sure the extension is installed and unlocked, then try again.`,
    );
    if (result?.error) {
      throw new Error(messageOf(result.error, "Freighter refused the connection."));
    }
    if (!result?.address) {
      throw new Error("Freighter did not return an address. Unlock it and try again.");
    }

    // Freighter signs for whatever network it is set to, so a wallet left on
    // public network would produce a transaction testnet cannot accept.
    let warning: string | undefined;
    try {
      const network = await withTimeout(api.getNetwork(), DETECT_TIMEOUT_MS, "no answer");
      if (network?.networkPassphrase && network.networkPassphrase !== NETWORK_PASSPHRASE) {
        warning = `Freighter is set to ${network.network || "another network"}. Switch it to Testnet.`;
      }
    } catch {
      /* If we cannot tell, we do not claim anything. */
    }

    return { address: result.address, warning };
  }

  const api = await lobstr();
  const address = await withTimeout(
    api.getPublicKey(),
    CONNECT_TIMEOUT_MS,
    `${name} did not answer. Make sure the extension is installed and unlocked, then try again.`,
  );
  if (!address) {
    throw new Error("LOBSTR did not return an address. Unlock it and try again.");
  }
  // LOBSTR exposes no network query, so we cannot verify which one it will sign
  // for. The page tells the user to check it themselves rather than guessing.
  return { address };
}

export async function sign(id: WalletId, xdr: string): Promise<string> {
  const name = walletName(id);

  if (id === "freighter") {
    const api = await freighter();
    const result = await withTimeout(
      api.signTransaction(xdr, { networkPassphrase: NETWORK_PASSPHRASE }),
      SIGN_TIMEOUT_MS,
      `${name} did not answer. The transaction was not signed and nothing was sent.`,
    );
    if (result?.error) {
      throw new Error(messageOf(result.error, "Freighter did not sign the transaction."));
    }
    if (!result?.signedTxXdr) {
      throw new Error("Freighter returned nothing to submit.");
    }
    return result.signedTxXdr;
  }

  const api = await lobstr();
  const signed = await withTimeout(
    api.signTransaction(xdr),
    SIGN_TIMEOUT_MS,
    `${name} did not answer. The transaction was not signed and nothing was sent.`,
  );
  if (!signed) {
    throw new Error("LOBSTR returned nothing to submit.");
  }
  return signed;
}

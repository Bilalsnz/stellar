import { NETWORK_PASSPHRASE } from "./stellar";

/**
 * One small adapter per wallet, talking to each wallet's own official SDK.
 * We deliberately avoid the all-in-one wallet kits: they pull in WalletConnect,
 * Reown, Trezor and Ledger, and none of that is needed to sign a testnet
 * payment with the two wallets this page supports.
 *
 * Both SDKs are imported lazily so nothing touches `window` while the page is
 * being rendered on the server.
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

export interface Connection {
  address: string;
  /** Set when the wallet is reachable but pointed at another network. */
  warning?: string;
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

async function freighter() {
  return import("@stellar/freighter-api");
}

async function lobstr() {
  return import("@lobstrco/signer-extension-api");
}

export async function isAvailable(id: WalletId): Promise<boolean> {
  try {
    if (id === "freighter") {
      const api = await freighter();
      const result = await api.isConnected();
      return Boolean(result?.isConnected);
    }
    const api = await lobstr();
    return Boolean(await api.isConnected());
  } catch {
    return false;
  }
}

export async function connect(id: WalletId): Promise<Connection> {
  if (id === "freighter") {
    const api = await freighter();

    const result = await api.requestAccess();
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
      const network = await api.getNetwork();
      if (network?.networkPassphrase && network.networkPassphrase !== NETWORK_PASSPHRASE) {
        warning = `Freighter is set to ${network.network || "another network"}. Switch it to Testnet.`;
      }
    } catch {
      /* If we cannot tell, we do not claim anything. */
    }

    return { address: result.address, warning };
  }

  const api = await lobstr();
  const address = await api.getPublicKey();
  if (!address) {
    throw new Error("LOBSTR did not return an address. Unlock it and try again.");
  }
  // LOBSTR exposes no network query, so we cannot verify which one it will sign
  // for. The page tells the user to check it themselves rather than guessing.
  return { address };
}

export async function sign(id: WalletId, xdr: string): Promise<string> {
  if (id === "freighter") {
    const api = await freighter();
    const result = await api.signTransaction(xdr, { networkPassphrase: NETWORK_PASSPHRASE });
    if (result?.error) {
      throw new Error(messageOf(result.error, "Freighter did not sign the transaction."));
    }
    if (!result?.signedTxXdr) {
      throw new Error("Freighter returned nothing to submit.");
    }
    return result.signedTxXdr;
  }

  const api = await lobstr();
  const signed = await api.signTransaction(xdr);
  if (!signed) {
    throw new Error("LOBSTR returned nothing to submit.");
  }
  return signed;
}

export function walletName(id: WalletId): string {
  return WALLETS.find((wallet) => wallet.id === id)?.name ?? id;
}

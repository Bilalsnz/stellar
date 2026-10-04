"use client";

import { useCallback, useEffect, useState } from "react";
import {
  FRIENDBOT_URL,
  checkDestination,
  explainSubmitError,
  buildTrustline,
  nextSequence,
  shortAddress,
  submitSignedXdr,
  type DestinationCheck,
} from "@/lib/stellar";
import { connect, probeAll, sign, type WalletId, type WalletProbe } from "@/lib/wallet";
import { clearWalletConnectUri } from "@/lib/walletconnect";
import { WalletConnectPanel } from "./walletconnect-panel";

/**
 * The freelancer cannot be paid USDC until their own account exists on testnet
 * and holds a USDC trustline. Both steps are ordinary Stellar operations signed
 * by their own wallet — no contract, no server.
 *
 * The buttons here are only offered for wallets that can actually answer in
 * this browser. Asking a wallet that is not there does not fail — it hangs —
 * so an ungated button is a button that spins forever. Freighter over
 * WalletConnect needs nothing injected, so from a phone it is the one that is
 * always there.
 */
type SetupState =
  | { kind: "idle" }
  | { kind: "connecting"; wallet: WalletId }
  | { kind: "signing"; wallet: WalletId }
  | { kind: "submitting" }
  | { kind: "confirming" }
  | { kind: "done" }
  | { kind: "error"; message: string };

/**
 * Horizon ingests a ledger a moment after it closes, so a trustline can be
 * signed, submitted and accepted while the account still reads as having none.
 * Asking once and believing the answer is how a warning survives the step that
 * fixed it — so ask until it agrees, then stop.
 */
async function confirmTrustline(address: string, tries = 12): Promise<DestinationCheck> {
  let state = await checkDestination(address);
  for (let attempt = 1; attempt < tries && state.kind !== "ok"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    state = await checkDestination(address);
  }
  return state;
}

export function ReceiveStatus({
  address,
  onAddressChange,
}: {
  address: string;
  onAddressChange: (value: string) => void;
}) {
  const [check, setCheck] = useState<DestinationCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [setup, setSetup] = useState<SetupState>({ kind: "idle" });
  const [busyWallet, setBusyWallet] = useState<WalletId | null>(null);
  const [probes, setProbes] = useState<WalletProbe[] | null>(null);

  // Asked once, and bounded — a wallet that cannot answer is reported as such
  // rather than left as a button that appears to be doing something.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next = await probeAll();
      if (!cancelled) setProbes(next);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const runCheck = useCallback(async (value: string) => {
    if (!value.trim()) {
      setCheck(null);
      return;
    }
    setChecking(true);
    try {
      setCheck(await checkDestination(value.trim()));
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    const trimmed = address.trim();
    if (!trimmed) {
      setCheck(null);
      return;
    }
    const timer = setTimeout(() => void runCheck(trimmed), 450);
    return () => clearTimeout(timer);
  }, [address, runCheck]);

  const addTrustline = async (wallet: WalletId) => {
    setBusyWallet(wallet);
    setSetup({ kind: "connecting", wallet });
    // Switching wallets must not leave the previous pairing code on screen.
    clearWalletConnectUri();
    try {
      const connection = await connect(wallet);

      // The trustline must be added by the account that will hold it.
      if (connection.address !== address.trim()) {
        setSetup({
          kind: "error",
          message: `That wallet is ${shortAddress(connection.address)}, but the link pays ${shortAddress(
            address.trim(),
          )}. Connect the wallet for the address above.`,
        });
        return;
      }

      setSetup({ kind: "signing", wallet });
      const sequence = await nextSequence(connection.address);
      const tx = buildTrustline(connection.address, sequence);
      const signed = await sign(wallet, tx.toXDR());

      setSetup({ kind: "submitting" });
      const result = await submitSignedXdr(signed);
      if (!result.successful) {
        setSetup({ kind: "error", message: "The trustline transaction did not succeed." });
        return;
      }

      // The warning has to clear itself. Waiting for the network to see the
      // trustline is the whole of that job — there is no reload to fall back on.
      setSetup({ kind: "confirming" });
      setCheck(await confirmTrustline(address.trim()));
      setSetup({ kind: "done" });
    } catch (error) {
      setSetup({
        kind: "error",
        message: error instanceof Error ? error.message : explainSubmitError(error),
      });
    } finally {
      setBusyWallet(null);
      clearWalletConnectUri();
    }
  };

  if (!address.trim()) {
    return (
      <p className="text-[13px] leading-relaxed text-[var(--ink-muted)]">
        Paste the Stellar address you want to be paid at.
      </p>
    );
  }

  if (checking && !check) {
    return <p className="text-[13px] text-[var(--ink-muted)]">Checking this address…</p>;
  }

  if (!check) return null;

  if (check.kind === "ok") {
    return (
      <p className="flex items-center gap-2 text-[13px] text-[var(--ink-muted)]">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--color-olive)]" />
        Ready to receive USDC.
      </p>
    );
  }

  if (check.kind === "invalid" || check.kind === "unknown") {
    return <p className="text-[13px] text-[var(--ink-muted)]">{check.message}</p>;
  }

  return (
    <div className="no-path px-3.5 py-3 text-[13px] leading-relaxed">
      <p>{check.message}</p>

      {check.kind === "missing" && (
        <a
          href={`${FRIENDBOT_URL}/?addr=${encodeURIComponent(address.trim())}`}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-block font-semibold text-[var(--color-copper)] underline decoration-[rgba(184,92,56,0.35)] underline-offset-2"
        >
          Create and fund it on testnet
        </a>
      )}

      {(check.kind === "missing" || check.kind === "no-trustline") && (
        <div className="mt-3">
          <p className="mb-2 text-[12.5px] font-semibold text-[var(--ink)]">
            Add the USDC trustline
          </p>

          {probes === null ? (
            <p className="text-[12.5px] text-[var(--ink-muted)]">Checking which wallets can sign…</p>
          ) : (
            <>
              <div className="space-y-2">
                {probes.map((probe) => {
                  const active =
                    (setup.kind === "connecting" || setup.kind === "signing") &&
                    setup.wallet === probe.id;
                  return (
                    <div key={probe.id}>
                      <button
                        type="button"
                        onClick={() => void addTrustline(probe.id)}
                        disabled={busyWallet !== null || !probe.usable}
                        className="wallet-button w-full px-3 py-2 text-left text-[12.5px] font-semibold"
                      >
                        {active
                          ? setup.kind === "connecting"
                            ? `Connecting to ${probe.name}…`
                            : "Confirm in your wallet…"
                          : `Sign with ${probe.name}`}
                      </button>
                      {!probe.usable && (
                        <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--ink-muted)]">
                          {probe.detail}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* The pairing code, while the relay waits for Freighter. */}
              <WalletConnectPanel />
            </>
          )}

          {setup.kind === "submitting" && (
            <p className="mt-2 text-[12.5px] text-[var(--ink-muted)]">Submitting the trustline…</p>
          )}
          {setup.kind === "confirming" && (
            <p className="mt-2 text-[12.5px] text-[var(--ink-muted)]">
              Waiting for the network to confirm it…
            </p>
          )}
          {setup.kind === "done" && (
            <p className="mt-2 text-[12.5px] text-[var(--ink-muted)]">Trustline added.</p>
          )}
          {setup.kind === "error" && (
            <p className="mt-2 text-[12.5px] text-[var(--color-copper)]">{setup.message}</p>
          )}
        </div>
      )}
    </div>
  );
}

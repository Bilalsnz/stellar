"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  EXPLORER_URL,
  FRIENDBOT_URL,
  USDC,
  assetKey,
  buildClaim,
  buildLockedPayment,
  buildPathPayment,
  checkDestination,
  explainSubmitError,
  loadAccount,
  nextSequence,
  quoteAll,
  readLandedPayment,
  readLock,
  shortAddress,
  submitSignedXdr,
  toStellarAmount,
  type AccountState,
  type DestinationCheck,
  type HeldAsset,
  type LandedPayment,
  type LockState,
  type Quote,
} from "@/lib/stellar";
import { decodeRequest, type PayRequest } from "@/lib/link";
import { formatAmount, formatRate, formatUsdc, formatWhen } from "@/lib/format";
import {
  connect,
  probeAll,
  sign,
  walletName,
  type Connection,
  type WalletId,
  type WalletProbe,
} from "@/lib/wallet";

/** How long a fresh lock stays open when the link did not say. */
const DEFAULT_DEADLINE_DAYS = 7;

type Phase = "choose-wallet" | "loading" | "ready" | "signing" | "submitting" | "locked";

type Connected = Connection & { wallet: WalletId };

const USDC_KEY = assetKey(USDC);

function defaultDeadline(): number {
  return Math.floor(Date.now() / 1000) + DEFAULT_DEADLINE_DAYS * 86_400;
}

/**
 * Horizon ingests a ledger a moment after it closes, so the lock can be real and
 * still not be readable yet. Give it a few tries rather than showing "not on the
 * ledger" to someone who just paid.
 */
async function readLockSettled(claimId: string, tries = 5): Promise<LockState> {
  let state = await readLock(claimId);
  for (let attempt = 1; attempt < tries && state.amount === null; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 900));
    state = await readLock(claimId);
  }
  return state;
}

export function PayView() {
  const params = useSearchParams();
  const linked = useMemo(() => decodeRequest(params.get("d")), [params]);
  const claimParam = params.get("c");

  const [request, setRequest] = useState<PayRequest | null>(null);
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);

  const [probes, setProbes] = useState<WalletProbe[] | null>(null);
  const [busyWallet, setBusyWallet] = useState<WalletId | null>(null);
  const [connection, setConnection] = useState<Connected | null>(null);
  const [account, setAccount] = useState<AccountState | null>(null);
  const [quotes, setQuotes] = useState<Map<string, Quote>>(new Map());
  const [selected, setSelected] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("choose-wallet");
  const [landed, setLanded] = useState<LandedPayment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missingAccount, setMissingAccount] = useState(false);
  const [destCheck, setDestCheck] = useState<DestinationCheck | null>(null);

  const [claimId, setClaimId] = useState<string | null>(null);
  const [lock, setLock] = useState<LockState | null>(null);
  const [lockBusy, setLockBusy] = useState(false);
  const [lockError, setLockError] = useState<string | null>(null);

  const destAmount = request ? Number(request.amount) : 0;

  // A link carries its own request. A claim id carries nothing, so the lock is
  // read straight off the ledger to find out what it is for and who it pays.
  useEffect(() => {
    if (linked) {
      setRequest(linked);
      setResolving(false);
      setResolveError(null);
      return;
    }
    if (!claimParam) {
      setRequest(null);
      return;
    }

    let cancelled = false;
    setResolving(true);
    setResolveError(null);
    void (async () => {
      const state = await readLockSettled(claimParam, 2);
      if (cancelled) return;
      if (state.amount === null || !state.destination) {
        setResolveError("That claim id is not on the Stellar testnet ledger.");
      } else {
        setRequest({
          to: state.destination,
          amount: String(state.amount),
          note: "",
          ts: 0,
          ...(state.deadline ? { dead: state.deadline } : {}),
        });
        setClaimId(claimParam);
        setLock(state);
      }
      setResolving(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [linked, claimParam]);

  // Which wallets can actually answer here. Bounded, so this always settles.
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

  // Paid moves the wash from amber to olive.
  useEffect(() => {
    const root = document.documentElement;
    if (lock?.status === "paid") root.dataset.paid = "true";
    else delete root.dataset.paid;
    return () => {
      delete root.dataset.paid;
    };
  }, [lock]);

  // Can the address in this link receive USDC at all? Better to say so up front.
  const recheckDestination = useCallback(async () => {
    if (!request) return;
    setDestCheck(null);
    setDestCheck(await checkDestination(request.to));
  }, [request]);

  useEffect(() => {
    void recheckDestination();
  }, [recheckDestination]);

  // Once a wallet is connected, read what it holds and price every route.
  useEffect(() => {
    if (!connection || !request || claimId) return;
    let cancelled = false;

    void (async () => {
      setPhase("loading");
      setMissingAccount(false);
      try {
        const next = await loadAccount(connection.address);
        if (cancelled) return;
        setAccount(next);

        const priced = await quoteAll(next.held, destAmount);
        if (cancelled) return;
        setQuotes(priced);

        const payable = next.held.find((held) => {
          const quote = priced.get(held.key);
          return quote && held.spendable >= quote.sourceAmount;
        });
        setSelected(payable?.key ?? null);
        setPhase("ready");
      } catch (loadError) {
        if (cancelled) return;
        const status = (loadError as { response?: { status?: number } })?.response?.status;
        if (status === 404) {
          setMissingAccount(true);
          setPhase("ready");
          return;
        }
        setError("Could not read this wallet from Horizon.");
        setPhase("ready");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [connection, request, destAmount, claimId]);

  const connectWallet = useCallback(async (wallet: WalletId) => {
    setBusyWallet(wallet);
    setError(null);
    try {
      const result = await connect(wallet);
      setConnection({ ...result, wallet });
    } catch (connectError) {
      setError(connectError instanceof Error ? connectError.message : "Could not connect.");
    } finally {
      setBusyWallet(null);
    }
  }, []);

  /** Re-price every held asset and keep the current choice if it still stands. */
  const refreshQuotes = useCallback(async () => {
    if (!account) return;
    const priced = await quoteAll(account.held, destAmount);
    setQuotes(priced);
    setSelected((current) => {
      if (current && priced.has(current)) return current;
      const payable = account.held.find((held) => {
        const quote = priced.get(held.key);
        return quote && held.spendable >= quote.sourceAmount;
      });
      return payable?.key ?? null;
    });
  }, [account, destAmount]);

  const pay = useCallback(async () => {
    if (!connection || !account || !request || !selected) return;
    const held = account.held.find((item) => item.key === selected);
    if (!held) return;

    setError(null);
    try {
      // Re-price immediately before signing: the quote we showed can age while
      // the client reads the page.
      setPhase("loading");
      const fresh = await quoteAll([held], destAmount);
      const quote = fresh.get(selected);
      if (!quote) {
        setError(`There is no longer a path from ${held.code} to USDC. Nothing was sent.`);
        setPhase("ready");
        return;
      }
      if (held.spendable < quote.sourceAmount) {
        setError(`Not enough ${held.code} to cover this payment.`);
        setPhase("ready");
        return;
      }

      const sendMax = toStellarAmount(Math.min(quote.sendMax, held.spendable));
      const dest = toStellarAmount(destAmount);
      const deadline = request.dead ?? defaultDeadline();

      setPhase("signing");
      const sequence = await nextSequence(connection.address);

      // A lock names the freelancer and the client as claimants, and the ledger
      // rejects a balance claimed twice by the same account. Someone paying
      // their own link is the one case where there is nothing to lock.
      const selfPay = request.to === connection.address;
      if (selfPay) {
        const transaction = buildPathPayment(
          {
            sourceAddress: connection.address,
            destination: request.to,
            sendAsset: held.asset,
            sendMax,
            destAmount: dest,
            path: quote.path,
          },
          sequence,
        );
        const signed = await sign(connection.wallet, transaction.toXDR());
        setPhase("submitting");
        const result = await submitSignedXdr(signed);
        setLanded(await readLandedPayment(result.hash));
        setPhase("locked");
        return;
      }

      const { transaction, claimId: id } = buildLockedPayment(
        {
          sourceAddress: connection.address,
          destination: request.to,
          sendAsset: held.asset,
          sendMax,
          destAmount: dest,
          path: quote.path,
          deadline,
          // The swap credits the client with USDC for the instant before it is
          // locked, so the client needs the trustline — not only the freelancer.
          addTrustline: !account.hasUsdc,
        },
        sequence,
      );

      const signed = await sign(connection.wallet, transaction.toXDR());

      setPhase("submitting");
      await submitSignedXdr(signed);

      // The claim id is derived from the transaction, so it was already known;
      // the state of the lock is then read back off the ledger.
      setClaimId(id);
      setLock(await readLockSettled(id));
      setPhase("locked");
    } catch (payError) {
      setError(explainSubmitError(payError));
      // The rate may have moved while the wallet was open; show where it stands.
      await refreshQuotes().catch(() => undefined);
      setPhase("ready");
    }
  }, [connection, account, request, selected, destAmount, refreshQuotes]);

  /** Take the lock: the freelancer being paid, or the client taking it back. */
  const takeLock = useCallback(async () => {
    if (!connection || !claimId) return;
    setLockBusy(true);
    setLockError(null);
    try {
      const sequence = await nextSequence(connection.address);
      const transaction = buildClaim(claimId, connection.address, sequence);
      const signed = await sign(connection.wallet, transaction.toXDR());
      await submitSignedXdr(signed);
      setLock(await readLockSettled(claimId));
    } catch (claimFailure) {
      setLockError(explainSubmitError(claimFailure));
    } finally {
      setLockBusy(false);
    }
  }, [connection, claimId]);

  const refreshLock = useCallback(async () => {
    if (!claimId) return;
    setLockBusy(true);
    setLockError(null);
    try {
      setLock(await readLock(claimId));
    } finally {
      setLockBusy(false);
    }
  }, [claimId]);

  if (resolving) {
    return (
      <Shell>
        <p className="mt-9 text-[14px] text-[var(--ink-muted)]">Reading that claim…</p>
      </Shell>
    );
  }

  if (resolveError) {
    return (
      <Shell>
        <div className="mt-9">
          <h1 className="text-[1.6rem] font-semibold leading-tight tracking-[-0.03em]">
            No such claim.
          </h1>
          <p className="mt-2.5 text-[14.5px] leading-relaxed text-[var(--ink-muted)]">
            {resolveError} Check the id, or ask for the link again.
          </p>
          <a
            href="/"
            className="mt-5 inline-block text-[13px] font-semibold text-[var(--color-copper)] underline decoration-[rgba(184,92,56,0.35)] underline-offset-2"
          >
            Start again →
          </a>
        </div>
      </Shell>
    );
  }

  if (!request) {
    return (
      <Shell>
        <div className="mt-9">
          <h1 className="text-[1.6rem] font-semibold leading-tight tracking-[-0.03em]">
            This link is incomplete.
          </h1>
          <p className="mt-2.5 text-[14.5px] leading-relaxed text-[var(--ink-muted)]">
            The payment details live in the link itself, so a shortened or edited link has nothing
            to pay. Ask for the original link again.
          </p>
          <a
            href="/"
            className="mt-5 inline-block text-[13px] font-semibold text-[var(--color-copper)] underline decoration-[rgba(184,92,56,0.35)] underline-offset-2"
          >
            Create a payment link →
          </a>
        </div>
      </Shell>
    );
  }

  // Once the lock exists, the page has exactly three things to say about it.
  // A self-payment never made a lock, so it falls through to the receipt.
  if (claimId && lock) {
    return (
      <Shell>
        <LockView
          lock={lock}
          request={request}
          claimId={claimId}
          destAmount={destAmount}
          connection={connection}
          probes={probes}
          busyWallet={busyWallet}
          onConnect={connectWallet}
          onTake={takeLock}
          onRefresh={refreshLock}
          busy={lockBusy}
          error={lockError}
        />
      </Shell>
    );
  }

  const selectedHeld = account?.held.find((item) => item.key === selected) ?? null;
  const selectedQuote = selected ? (quotes.get(selected) ?? null) : null;

  // Why the button cannot be used, said plainly rather than left to guesswork.
  const affordable = (account?.held ?? []).filter((held) => {
    const quote = quotes.get(held.key);
    return quote !== undefined && held.spendable >= quote.sourceAmount;
  });
  const hasAnyRoute = (account?.held ?? []).some((held) => quotes.has(held.key));

  const stallReason =
    !account || missingAccount || selectedHeld
      ? null
      : !hasAnyRoute
        ? "No asset in this wallet has a path to USDC right now, so no rate can be quoted."
        : affordable.length === 0
          ? "None of these assets cover the price. Nothing will be sent."
          : "Choose an asset to pay with.";

  const destinationBlocked =
    destCheck !== null && destCheck.kind !== "ok" && destCheck.kind !== "unknown";

  const canPay =
    phase === "ready" &&
    !destinationBlocked &&
    !missingAccount &&
    selectedHeld !== null &&
    selectedQuote !== null &&
    selectedHeld.spendable >= selectedQuote.sourceAmount;

  const deadline = request.dead ?? null;

  return (
    <Shell>
      <section className="mt-10">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--ink-muted)]">
          {landed ? "Paid" : "Pay"}
        </p>

        <div className="price mt-2.5">
          {formatUsdc(destAmount)}
          <span className="price-unit">USDC</span>
        </div>

        {request.note && (
          <p className="mt-3 max-w-[26rem] text-[14px] leading-relaxed text-[var(--ink-muted)]">
            {request.note}
          </p>
        )}

        <p className="mono mt-3 text-[11.5px] text-[var(--ink-faint)]">
          to {shortAddress(request.to, 8, 8)}
        </p>

        {deadline && (
          <p className="mt-1 text-[11.5px] text-[var(--ink-faint)]">
            Held for them until {formatWhen(deadline * 1000)}.
          </p>
        )}
      </section>

      {landed ? (
        <PaidCard landed={landed} request={request} destAmount={destAmount} />
      ) : (
        <section className="card mt-7 p-4">
          {destinationBlocked && destCheck && (
            <div className="no-path mb-3.5 px-3.5 py-3 text-[12.5px] leading-relaxed">
              <p>{destCheck.message} This link cannot be paid until that is fixed.</p>
              <button
                type="button"
                onClick={() => void recheckDestination()}
                className="mt-2 font-semibold text-[var(--color-copper)] underline decoration-[rgba(184,92,56,0.35)] underline-offset-2"
              >
                Check again
              </button>
            </div>
          )}

          {connection ? (
            <ConnectedView
              connection={connection}
              account={account}
              quotes={quotes}
              selected={selected}
              onSelect={setSelected}
              missingAccount={missingAccount}
              destAmount={destAmount}
            />
          ) : (
            <WalletChooser
              probes={probes}
              busyWallet={busyWallet}
              onConnect={connectWallet}
            />
          )}

          {error && (
            <p className="mt-3 text-[12.5px] leading-relaxed text-[var(--color-copper)]">{error}</p>
          )}

          {connection && !missingAccount && (
            <>
              <div className="rule my-4" />

              {selectedQuote && selectedHeld ? (
                <>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-[12.5px] text-[var(--ink-muted)]">You spend</span>
                    <span className="text-[13.5px] font-semibold tabular-nums">
                      {formatAmount(selectedQuote.sourceAmount)} {selectedHeld.code}
                    </span>
                  </div>

                  <div className="mt-2 flex items-baseline justify-between gap-3">
                    <span className="text-[12.5px] text-[var(--ink-muted)]">Quoted rate</span>
                    <span className="rate text-[14px]">
                      1 USDC = {formatRate(selectedQuote.rate)} {selectedHeld.code}
                    </span>
                  </div>

                  {selectedQuote.path.length > 0 && (
                    <p className="mt-2 text-[11.5px] leading-relaxed text-[var(--ink-faint)]">
                      Routed through {selectedQuote.path.map((asset) => asset.getCode()).join(" → ")}
                    </p>
                  )}
                </>
              ) : (
                <p className="text-[12.5px] leading-relaxed text-[var(--ink-muted)]">
                  {stallReason ?? "Choose an asset to pay with."}
                </p>
              )}

              <button
                type="button"
                onClick={() => void pay()}
                disabled={!canPay}
                className="pay-button mt-4 w-full rounded-[10px] px-4 py-3.5 text-[15.5px]"
              >
                {buttonLabel(phase, destAmount, selectedHeld)}
              </button>

              {phase === "signing" && (
                <p className="mt-2.5 text-center text-[12px] text-[var(--ink-muted)]">
                  Confirm the payment in {walletName(connection.wallet)}.
                </p>
              )}
            </>
          )}
        </section>
      )}

      <p className="mt-5 text-[11.5px] leading-relaxed text-[var(--ink-faint)]">
        Stellar testnet. One transaction swaps your asset into USDC and locks it for the payee —
        the rate is quoted live from the network and the price never changes.
      </p>
    </Shell>
  );
}

function buttonLabel(phase: Phase, destAmount: number, held: HeldAsset | null): string {
  if (phase === "signing") return "Confirm in your wallet…";
  if (phase === "submitting") return "Sending…";
  if (phase === "loading") return "Pricing…";
  if (!held) return "Pay";
  return `Pay ${formatUsdc(destAmount)} USDC`;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-[30rem] px-4 pb-20 pt-9">
      <div className="flex items-center gap-2">
        <span className="inline-block h-[7px] w-[7px] rounded-full bg-[var(--color-copper)]" />
        <span className="text-[12.5px] font-semibold uppercase tracking-[0.18em]">HoldPay</span>
      </div>
      {children}
    </main>
  );
}

function WalletChooser({
  probes,
  busyWallet,
  onConnect,
}: {
  probes: WalletProbe[] | null;
  busyWallet: WalletId | null;
  onConnect: (wallet: WalletId) => void;
}) {
  const noneUsable = probes !== null && probes.every((probe) => !probe.usable);

  return (
    <div>
      <p className="text-[14px] font-semibold">Connect a wallet to pay.</p>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--ink-muted)]">
        Pay with any asset you already hold. The swap happens inside the payment.
      </p>

      <div className="mt-3.5 space-y-2">
        {(probes ?? []).map((probe) => (
          <button
            key={probe.id}
            type="button"
            onClick={() => void onConnect(probe.id)}
            disabled={!probe.usable || busyWallet !== null}
            className="wallet-button flex w-full items-center justify-between px-3.5 py-3 text-left"
          >
            <span className="min-w-0">
              <span className="block text-[14px] font-semibold">{probe.name}</span>
              <span className="block text-[11.5px] text-[var(--ink-muted)]">{probe.detail}</span>
            </span>
            <span className="shrink-0 text-[12.5px] font-semibold text-[var(--color-copper)]">
              {busyWallet === probe.id ? "Connecting…" : probe.usable ? "Connect" : ""}
            </span>
          </button>
        ))}

        {probes === null && (
          <p className="text-[12.5px] text-[var(--ink-muted)]">Checking which wallets are here…</p>
        )}
      </div>

      {noneUsable && (
        <p className="mt-3 text-[11.5px] leading-relaxed text-[var(--ink-faint)]">
          Neither wallet is reachable from this browser. Freighter and LOBSTR sign here through
          their desktop extensions — from a phone, open the link in a desktop browser, or use the
          wallet that holds the address you want to pay from.
        </p>
      )}
    </div>
  );
}

function ConnectedView({
  connection,
  account,
  quotes,
  selected,
  onSelect,
  missingAccount,
  destAmount,
}: {
  connection: Connected;
  account: AccountState | null;
  quotes: Map<string, Quote>;
  selected: string | null;
  onSelect: (key: string) => void;
  missingAccount: boolean;
  destAmount: number;
}) {
  if (missingAccount) {
    return (
      <div>
        <p className="text-[14px] font-semibold">This wallet has no testnet account yet.</p>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--ink-muted)]">
          {shortAddress(connection.address)} is not funded on Stellar testnet, so it has nothing to
          pay with.
        </p>
        <a
          href={`${FRIENDBOT_URL}/?addr=${encodeURIComponent(connection.address)}`}
          target="_blank"
          rel="noreferrer"
          className="mt-3 inline-block text-[12.5px] font-semibold text-[var(--color-copper)] underline decoration-[rgba(184,92,56,0.35)] underline-offset-2"
        >
          Fund it with testnet XLM →
        </a>
        <p className="mt-2 text-[11.5px] text-[var(--ink-faint)]">Then reload this page.</p>
      </div>
    );
  }

  // Only the very first read blanks the panel. Re-pricing before a payment must
  // not make the client's asset list vanish under them.
  if (!account) {
    return <p className="text-[13px] text-[var(--ink-muted)]">Reading your wallet…</p>;
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.13em] text-[var(--ink-muted)]">
          You pay with
        </p>
        <p className="mono text-[11.5px] text-[var(--ink-faint)]">
          {shortAddress(connection.address, 5, 5)}
        </p>
      </div>

      {connection.warning && (
        <p className="mt-2 text-[12px] leading-relaxed text-[var(--color-copper)]">
          {connection.warning}
        </p>
      )}

      <ul className="mt-2.5 space-y-2">
        {account.held.map((held) => {
          const quote = quotes.get(held.key);
          const isSelected = selected === held.key;

          // No route: say so plainly. We never invent a number here.
          if (!quote) {
            return (
              <li key={held.key} className="no-path px-3.5 py-2.5">
                <p className="text-[13px] font-semibold">{held.code}</p>
                <p className="mt-0.5 text-[11.5px]">
                  No path from {held.code} to USDC — cannot be quoted.
                </p>
              </li>
            );
          }

          const short = held.spendable < quote.sourceAmount;

          return (
            <li key={held.key}>
              <button
                type="button"
                onClick={() => onSelect(held.key)}
                disabled={short}
                aria-pressed={isSelected}
                className="wallet-button flex w-full items-center justify-between gap-3 px-3.5 py-2.5 text-left"
              >
                <span className="min-w-0">
                  <span className="block text-[13.5px] font-semibold">{held.code}</span>
                  <span className="block text-[11.5px] text-[var(--ink-muted)]">
                    {short
                      ? `Not enough — ${formatAmount(held.balance)} held`
                      : `Balance ${formatAmount(held.balance)}`}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block text-[13.5px] font-semibold tabular-nums">
                    {formatAmount(quote.sourceAmount)}
                  </span>
                  <span className="block text-[11.5px] text-[var(--ink-muted)]">
                    for {formatUsdc(destAmount)} USDC
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {!account.hasUsdc && (
        <p className="mt-2.5 text-[11.5px] leading-relaxed text-[var(--ink-faint)]">
          This wallet has no USDC trustline yet. The payment adds one in the same transaction, so
          it is still a single confirmation.
        </p>
      )}
    </div>
  );
}

/**
 * The lock, in exactly three states. Everything shown here is read back off the
 * ledger, so two different people opening the same claim id see the same thing.
 */
function LockView({
  lock,
  request,
  claimId,
  destAmount,
  connection,
  probes,
  busyWallet,
  onConnect,
  onTake,
  onRefresh,
  busy,
  error,
}: {
  lock: LockState;
  request: PayRequest;
  claimId: string;
  destAmount: number;
  connection: Connected | null;
  probes: WalletProbe[] | null;
  busyWallet: WalletId | null;
  onConnect: (wallet: WalletId) => void;
  onTake: () => void;
  onRefresh: () => void;
  busy: boolean;
  error: string | null;
}) {
  const amount = lock.amount ?? destAmount;
  const isFreelancer = connection !== null && connection.address === lock.destination;
  const isFunder = connection !== null && connection.address === lock.funder;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expired = lock.deadline !== null && nowSeconds >= lock.deadline;

  const label =
    lock.status === "waiting" ? "Waiting" : lock.status === "paid" ? "Paid" : "Returned";
  const dot =
    lock.status === "paid"
      ? "bg-[var(--color-olive)]"
      : lock.status === "returned"
        ? "bg-[var(--color-copper)]"
        : "bg-[var(--color-amber)]";

  return (
    <>
      <section className="mt-10">
        <div className="flex items-center gap-2">
          <span className={`inline-block h-2 w-2 rounded-full ${dot}`} />
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--ink-muted)]">
            {label}
          </p>
        </div>

        <div className="price mt-2.5">
          {formatUsdc(amount)}
          <span className="price-unit">USDC</span>
        </div>

        {request.note && (
          <p className="mt-3 max-w-[26rem] text-[14px] leading-relaxed text-[var(--ink-muted)]">
            {request.note}
          </p>
        )}
      </section>

      <section className="card fade-in mt-7 p-4">
        {lock.status === "waiting" && (
          <p className="text-[14.5px] leading-relaxed">
            <span className="font-semibold tabular-nums">{formatAmount(amount)} USDC</span> is locked
            on Stellar for{" "}
            <span className="mono text-[13px]">{shortAddress(lock.destination ?? request.to, 5, 5)}</span>
            . It is theirs to claim.
          </p>
        )}

        {lock.status === "paid" && (
          <p className="text-[14.5px] leading-relaxed">
            <span className="font-semibold tabular-nums">{formatAmount(amount)} USDC</span> was
            claimed by{" "}
            <span className="mono text-[13px]">{shortAddress(lock.claimedBy ?? "", 5, 5)}</span>. The
            payment is settled.
          </p>
        )}

        {lock.status === "returned" && (
          <p className="text-[14.5px] leading-relaxed">
            The deadline passed without a claim, so{" "}
            <span className="font-semibold tabular-nums">{formatAmount(amount)} USDC</span> went back
            to{" "}
            <span className="mono text-[13px]">{shortAddress(lock.funder ?? "", 5, 5)}</span>.
          </p>
        )}

        {lock.deadline !== null && lock.status === "waiting" && (
          <p className="mt-2 text-[12.5px] leading-relaxed text-[var(--ink-muted)]">
            {expired
              ? `The hold expired ${formatWhen(lock.deadline * 1000)}. The client can take it back.`
              : `If it is not claimed by ${formatWhen(lock.deadline * 1000)}, the client can take it back.`}
          </p>
        )}

        {/* Whoever the connected wallet is decides which action is even offered. */}
        <div className="mt-4">
          {connection === null ? (
            <>
              <p className="mb-2 text-[12.5px] leading-relaxed text-[var(--ink-muted)]">
                Connect the wallet this concerns to act on it.
              </p>
              <WalletChooser probes={probes} busyWallet={busyWallet} onConnect={onConnect} />
            </>
          ) : isFreelancer && lock.status === "waiting" ? (
            <button
              type="button"
              onClick={onTake}
              disabled={busy}
              className="pay-button w-full rounded-[10px] px-4 py-3.5 text-[15.5px]"
            >
              {busy ? "Claiming…" : `Claim ${formatUsdc(amount)} USDC`}
            </button>
          ) : isFunder && lock.status === "waiting" && expired ? (
            <button
              type="button"
              onClick={onTake}
              disabled={busy}
              className="pay-button w-full rounded-[10px] px-4 py-3.5 text-[15.5px]"
            >
              {busy ? "Taking it back…" : `Take back ${formatUsdc(amount)} USDC`}
            </button>
          ) : (
            <p className="text-[12.5px] leading-relaxed text-[var(--ink-muted)]">
              {lock.status === "waiting"
                ? isFunder
                  ? "The hold has not expired yet."
                  : `This wallet is not the one the lock was made for.`
                : "This lock has already been settled."}
            </p>
          )}

          {error && (
            <p className="mt-2 text-[12.5px] leading-relaxed text-[var(--color-copper)]">{error}</p>
          )}
        </div>

        <div className="rule my-4" />

        <p className="text-[11px] font-semibold uppercase tracking-[0.13em] text-[var(--ink-muted)]">
          Claim id
        </p>
        <p className="mono mt-1.5 break-all text-[11px] text-[var(--ink-faint)]">{claimId}</p>
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-[var(--ink-muted)]">
          Anyone can open this lock by pasting the claim id at the top of the site.
        </p>

        <div className="rule my-4" />

        <LedgerTrail lock={lock} />

        <button
          type="button"
          onClick={onRefresh}
          disabled={busy}
          className="mt-4 text-[12.5px] font-semibold text-[var(--color-copper)] underline decoration-[rgba(184,92,56,0.35)] underline-offset-2 disabled:opacity-50"
        >
          {busy ? "Checking…" : "Check the ledger again"}
        </button>
      </section>
    </>
  );
}

/**
 * The three transactions a lock can produce. A lock that is still waiting has
 * only the first; one that settled has two. What has not happened is shown as
 * not having happened rather than dressed up.
 */
function LedgerTrail({ lock }: { lock: LockState }) {
  const steps: { label: string; detail: string; hash: string | null }[] = [
    { label: "Lock", detail: "the payment swapped into USDC and held", hash: lock.lockHash },
    {
      label: "Pay",
      detail: "the payee claimed it",
      hash: lock.status === "paid" ? lock.claimHash : null,
    },
    {
      label: "Return",
      detail: "it went back unclaimed",
      hash: lock.status === "returned" ? lock.claimHash : null,
    },
  ];

  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-[0.13em] text-[var(--ink-muted)]">
        On the ledger
      </p>
      <ul className="mt-2 space-y-2">
        {steps.map((step) => (
          <li key={step.label} className="flex items-baseline justify-between gap-3">
            <span className="min-w-0">
              <span className="block text-[12.5px] font-semibold">{step.label}</span>
              <span className="block text-[11.5px] text-[var(--ink-muted)]">{step.detail}</span>
            </span>
            {step.hash ? (
              <a
                href={`${EXPLORER_URL}/tx/${step.hash}`}
                target="_blank"
                rel="noreferrer"
                className="mono shrink-0 text-[11px] font-semibold text-[var(--color-copper)] underline decoration-[rgba(184,92,56,0.35)] underline-offset-2"
              >
                {step.hash.slice(0, 8)}…
              </a>
            ) : (
              <span className="shrink-0 text-[11.5px] text-[var(--ink-faint)]">not yet</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function PaidCard({
  landed,
  request,
  destAmount,
}: {
  landed: LandedPayment;
  request: PayRequest;
  destAmount: number;
}) {
  const delivered = landed.delivered ?? destAmount;
  const achievedRate =
    landed.spentAmount && landed.delivered ? landed.spentAmount / landed.delivered : null;

  return (
    <section className="card fade-in mt-7 p-4">
      <div className="flex items-center gap-2">
        <span className="inline-block h-2 w-2 rounded-full bg-[var(--color-olive)]" />
        <span className="text-[12px] font-semibold uppercase tracking-[0.14em]">Paid</span>
      </div>

      <p className="mt-3 text-[15px] leading-relaxed">
        <span className="font-semibold tabular-nums">{formatAmount(delivered)} USDC</span>{" "}
        <span className="text-[var(--ink-muted)]">delivered to</span>{" "}
        <span className="mono text-[13px]">{shortAddress(request.to, 5, 5)}</span>
      </p>

      {landed.spentAmount !== null && landed.spentCode && (
        <div className="mt-2.5 flex items-baseline justify-between gap-3">
          <span className="text-[12.5px] text-[var(--ink-muted)]">Spent</span>
          <span className="text-[13.5px] font-semibold tabular-nums">
            {formatAmount(landed.spentAmount)} {landed.spentCode}
          </span>
        </div>
      )}

      {achievedRate !== null && landed.spentCode && (
        <div className="mt-2 flex items-baseline justify-between gap-3">
          <span className="text-[12.5px] text-[var(--ink-muted)]">Rate paid</span>
          <span className="rate text-[14px]">
            1 USDC = {formatRate(achievedRate)} {landed.spentCode}
          </span>
        </div>
      )}

      <div className="rule my-4" />

      <a
        href={`${EXPLORER_URL}/tx/${landed.hash}`}
        target="_blank"
        rel="noreferrer"
        className="text-[13px] font-semibold text-[var(--color-copper)] underline decoration-[rgba(184,92,56,0.35)] underline-offset-2"
      >
        View the transaction on Stellar Expert →
      </a>

      <p className="mono mt-2 break-all text-[11px] text-[var(--ink-faint)]">{landed.hash}</p>

      <div className="rule my-4" />

      <a
        href="/"
        className="text-[12.5px] font-semibold text-[var(--ink-muted)] underline decoration-[rgba(28,25,21,0.2)] underline-offset-2"
      >
        Create your own payment link
      </a>
    </section>
  );
}

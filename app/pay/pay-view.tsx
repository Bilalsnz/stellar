"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  EXPLORER_URL,
  FRIENDBOT_URL,
  buildPathPayment,
  checkDestination,
  explainSubmitError,
  loadAccount,
  nextSequence,
  quoteAll,
  readLandedPayment,
  shortAddress,
  submitSignedXdr,
  toStellarAmount,
  type AccountState,
  type DestinationCheck,
  type HeldAsset,
  type LandedPayment,
  type Quote,
} from "@/lib/stellar";
import { decodeRequest, type PayRequest } from "@/lib/link";
import { formatAmount, formatRate, formatUsdc } from "@/lib/format";
import {
  WALLETS,
  connect,
  isAvailable,
  sign,
  walletName,
  type Connection,
  type WalletId,
} from "@/lib/wallet";

type Phase = "choose-wallet" | "loading" | "ready" | "signing" | "submitting" | "paid";

type Connected = Connection & { wallet: WalletId };

export function PayView() {
  const params = useSearchParams();
  const request = useMemo<PayRequest | null>(
    () => decodeRequest(params.get("d")),
    [params],
  );

  const [available, setAvailable] = useState<Record<string, boolean> | null>(null);
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

  const destAmount = request ? Number(request.amount) : 0;

  // Which wallets are actually installed. We never show a button that cannot work.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const entries = await Promise.all(
        WALLETS.map(async (wallet) => [wallet.id, await isAvailable(wallet.id)] as const),
      );
      if (!cancelled) setAvailable(Object.fromEntries(entries));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Can the address in this link receive USDC at all? Better to say so up front.
  const recheckDestination = useCallback(async () => {
    if (!request) return;
    setDestCheck(null);
    setDestCheck(await checkDestination(request.to));
  }, [request]);

  useEffect(() => {
    void recheckDestination();
  }, [recheckDestination]);

  // The paid state moves the whole page's wash from amber to olive.
  useEffect(() => {
    const root = document.documentElement;
    if (phase === "paid") root.dataset.paid = "true";
    else delete root.dataset.paid;
    return () => {
      delete root.dataset.paid;
    };
  }, [phase]);

  // Once a wallet is connected, read what it holds and price every route.
  useEffect(() => {
    if (!connection || !request) return;
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
  }, [connection, request, destAmount]);

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

      setPhase("signing");
      const sequence = await nextSequence(connection.address);
      const transaction = buildPathPayment(
        {
          sourceAddress: connection.address,
          destination: request.to,
          sendAsset: held.asset,
          // Never authorise more than the wallet can actually spend.
          sendMax: toStellarAmount(Math.min(quote.sendMax, held.spendable)),
          destAmount: toStellarAmount(destAmount),
          path: quote.path,
        },
        sequence,
      );

      const signed = await sign(connection.wallet, transaction.toXDR());

      setPhase("submitting");
      const result = await submitSignedXdr(signed);

      // The receipt is read back off the ledger, not assumed from the request.
      const record = await readLandedPayment(result.hash);
      setLanded(record);
      setPhase("paid");
    } catch (payError) {
      setError(explainSubmitError(payError));
      // The rate may have moved while the wallet was open; show where it stands now.
      await refreshQuotes().catch(() => undefined);
      setPhase("ready");
    }
  }, [connection, account, request, selected, destAmount, refreshQuotes]);

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

  return (
    <Shell>
      <section className="mt-10">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--ink-muted)]">
          {phase === "paid" ? "Paid" : "Pay"}
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
      </section>

      {phase === "paid" && landed ? (
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
              phase={phase}
              missingAccount={missingAccount}
              destAmount={destAmount}
            />
          ) : (
            <WalletChooser
              available={available}
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
                    <span className="text-[12.5px] text-[var(--ink-muted)]">
                      You spend
                    </span>
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
        Stellar testnet. One transaction swaps and pays at once — the rate is quoted live from the
        network and the price never changes.
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
  available,
  busyWallet,
  onConnect,
}: {
  available: Record<string, boolean> | null;
  busyWallet: WalletId | null;
  onConnect: (wallet: WalletId) => void;
}) {
  return (
    <div>
      <p className="text-[14px] font-semibold">Connect a wallet to pay.</p>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--ink-muted)]">
        Pay with any asset you already hold. The swap happens inside the payment.
      </p>

      <div className="mt-3.5 space-y-2">
        {WALLETS.map((wallet) => {
          const installed = available?.[wallet.id] ?? false;
          const unknown = available === null;
          return (
            <button
              key={wallet.id}
              type="button"
              onClick={() => void onConnect(wallet.id)}
              disabled={unknown || !installed || busyWallet !== null}
              className="wallet-button flex w-full items-center justify-between px-3.5 py-3 text-left"
            >
              <span>
                <span className="block text-[14px] font-semibold">{wallet.name}</span>
                <span className="block text-[11.5px] text-[var(--ink-muted)]">
                  {unknown
                    ? "Checking…"
                    : installed
                      ? wallet.blurb
                      : "Not detected in this browser"}
                </span>
              </span>
              <span className="text-[12.5px] font-semibold text-[var(--color-copper)]">
                {busyWallet === wallet.id ? "Connecting…" : installed ? "Connect" : ""}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ConnectedView({
  connection,
  account,
  quotes,
  selected,
  onSelect,
  phase,
  missingAccount,
  destAmount,
}: {
  connection: Connected;
  account: AccountState | null;
  quotes: Map<string, Quote>;
  selected: string | null;
  onSelect: (key: string) => void;
  phase: Phase;
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
        <p className="mt-2 text-[11.5px] text-[var(--ink-faint)]">
          Then reload this page.
        </p>
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
        <span className="font-semibold tabular-nums">
          {formatAmount(delivered)} USDC
        </span>{" "}
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

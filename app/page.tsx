"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ReceiveStatus } from "@/components/receive-status";
import { formatAmount, formatUsdc, formatWhen } from "@/lib/format";
import {
  MAX_NOTE_LENGTH,
  buildClaimLink,
  buildClaimPath,
  buildPayLink,
  buildPayPathFromEncoded,
  parsePayInput,
  type PayRequest,
} from "@/lib/link";
import {
  EXPLORER_URL,
  isStellarAddress,
  listOpenLocks,
  readLock,
  shortAddress,
  type LockState,
} from "@/lib/stellar";
import { WORKED_EXAMPLE } from "@/lib/proof";
import { loadSaved, removeSaved, saveRequest, type SavedRequest } from "@/lib/store";

const ADDRESS_KEY = "holdpay.address.v1";

/** How long a lock stays open. The freelancer picks; the default is a week. */
const HOLD_CHOICES = [3, 7, 30] as const;
const DEFAULT_HOLD_DAYS = 7;

/** Reading every lock a busy address ever made would be a lot of requests. */
const MAX_LISTED_LOCKS = 8;

type Tab = "get" | "pay";

interface OpenLock {
  id: string;
  state: LockState;
}

export default function HomePage() {
  const router = useRouter();

  const [tab, setTab] = useState<Tab>("get");

  const [address, setAddress] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [holdDays, setHoldDays] = useState<number>(DEFAULT_HOLD_DAYS);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedRequest[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [openValue, setOpenValue] = useState("");
  const [openError, setOpenError] = useState<string | null>(null);

  const [locks, setLocks] = useState<OpenLock[] | null>(null);

  useEffect(() => {
    setSaved(loadSaved());
    try {
      setAddress(window.localStorage.getItem(ADDRESS_KEY) ?? "");
    } catch {
      /* storage unavailable — the form still works */
    }
  }, []);

  useEffect(() => {
    if (!address.trim()) return;
    try {
      window.localStorage.setItem(ADDRESS_KEY, address.trim());
    } catch {
      /* ignore */
    }
  }, [address]);

  // Any lock still standing for this address, read off the ledger. This is what
  // replaces a database: the freelancer's own address is the only key needed.
  useEffect(() => {
    const trimmed = address.trim();
    if (!isStellarAddress(trimmed)) {
      setLocks(null);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        const ids = await listOpenLocks(trimmed);
        const found = await Promise.all(
          ids.slice(0, MAX_LISTED_LOCKS).map(async (id) => ({ id, state: await readLock(id) })),
        );
        if (!cancelled) setLocks(found.filter((entry) => entry.state.amount !== null));
      })();
    }, 500);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [address]);

  const price = useMemo(() => {
    const parsed = Number(amount);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }, [amount]);

  const canCreate = isStellarAddress(address) && price !== null && price <= 1_000_000;

  const create = () => {
    setError(null);
    if (!isStellarAddress(address)) {
      setError("Enter a valid Stellar address first.");
      return;
    }
    if (price === null) {
      setError("Enter a price above zero.");
      return;
    }

    const request: PayRequest = {
      to: address.trim(),
      amount: String(price),
      note: note.trim().slice(0, MAX_NOTE_LENGTH),
      ts: Date.now(),
      dead: Math.floor(Date.now() / 1000) + holdDays * 86_400,
    };

    setSaved(saveRequest(request));
    setLink(buildPayLink(window.location.origin, request));
    setCopied(null);
  };

  const copy = async (value: string, tag: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(tag);
      setTimeout(() => setCopied((current) => (current === tag ? null : current)), 1800);
    } catch {
      setError("Could not reach the clipboard. Select the link and copy it manually.");
    }
  };

  /** Whatever was pasted — a whole link or a bare claim id — opens the payer page. */
  const open = () => {
    const parsed = parsePayInput(openValue);
    if (!parsed) {
      setOpenError(
        "That is not a HoldPay link or a claim id. Paste the whole link, or the 72-character claim id on its own.",
      );
      return;
    }
    setOpenError(null);
    router.push(
      parsed.kind === "claim" ? buildClaimPath(parsed.id) : buildPayPathFromEncoded(parsed.d),
    );
  };

  return (
    <main className="mx-auto w-full max-w-[30rem] px-4 pb-20 pt-9">
      <Brand />

      {/* Two ways in, so a client who simply opens the site can still pay. */}
      <div className="mt-7 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => setTab("get")}
          aria-pressed={tab === "get"}
          className="wallet-button px-3 py-2.5 text-[13.5px] font-semibold"
        >
          Get paid
        </button>
        <button
          type="button"
          onClick={() => setTab("pay")}
          aria-pressed={tab === "pay"}
          className="wallet-button px-3 py-2.5 text-[13.5px] font-semibold"
        >
          Pay a link
        </button>
      </div>

      {tab === "pay" ? (
        <>
          <h1 className="mt-7 text-[2rem] font-semibold leading-[1.1] tracking-[-0.03em]">
            Pay a link.
          </h1>
          <p className="mt-2.5 text-[14.5px] leading-relaxed text-[var(--ink-muted)]">
            Paste the link you were sent, or its claim id. You pay with whatever you already hold —
            the swap happens inside the payment.
          </p>

          <section className="card mt-7 p-4">
            <Field label="HoldPay link or claim id">
              <input
                value={openValue}
                onChange={(event) => {
                  setOpenValue(event.target.value);
                  setOpenError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") open();
                }}
                placeholder="https://…/pay?d=…  or  00000000…"
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="off"
                className="field mono w-full px-3 py-2.5 text-[12.5px]"
              />
            </Field>

            <button
              type="button"
              onClick={open}
              disabled={!openValue.trim()}
              className="pay-button mt-3 w-full rounded-[10px] px-4 py-3 text-[15px]"
            >
              Open
            </button>

            {openError && (
              <p className="mt-2.5 text-[12.5px] leading-relaxed text-[var(--color-copper)]">
                {openError}
              </p>
            )}
          </section>
        </>
      ) : (
        <>
          <h1 className="mt-7 text-[2rem] font-semibold leading-[1.1] tracking-[-0.03em]">
            Get paid in USDC.
          </h1>
          <p className="mt-2.5 text-[14.5px] leading-relaxed text-[var(--ink-muted)]">
            Set a price and share one link. Your client pays with whatever they already hold — the
            swap happens inside the payment, and the USDC is locked for you until you claim it.
          </p>

          <section className="card mt-7 p-4">
            <Field label="Your Stellar address">
              <input
                value={address}
                onChange={(event) => setAddress(event.target.value)}
                placeholder="G…"
                spellCheck={false}
                autoComplete="off"
                className="field mono w-full px-3 py-2.5 text-[13.5px]"
              />
            </Field>

            <div className="mt-2.5">
              <ReceiveStatus address={address} onAddressChange={setAddress} />
            </div>

            <div className="rule my-4" />

            <Field label="Price">
              <div className="relative">
                <input
                  value={amount}
                  onChange={(event) => setAmount(event.target.value.replace(/[^0-9.]/g, ""))}
                  inputMode="decimal"
                  placeholder="0.00"
                  className="field w-full py-2.5 pl-3 pr-16 text-[15px] tabular-nums"
                />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[12px] font-semibold tracking-[0.06em] text-[var(--ink-muted)]">
                  USDC
                </span>
              </div>
            </Field>

            <div className="mt-3.5">
              <Field label="What's the job?">
                <input
                  value={note}
                  onChange={(event) => setNote(event.target.value.slice(0, MAX_NOTE_LENGTH))}
                  placeholder="Logo refresh, two rounds"
                  maxLength={MAX_NOTE_LENGTH}
                  className="field w-full px-3 py-2.5 text-[14px]"
                />
              </Field>
            </div>

            <div className="mt-3.5">
              <Field label="Hold the money for">
                <div className="grid grid-cols-3 gap-2">
                  {HOLD_CHOICES.map((days) => (
                    <button
                      key={days}
                      type="button"
                      onClick={() => setHoldDays(days)}
                      aria-pressed={holdDays === days}
                      className="wallet-button px-3 py-2 text-[13px] font-semibold tabular-nums"
                    >
                      {days} days
                    </button>
                  ))}
                </div>
              </Field>
              <p className="mt-1.5 text-[11.5px] leading-relaxed text-[var(--ink-faint)]">
                Your client&rsquo;s payment is locked for you and only you can claim it. If you never
                claim it, they can take it back after {holdDays} days.
              </p>
            </div>

            <button
              type="button"
              onClick={create}
              disabled={!canCreate}
              className="pay-button mt-4 w-full rounded-[10px] px-4 py-3 text-[15px]"
            >
              Create payment link
            </button>

            {error && <p className="mt-2.5 text-[12.5px] text-[var(--color-copper)]">{error}</p>}
          </section>

          {link && (
            <section className="card fade-in mt-4 p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--ink-muted)]">
                Your link
              </p>

              <div className="mt-2.5 flex items-stretch gap-2">
                <input
                  readOnly
                  value={link}
                  onFocus={(event) => event.currentTarget.select()}
                  className="field mono min-w-0 flex-1 px-3 py-2.5 text-[12px]"
                />
                <button
                  type="button"
                  onClick={() => void copy(link, "link")}
                  className="wallet-button shrink-0 px-3.5 text-[12.5px] font-semibold"
                >
                  {copied === "link" ? "Copied" : "Copy"}
                </button>
              </div>

              <a
                href={link}
                className="mt-2.5 inline-block text-[12.5px] font-semibold text-[var(--color-copper)] underline decoration-[rgba(184,92,56,0.35)] underline-offset-2"
              >
                Open the page your client sees →
              </a>

              <p className="mt-2 text-[11.5px] leading-relaxed text-[var(--ink-faint)]">
                The claim id is made by your client&rsquo;s payment, not by this link — a lock cannot
                exist before there is money to lock. The moment they pay it appears below, and that
                is the link that carries the claim id.
              </p>
            </section>
          )}

          {locks !== null && (
            <section className="mt-8">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--ink-muted)]">
                Locked for you
              </p>

              {locks.length === 0 ? (
                <p className="mt-3 text-[12.5px] leading-relaxed text-[var(--ink-muted)]">
                  Nothing is locked for this address right now.
                </p>
              ) : (
                <ul className="mt-3 space-y-2">
                  {locks.map((entry) => {
                    const claimLink = buildClaimLink(
                      typeof window === "undefined" ? "" : window.location.origin,
                      entry.id,
                    );
                    return (
                      <li key={entry.id} className="card px-3.5 py-3">
                        <div className="flex items-center gap-3">
                          <div className="min-w-0 flex-1">
                            <p className="text-[15px] font-semibold tabular-nums">
                              {formatAmount(entry.state.amount ?? 0)}
                              <span className="ml-1.5 text-[11px] font-semibold tracking-[0.06em] text-[var(--ink-muted)]">
                                USDC
                              </span>
                            </p>
                            <p className="mt-0.5 text-[12px] text-[var(--ink-muted)]">
                              {entry.state.deadline
                                ? `Claim by ${formatWhen(entry.state.deadline * 1000)}`
                                : "Waiting to be claimed"}
                              {entry.state.funder
                                ? ` · from ${shortAddress(entry.state.funder, 4, 4)}`
                                : ""}
                            </p>
                          </div>

                          <a
                            href={buildClaimPath(entry.id)}
                            className="wallet-button shrink-0 px-3 py-1.5 text-[11.5px] font-semibold"
                          >
                            Claim
                          </a>
                        </div>

                        {/* The claim id only exists once someone has paid, so this is
                            the link that carries it — ready to hand to the client. */}
                        <div className="mt-2.5 flex items-stretch gap-2">
                          <input
                            readOnly
                            value={claimLink}
                            onFocus={(event) => event.currentTarget.select()}
                            className="field mono min-w-0 flex-1 px-2.5 py-1.5 text-[10.5px]"
                          />
                          <button
                            type="button"
                            onClick={() => void copy(claimLink, `claim-${entry.id}`)}
                            className="wallet-button shrink-0 px-2.5 py-1.5 text-[11px] font-semibold"
                          >
                            {copied === `claim-${entry.id}` ? "Copied" : "Copy"}
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          )}

          {saved.length > 0 && (
            <section className="mt-8">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--ink-muted)]">
                Saved in this browser
              </p>

              <ul className="mt-3 space-y-2">
                {saved.map((item) => {
                  const itemLink = buildPayLink(
                    typeof window === "undefined" ? "" : window.location.origin,
                    item,
                  );
                  return (
                    <li key={item.savedAt} className="card flex items-center gap-3 px-3.5 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-[15px] font-semibold tabular-nums">
                          {formatUsdc(Number(item.amount))}
                          <span className="ml-1.5 text-[11px] font-semibold tracking-[0.06em] text-[var(--ink-muted)]">
                            USDC
                          </span>
                        </p>
                        <p className="mt-0.5 truncate text-[12.5px] text-[var(--ink-muted)]">
                          {item.note || "No note"}
                          {item.ts ? ` · ${formatWhen(item.ts)}` : ""}
                        </p>
                      </div>

                      <button
                        type="button"
                        onClick={() => void copy(itemLink, `saved-${item.savedAt}`)}
                        className="wallet-button shrink-0 px-2.5 py-1.5 text-[11.5px] font-semibold"
                      >
                        {copied === `saved-${item.savedAt}` ? "Copied" : "Copy"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setSaved(removeSaved(item.savedAt))}
                        aria-label="Remove"
                        className="shrink-0 px-1 text-[15px] leading-none text-[var(--ink-faint)] transition-colors hover:text-[var(--color-copper)]"
                      >
                        ×
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </>
      )}

      <WorkedExample />

      <footer className="mt-10 text-[11.5px] leading-relaxed text-[var(--ink-faint)]">
        Stellar testnet. The price, the note and your address live in the link itself — there is no
        account and no server holding them. A payment is locked on the ledger for the payee, who
        claims it; an unclaimed lock returns to whoever paid it.
      </footer>
    </main>
  );
}

/**
 * The three transactions a lock produces, as they actually happened on testnet.
 * A payment page is a claim about money; this is the receipt for the claim.
 */
function WorkedExample() {
  return (
    <section className="mt-10">
      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--ink-muted)]">
        A worked example, on testnet
      </p>

      <ul className="mt-3 space-y-2">
        {WORKED_EXAMPLE.map((step) => (
          <li key={step.label} className="card px-3.5 py-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[13px] font-semibold">{step.label}</span>
              <a
                href={`${EXPLORER_URL}/tx/${step.hash}`}
                target="_blank"
                rel="noreferrer"
                className="shrink-0 text-[11.5px] font-semibold text-[var(--color-copper)] underline decoration-[rgba(184,92,56,0.35)] underline-offset-2"
              >
                explorer →
              </a>
            </div>
            <p className="mt-0.5 text-[11.5px] leading-relaxed text-[var(--ink-muted)]">
              {step.detail}
            </p>
            <p className="mono mt-1.5 break-all text-[10.5px] text-[var(--ink-faint)]">
              {step.hash}
            </p>
          </li>
        ))}
      </ul>

      <p className="mt-2.5 text-[11.5px] leading-relaxed text-[var(--ink-faint)]">
        Produced by <span className="mono">scripts/e2e.mjs</span> against Stellar testnet, running
        the same code this page runs.
      </p>
    </section>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2">
      <span className="inline-block h-[7px] w-[7px] rounded-full bg-[var(--color-copper)]" />
      <span className="text-[12.5px] font-semibold uppercase tracking-[0.18em]">HoldPay</span>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.13em] text-[var(--ink-muted)]">
        {label}
      </span>
      {children}
    </label>
  );
}

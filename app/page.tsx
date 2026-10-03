"use client";

import { useEffect, useMemo, useState } from "react";
import { ReceiveStatus } from "@/components/receive-status";
import { formatUsdc, formatWhen } from "@/lib/format";
import { MAX_NOTE_LENGTH, buildPayLink, type PayRequest } from "@/lib/link";
import { isStellarAddress } from "@/lib/stellar";
import { loadSaved, removeSaved, saveRequest, type SavedRequest } from "@/lib/store";

const ADDRESS_KEY = "holdpay.address.v1";

export default function HomePage() {
  const [address, setAddress] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedRequest[]>([]);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <main className="mx-auto w-full max-w-[30rem] px-4 pb-20 pt-9">
      <Brand />

      <h1 className="mt-8 text-[2rem] font-semibold leading-[1.1] tracking-[-0.03em]">
        Get paid in USDC.
      </h1>
      <p className="mt-2.5 text-[14.5px] leading-relaxed text-[var(--ink-muted)]">
        Set a price and share one link. Your client pays with whatever they already hold — the
        swap happens inside the payment, and USDC lands in your wallet.
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

      <footer className="mt-10 text-[11.5px] leading-relaxed text-[var(--ink-faint)]">
        Stellar testnet. The price, the note and your address live in the link itself — there is no
        account and no server holding them.
      </footer>
    </main>
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

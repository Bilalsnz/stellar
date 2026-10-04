"use client";

import { useEffect, useState } from "react";
import {
  freighterDeepLink,
  subscribeWalletConnectUri,
  walletConnectUri,
} from "@/lib/walletconnect";
import { isMobileBrowser } from "@/lib/wallet";

/**
 * The hanging-off point for Freighter on a phone.
 *
 * A pairing code arrives from the relay before the wallet has done anything, and
 * this panel is what sits on screen for the whole wait. It offers the two ways
 * to answer a code, and which one leads depends on the device: a phone cannot
 * scan its own screen, so it gets the deep link into the app; a desktop cannot
 * open a phone app, so it gets the code to scan. Both are always given the raw
 * code as a last resort.
 *
 * Nothing here is a spinner on its own. If the pairing fails, the caller closes
 * this panel and says why in one line, and the button that opened it is still
 * there to press again.
 */
export function WalletConnectPanel() {
  const [uri, setUri] = useState<string | null>(() => walletConnectUri());
  // Server-rendered output cannot know the device, so the choice is made once
  // mounted rather than during render — otherwise hydration would disagree.
  const [mobile, setMobile] = useState<boolean | null>(null);

  useEffect(() => subscribeWalletConnectUri(setUri), []);

  useEffect(() => {
    setMobile(isMobileBrowser());
  }, []);

  if (!uri) return null;

  return (
    <div className="card fade-in mt-3 p-3.5">
      <p className="text-[12.5px] font-semibold">Waiting for Freighter…</p>
      <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--ink-muted)]">
        {mobile === false
          ? "Scan this code with Freighter on your phone, then approve."
          : "Open Freighter to approve, then come back to this page."}
      </p>

      <div className="mt-3 flex flex-col items-center gap-3">
        {mobile === false && <QrCode text={uri} />}

        {mobile !== false && (
          <a
            href={freighterDeepLink(uri)}
            className="pay-button w-full rounded-[10px] px-4 py-3 text-center text-[14.5px]"
          >
            Open Freighter
          </a>
        )}
      </div>

      <CodeFallback uri={uri} />
    </div>
  );
}

/**
 * The code itself, for the case neither button fits — a phone whose app does not
 * answer the link, or a desktop with the wallet on a tablet. It is a long string
 * and it is not pretty, so it stays folded away until asked for.
 */
function CodeFallback({ uri }: { uri: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(uri);
      setCopied(true);
    } catch {
      // Clipboard access is refused in plenty of ordinary situations. The code
      // is on screen and selectable either way, so this is not worth a message.
      setCopied(false);
    }
  };

  return (
    <details className="mt-3">
      <summary className="cursor-pointer text-[11.5px] font-semibold text-[var(--ink-muted)]">
        Use the pairing code instead
      </summary>
      <p className="mono mt-2 break-all text-[10.5px] leading-relaxed text-[var(--ink-faint)]">
        {uri}
      </p>
      <button
        type="button"
        onClick={() => void copy()}
        className="mt-2 text-[11.5px] font-semibold text-[var(--color-copper)] underline decoration-[rgba(184,92,56,0.35)] underline-offset-2"
      >
        {copied ? "Copied" : "Copy the code"}
      </button>
    </details>
  );
}

interface QrCode {
  addData(data: string): void;
  make(): void;
  createSvgTag(options?: { cellSize?: number; margin?: number }): string;
}

type QrFactory = (typeNumber: number, errorCorrectionLevel: string) => QrCode;

/**
 * The encoder is a single dependency-free file and is only needed once a code
 * exists, so it is loaded on demand rather than carried by every page.
 */
function QrCode({ text }: { text: string }) {
  const [svg, setSvg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);

    void (async () => {
      try {
        const imported = (await import("qrcode-generator")) as unknown as
          | QrFactory
          | { default: QrFactory };
        const factory: QrFactory =
          typeof imported === "function" ? imported : imported.default;
        const code = factory(0, "M");
        code.addData(text);
        code.make();
        if (!cancelled) setSvg(code.createSvgTag({ cellSize: 4, margin: 1 }));
      } catch {
        // Without a code the deep link and the raw string still stand, so a
        // failure to draw is not worth blocking the connection over.
        if (!cancelled) setSvg(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [text]);

  return (
    <div className="flex h-[172px] w-[172px] items-center justify-center rounded-[8px] border border-[var(--color-line)] bg-white p-1.5">
      {svg ? (
        <div
          className="h-full w-full [&>svg]:h-full [&>svg]:w-full"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <span className="px-3 text-center text-[11px] leading-relaxed text-[var(--ink-faint)]">
          The code could not be drawn. Use the pairing code below.
        </span>
      )}
    </div>
  );
}

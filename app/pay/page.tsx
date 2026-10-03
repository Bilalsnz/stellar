import { Suspense } from "react";
import type { Metadata } from "next";
import { PayView } from "./pay-view";

export const metadata: Metadata = {
  title: "Pay — HoldPay",
  description: "Pay this request with any Stellar asset you hold. The recipient receives USDC.",
};

export default function PayPage() {
  return (
    <Suspense
      fallback={
        <main className="mx-auto w-full max-w-[30rem] px-4 pb-20 pt-9">
          <p className="text-[13px] text-[var(--ink-muted)]">Loading…</p>
        </main>
      }
    >
      <PayView />
    </Suspense>
  );
}

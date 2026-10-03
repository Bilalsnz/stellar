import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "HoldPay — one link, paid in USDC",
  description:
    "Set a price in USDC, share one link. Your client pays with any asset they already hold and you receive USDC on Stellar.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f4efe6",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh antialiased">
        {/* The grade. Swapped to olive by the pay page once the payment lands. */}
        <div className="wash" aria-hidden="true" />
        <div className="relative z-10">{children}</div>
      </body>
    </html>
  );
}

/** Tight, plain number formatting. No currency symbols hiding the unit. */

export function formatUsdc(value: number): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Crypto amounts read better trimmed: 42.2913954 stays precise, 5.0000000
 * becomes 5. We keep up to `maxDecimals` and never round a small amount to 0.
 */
export function formatAmount(value: number, maxDecimals = 7): string {
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return "0";

  const fixed = value.toFixed(maxDecimals);
  const trimmed = fixed.replace(/0+$/, "").replace(/\.$/, "");

  // A tiny non-zero amount would trim away to nothing; keep two significant digits.
  if (Number(trimmed) === 0 && value > 0) return value.toPrecision(2);
  return trimmed;
}

/** Units of the spent asset per 1 USDC. */
export function formatRate(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "—";
  if (value >= 1000) return value.toFixed(0);
  if (value >= 1) return value.toFixed(4);
  return value.toPrecision(4);
}

export function formatWhen(ts: number): string {
  if (!ts) return "";
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

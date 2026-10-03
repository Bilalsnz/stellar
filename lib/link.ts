/**
 * The whole payment request lives inside the link. There is no id, no lookup
 * and no database: the freelancer's page encodes the destination, the price and
 * the note into the URL, and the client's browser decodes it locally.
 */

export interface PayRequest {
  /** Freelancer's Stellar address — where the USDC lands. */
  to: string;
  /** Price in USDC, as a plain decimal string. */
  amount: string;
  /** Short job note. */
  note: string;
  /** Created at, ms since epoch. */
  ts: number;
}

export const MAX_NOTE_LENGTH = 80;

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const remainder = padded.length % 4;
  const binary = atob(remainder === 0 ? padded : padded + "=".repeat(4 - remainder));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function encodeRequest(request: PayRequest): string {
  const bytes = new TextEncoder().encode(JSON.stringify(request));
  return bytesToBase64Url(bytes);
}

/** Returns null rather than throwing — a mangled link is a normal thing to meet. */
export function decodeRequest(value: string | null | undefined): PayRequest | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(value))) as Partial<PayRequest>;

    if (typeof parsed.to !== "string" || !parsed.to) return null;
    if (typeof parsed.amount !== "string" || !parsed.amount) return null;

    const amount = Number(parsed.amount);
    if (!Number.isFinite(amount) || amount <= 0) return null;

    return {
      to: parsed.to,
      amount: parsed.amount,
      note: typeof parsed.note === "string" ? parsed.note : "",
      ts: typeof parsed.ts === "number" ? parsed.ts : 0,
    };
  } catch {
    return null;
  }
}

export function buildPayPath(request: PayRequest): string {
  return `/pay?d=${encodeRequest(request)}`;
}

export function buildPayLink(origin: string, request: PayRequest): string {
  return `${origin}${buildPayPath(request)}`;
}

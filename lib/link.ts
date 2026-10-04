/**
 * The whole payment request lives inside the link. There is no id, no lookup
 * and no database: the freelancer's page encodes the destination, the price,
 * the note and the deadline into the URL, and the client's browser decodes it
 * locally.
 *
 * A link can also be reduced to just its claim id once the lock exists on the
 * ledger — Horizon resolves that to the amount, the asset and the claimant, so
 * it is payable without carrying anything else.
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
  /**
   * Unix seconds. The client's payment locks the USDC in a claimable balance
   * destined to `to`; at or after this moment the client may take it back.
   * Absent on links made before the lock existed — those still pay directly.
   */
  dead?: number;
}

export const MAX_NOTE_LENGTH = 80;

/** Claimable balance ids are a 4-byte type prefix plus a 32-byte hash. */
export const CLAIM_ID_LENGTH = 72;

export function isClaimId(value: string): boolean {
  return /^[0-9a-f]{72}$/i.test(value.trim());
}

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

    const dead =
      typeof parsed.dead === "number" && Number.isFinite(parsed.dead) && parsed.dead > 0
        ? parsed.dead
        : undefined;

    return {
      to: parsed.to,
      amount: parsed.amount,
      note: typeof parsed.note === "string" ? parsed.note : "",
      ts: typeof parsed.ts === "number" ? parsed.ts : 0,
      ...(dead ? { dead } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * The payer path for an already-encoded request. This is what "Pay a link"
 * needs: the pasted value has been decoded once to check it is real, and is
 * then passed through untouched rather than re-encoded.
 */
export function buildPayPathFromEncoded(encoded: string): string {
  return `/pay?d=${encoded}`;
}

export function buildPayPath(request: PayRequest): string {
  return buildPayPathFromEncoded(encodeRequest(request));
}

export function buildPayLink(origin: string, request: PayRequest): string {
  return `${origin}${buildPayPath(request)}`;
}

export function buildClaimPath(claimId: string): string {
  return `/pay?c=${claimId}`;
}

export function buildClaimLink(origin: string, claimId: string): string {
  return `${origin}${buildClaimPath(claimId)}`;
}

/** What someone pasted into "Pay a link". */
export type PayInput = { kind: "link"; d: string } | { kind: "claim"; id: string };

/**
 * Accepts anything a person might paste: a whole HoldPay URL, a bare query
 * string, the encoded `d` value on its own, or a claim id. Returns null when it
 * is none of those, so the page can say so instead of guessing.
 */
export function parsePayInput(value: string): PayInput | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;

  // A claim id is plain 72-char hex, and is checked first so a pasted id is
  // never mistaken for an encoded link.
  if (isClaimId(raw)) return { kind: "claim", id: raw.toLowerCase() };

  const query = raw.includes("?") ? raw.slice(raw.indexOf("?") + 1) : raw.replace(/^[?&]+/, "");
  const params = new URLSearchParams(query);

  const claim = params.get("c");
  if (claim && isClaimId(claim)) return { kind: "claim", id: claim.toLowerCase() };

  const encoded = params.get("d");
  if (encoded && decodeRequest(encoded)) return { kind: "link", d: encoded };

  // No key at all: the pasted text may be the encoded request by itself, with
  // or without the `pay`/`d=` scaffolding someone copied along with it.
  // `decodeRequest` rejects anything that is not a real request, so trying it
  // on the raw text costs nothing and catches the bare-value case.
  const bare = raw.replace(/^\/?pay\/?\??/, "").replace(/^d=/, "");
  if (decodeRequest(bare)) return { kind: "link", d: bare };
  if (decodeRequest(raw)) return { kind: "link", d: raw };

  return null;
}

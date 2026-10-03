import type { PayRequest } from "./link";
import { MAX_NOTE_LENGTH } from "./link";

/**
 * The freelancer's own links, kept in this browser only. Nothing is uploaded
 * anywhere — clearing site data clears this list.
 */
const STORAGE_KEY = "holdpay.requests.v1";
const MAX_SAVED = 50;

export interface SavedRequest extends PayRequest {
  savedAt: number;
}

function isSavedRequest(value: unknown): value is SavedRequest {
  const candidate = value as Partial<SavedRequest> | null;
  return (
    !!candidate &&
    typeof candidate.to === "string" &&
    typeof candidate.amount === "string" &&
    typeof candidate.note === "string" &&
    typeof candidate.savedAt === "number"
  );
}

export function loadSaved(): SavedRequest[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isSavedRequest).slice(0, MAX_SAVED);
  } catch {
    // Private mode, blocked storage, or corrupt data — the page still works.
    return [];
  }
}

export function saveRequest(request: PayRequest): SavedRequest[] {
  const entry: SavedRequest = {
    ...request,
    note: request.note.slice(0, MAX_NOTE_LENGTH),
    savedAt: Date.now(),
  };

  const next = [entry, ...loadSaved().filter((item) => item.savedAt !== entry.savedAt)].slice(
    0,
    MAX_SAVED,
  );

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable — the link still works, it just is not remembered.
  }
  return next;
}

export function removeSaved(savedAt: number): SavedRequest[] {
  const next = loadSaved().filter((item) => item.savedAt !== savedAt);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  return next;
}

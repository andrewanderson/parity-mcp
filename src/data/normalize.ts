import type { PlayerRef, RawPlayerRef } from "../domain/types.js";

const SUBSTITUTE_MARKER = /\(S\)$/i;

/**
 * Normalize a raw player reference from capture payloads.
 * Strips only the terminal `(S)` substitute marker and trims whitespace.
 * The raw input is preserved untouched; no other Unicode transformations.
 */
export function normalizePlayerRef(raw: RawPlayerRef): PlayerRef {
  const isSubstitute = SUBSTITUTE_MARKER.test(raw);
  const name = raw.replace(SUBSTITUTE_MARKER, "").trim();
  return { raw, name, isSubstitute };
}

/**
 * Parse a fixture timestamp string like "3/15/2026, 6:13:40 PM" as a local
 * naive time. Seconds are optional in the expected format.
 */
export function parseLocalTimestamp(raw: string): {
  timestampLocal: string;
  timestampSec: number | null;
} {
  const match =
    /^(\d{1,2})\/(\d{1,2})\/(\d{4}), (\d{1,2}):(\d{2})(?::(\d{2}))? (AM|PM)$/.exec(
      raw,
    );
  if (match === null) {
    return { timestampLocal: raw, timestampSec: null };
  }

  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  const hourTwelve = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const period = match[7];

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return { timestampLocal: raw, timestampSec: null };
  }
  if (hourTwelve < 1 || hourTwelve > 12) {
    return { timestampLocal: raw, timestampSec: null };
  }

  const hour = period === "PM" ? (hourTwelve % 12) + 12 : hourTwelve % 12;
  const date = new Date(year, month - 1, day, hour, minute, second);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return { timestampLocal: raw, timestampSec: null };
  }
  const timestampSec = date.getTime() / 1000;

  return { timestampLocal: raw, timestampSec };
}

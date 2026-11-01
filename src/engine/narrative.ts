import type { GamePayload } from "../domain/types.js";

/**
 * How a stretch of consecutive points is characterized: a single team's
 * scoring run, a stretch of traded breaks, or an on-serve exchange of holds.
 */
export type StretchKind = "run" | "trades" | "on-serve";

/** A contiguous stretch of points with a single narrative character. */
export type Stretch = {
  kind: StretchKind;
  startPointNumber: number;
  endPointNumber: number;
  /** Non-null for "run" stretches only. */
  team: string | null;
  /** Scorer tallies by raw name within the stretch span; null scorers are skipped. */
  scorers: Array<{ name: string; goals: number }>;
};

/** A notable per-point detail, derived purely from recorded events. */
export type PointTerm = "callahan" | "double-happiness" | "transition" | "clean-possession";

/** Per-point narrative notes. Empty or unattributable data yields nulls/empty lists. */
export type PointNote = {
  pointNumber: number;
  completions: number;
  /** Longest gap between consecutive events; null when any event lacks timestampSec. */
  longestGapSec: number | null;
  terms: PointTerm[];
};

/** A team's break chances, break conversions, and best hold streak in the game. */
export type ConversionStats = {
  team: string;
  breakChances: number;
  breakConversions: number;
  /** Longest contiguous streak of HOLDs scored by this team; null when under 2. */
  longestHoldStreak: { length: number; start: number; end: number } | null;
  /** True when the streak starts before and ends at or after the half boundary. */
  survivedHalfBoundary: boolean;
};

/**
 * The server-derived story shape of a game. Tasks may land partial payloads:
 * fields whose derivation is not yet implemented return empty lists or nulls,
 * never guesses.
 */
export type NarrativePayload = {
  secondHalfStartPoint: number | null;
  stretches: Stretch[];
  conversions: ConversionStats[];
  pointNotes: PointNote[];
};

/**
 * The point number where the second half starts, derived from the recorded
 * PULL events. Exactly two PULLs yield the second one's point number; any
 * other count (missing or duplicated pulls) is unattributable and yields null.
 */
export function buildHalfBoundary(payload: GamePayload): number | null {
  const pullPoints: number[] = [];
  for (const point of payload.game.points) {
    for (const event of point.events) {
      if (event.type === "PULL") {
        pullPoints.push(point.pointNumber);
      }
    }
  }
  if (pullPoints.length !== 2) return null;
  return pullPoints[1] ?? null;
}

/**
 * Per-point notes: completions from recorded PASS events. Every point gets a
 * note, including points with no events. The timestamp-derived and
 * term-derived fields are filled by later tasks and stay null/empty here.
 */
export function buildPointNotes(payload: GamePayload): PointNote[] {
  return payload.game.points.map((point) => {
    let completions = 0;
    for (const event of point.events) {
      if (event.type === "PASS") {
        completions += 1;
      }
    }
    return {
      pointNumber: point.pointNumber,
      completions,
      longestGapSec: null,
      terms: [],
    };
  });
}

/**
 * Derive the narrative payload from a canonical game payload. Deterministic
 * and pure: nothing is invented, and unattributable data yields nulls or
 * empty lists. Stretches and conversions are filled by later tasks.
 */
export function buildNarrative(payload: GamePayload): NarrativePayload {
  return {
    secondHalfStartPoint: buildHalfBoundary(payload),
    stretches: [],
    conversions: [],
    pointNotes: buildPointNotes(payload),
  };
}

import type { Event, GamePayload } from "../domain/types.js";

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
 * Longest gap between consecutive event timestamps, in seconds. Single pass
 * over consecutive pairs: null propagates when any timestampSec is missing,
 * and fewer than two events yield null. Pure; never mutates the input.
 */
function longestGap(events: readonly Event[]): number | null {
  if (events.length < 2) return null;
  let longest: number | null = null;
  let previous: number | null = null;
  for (const event of events) {
    if (event.timestampSec === null) return null;
    if (previous !== null) {
      const gap = event.timestampSec - previous;
      if (longest === null || gap > longest) longest = gap;
    }
    previous = event.timestampSec;
  }
  return longest;
}

/**
 * Normalized actor comparison key: `trim().toLowerCase()`. An absent or blank
 * actor yields null, which never matches a real player.
 */
function actorKey(raw: string | null): string | null {
  if (raw === null) return null;
  const key = raw.trim().toLowerCase();
  return key === "" ? null : key;
}

/** True for the event types that hand over possession. */
function isTurnoverEvent(event: Event): boolean {
  return (
    event.type === "THROWAWAY" || event.type === "DROP" || event.type === "DEFENSE"
  );
}

/** Index of the first recorded POINT event; events.length when none exists. */
function firstPointIndex(events: readonly Event[]): number {
  for (let i = 0; i < events.length; i += 1) {
    if (events[i]!.type === "POINT") return i;
  }
  return events.length;
}

/**
 * The final THROWAWAY/DROP/DEFENSE event before the POINT event. The first
 * recorded POINT bounds the walk: anything after it belongs to the recording
 * tail, not the possession chain. Returns null when no possession change is
 * recorded before scoring.
 */
function lastTurnover(events: readonly Event[]): Event | null {
  for (let i = firstPointIndex(events) - 1; i >= 0; i -= 1) {
    if (isTurnoverEvent(events[i]!)) return events[i]!;
  }
  return null;
}

/** PASS count among events with an index before `end`. */
function countPasses(events: readonly Event[], end: number): number {
  let passes = 0;
  for (let i = 0; i < end; i += 1) {
    if (events[i]!.type === "PASS") passes += 1;
  }
  return passes;
}

/** PASS count strictly between the turnover event and the POINT event. */
function passesAfter(event: Event, events: readonly Event[]): number {
  const start = events.indexOf(event) + 1;
  let count = 0;
  for (let i = start; i < firstPointIndex(events); i += 1) {
    if (events[i]!.type === "PASS") count += 1;
  }
  return count;
}

/**
 * Scorer of the point: the actor on the first recorded POINT event.
 * Returns null when no POINT event exists or its actor is blank.
 */
function scorerKey(events: readonly Event[]): string | null {
  for (const event of events) {
    if (event.type === "POINT") {
      return actorKey(event.firstActor ?? event.secondActor);
    }
  }
  return null;
}

/**
 * Earned terms for one point, from its event bookends. Every term here
 * describes a scoring possession, so a point with no recorded POINT event
 * earns nothing (empty terms, never a guess). With a POINT event, the last
 * turnover before it classifies the point, and exactly one of
 * callahan/double-happiness/transition is earned. With zero turnover events
 * and at least five completions the point is clean-possession (exclusive of
 * the other three by construction); below the floor it earns nothing.
 * A DEFENSE whose blocker cannot be attributed to the scorer (missing or
 * blank actors) is unattributable and yields empty terms, never a guess.
 */
function collectPointTerms(events: readonly Event[]): PointTerm[] {
  const pointIndex = firstPointIndex(events);
  if (pointIndex === events.length) return [];

  const turnover = lastTurnover(events);
  if (turnover === null) {
    return countPasses(events, pointIndex) >= 5 ? ["clean-possession"] : [];
  }

  if (turnover.type !== "DEFENSE") {
    return ["transition"];
  }

  const blocker = actorKey(turnover.firstActor ?? turnover.secondActor);
  const scorer = scorerKey(events);
  if (blocker === null || scorer === null) return [];

  if (blocker !== scorer) return ["transition"];
  return passesAfter(turnover, events) >= 1 ? ["double-happiness"] : ["callahan"];
}

/**
 * Per-point notes: completions from recorded PASS events, the longest gap
 * between consecutive event timestamps, and earned terms from the point's
 * event bookends (at most one term per point).
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
      longestGapSec: longestGap(point.events),
      terms: collectPointTerms(point.events),
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

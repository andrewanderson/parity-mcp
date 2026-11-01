import type { Event, GamePayload } from "../domain/types.js";
import {
  buildScoreTimelineAndStoryFacts,
  type ScoreTimelineItem,
  type ScoringRun,
} from "./timeline.js";

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
 * Timeline slice covering the inclusive point-number span [start, end].
 */
function spanItems(
  timeline: readonly ScoreTimelineItem[],
  start: number,
  end: number,
): ScoreTimelineItem[] {
  return timeline.filter(
    (item) => item.pointNumber >= start && item.pointNumber <= end,
  );
}

/**
 * Scorer tallies by raw name over the slice's non-null scorers, preserving
 * first-seen order. Null scorers are unattributable and never counted.
 */
function scorerTallies(
  items: readonly ScoreTimelineItem[],
): Array<{ name: string; goals: number }> {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const item of items) {
    if (item.scorer === null) continue;
    const next = (counts.get(item.scorer) ?? 0) + 1;
    if (next === 1) order.push(item.scorer);
    counts.set(item.scorer, next);
  }
  return order.map((name) => ({ name, goals: counts.get(name) ?? 0 }));
}

/**
 * Classify stretches over the timeline's scoring runs only (reused, never
 * recomputed). Greedily group consecutive runs into an alternation block
 * while every run has length 1, each run is contiguous with its neighbour,
 * and the teams alternate between exactly two teams: the block is on-serve
 * when every timeline point in its span recorded a HOLD, otherwise trades.
 * Every remaining run is its own stretch, kind "run", carrying the run's
 * team (a length-1 run is a one-point run stretch). Scorer tallies are
 * built per stretch span from the timeline slice's non-null raw scorers.
 */
function buildStretches(
  timeline: readonly ScoreTimelineItem[],
  scoringRuns: readonly ScoringRun[],
): Stretch[] {
  const stretches: Stretch[] = [];
  let i = 0;
  while (i < scoringRuns.length) {
    let j = i;
    const blockTeams = new Set<string>([scoringRuns[i]!.team]);
    while (j + 1 < scoringRuns.length) {
      const current = scoringRuns[j]!;
      const next = scoringRuns[j + 1]!;
      if (
        current.length === 1 &&
        next.length === 1 &&
        next.startPointNumber === current.endPointNumber + 1 &&
        next.team !== current.team &&
        (blockTeams.size < 2 || blockTeams.has(next.team))
      ) {
        blockTeams.add(next.team);
        j += 1;
      } else {
        break;
      }
    }
    const first = scoringRuns[i]!;
    const last = scoringRuns[j]!;
    const slice = spanItems(timeline, first.startPointNumber, last.endPointNumber);
    if (j > i) {
      const allHold = slice.every((item) => item.holdOrBreak === "HOLD");
      stretches.push({
        kind: allHold ? "on-serve" : "trades",
        startPointNumber: first.startPointNumber,
        endPointNumber: last.endPointNumber,
        team: null,
        scorers: scorerTallies(slice),
      });
    } else {
      stretches.push({
        kind: "run",
        startPointNumber: first.startPointNumber,
        endPointNumber: last.endPointNumber,
        team: first.team,
        scorers: scorerTallies(slice),
      });
    }
    i = j + 1;
  }
  return stretches;
}

/**
 * Derive the narrative payload from a canonical game payload. Deterministic
 * and pure: nothing is invented, and unattributable data yields nulls or
 * empty lists. Stretches are classified from the timeline's scoring runs;
 * conversions are filled by a later task.
 */
export function buildNarrative(payload: GamePayload): NarrativePayload {
  const { timeline, storyFacts } = buildScoreTimelineAndStoryFacts(payload);
  return {
    secondHalfStartPoint: buildHalfBoundary(payload),
    stretches: buildStretches(timeline, storyFacts.scoringRuns),
    conversions: [],
    pointNotes: buildPointNotes(payload),
  };
}

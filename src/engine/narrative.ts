import type { Event, GamePayload } from "../domain/types.js";
import { firstPointIndex, possessionChain } from "../domain/possessionChain.js";
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

/** A contiguous stretch of points with a single narrative character and a half placement. */
export type Stretch = {
  kind: StretchKind;
  startPointNumber: number;
  endPointNumber: number;
  /** Non-null for "run" stretches only. */
  team: string | null;
  /**
   * The half the stretch falls in, from `secondHalfStartPoint`: 1 when the
   * whole span is strictly before the boundary, 2 when it starts at or after
   * it, "spans" when it straddles it, and null when there is no valid boundary.
   */
  half: 1 | 2 | "spans" | null;
  /** Scorer tallies by raw name within the stretch span; null scorers are skipped. */
  scorers: Array<{ name: string; goals: number }>;
};

/** A notable per-point detail, derived purely from recorded events. */
export type PointTerm = "callahan" | "double-happiness";

/** Per-point narrative notes. Empty or unattributable data yields nulls/empty lists. */
export type PointNote = {
  pointNumber: number;
  completions: number;
  /** Longest gap between consecutive events; null when any event lacks timestampSec. */
  longestGapSec: number | null;
  terms: PointTerm[];
  /**
   * Number of possessions in the point; each turnover moment starts a new
   * possession (a THROWAWAY immediately followed by a DEFENSE is one moment,
   * the throw and the block).
   */
  possessionCount: number;
  /** Passes in the possession that ended with the goal; 0 without a recorded POINT event. */
  scoringPossessionLength: number;
  /**
   * Which possession in the chain scored the goal. The chain starts with the
   * offence-line team and alternates at every possession boundary, so an odd
   * index means the scoring team held the disc when the point started and an
   * even index means it did not; 0 without a recorded POINT event.
   */
  scoringPossessionIndex: number;
  /** Turnover moments in the point before the goal, counting a throwaway-then-block pair as one. */
  turnoversBeforeGoal: number;
  /**
   * Passes between the last turnover moment before the goal and the goal;
   * 0 when the scoring possession is the first or there is no recorded POINT
   * event.
   */
  passesAfterLastTurnover: number;
};

/** A team's break chances, break conversions, and best hold streak in the game. */
export type ConversionStats = {
  team: string;
  breakChances: number;
  breakConversions: number;
  /**
   * Longest unbroken run of this team's offensive points all ending in a HOLD
   * (first and last held point numbers); null when under 2.
   */
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
  /** True when the game entered the final attributed point tied. */
  universePoint: boolean;
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
 * turnover event before it classifies the point: only a DEFENSE whose blocker
 * matches the scorer earns a term (callahan when no completion followed the
 * block, double-happiness otherwise); every other shape earns nothing, never
 * a guess. A DEFENSE whose blocker or scorer cannot be attributed (missing or
 * blank actors) yields empty terms. The `transition` and `clean-possession`
 * terms are retired: they fired on ordinary play and are replaced by the
 * possession-chain fields.
 */
function collectPointTerms(events: readonly Event[]): PointTerm[] {
  const pointIndex = firstPointIndex(events);
  if (pointIndex === events.length) {
    return [];
  }
  const turnover = lastTurnover(events);
  if (turnover === null || turnover.type !== "DEFENSE") {
    return [];
  }
  const blocker = actorKey(turnover.firstActor ?? turnover.secondActor);
  const scorer = scorerKey(events);
  if (blocker === null || scorer === null || blocker !== scorer) {
    return [];
  }
  return passesAfter(turnover, events) >= 1 ? ["double-happiness"] : ["callahan"];
}

/**
 * Per-point notes: completions from recorded PASS events, the longest gap
 * between consecutive event timestamps, earned terms from the point's event
 * bookends (at most one term per point), and the possession-chain facts of
 * the point (walked by `possessionChain`, shared with the quality stage so
 * the narrative and the chain-parity warning never drift).
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
      ...possessionChain(point.events),
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
 * Half of a stretch span against the second-half boundary: null without a
 * boundary, 1 when the span ends before it, 2 when it starts at or after it,
 * and "spans" when it straddles it.
 */
function stretchHalf(
  start: number,
  end: number,
  secondHalfStartPoint: number | null,
): Stretch["half"] {
  if (secondHalfStartPoint === null) return null;
  if (end < secondHalfStartPoint) return 1;
  if (start >= secondHalfStartPoint) return 2;
  return "spans";
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
 * Each stretch carries its half relative to the second-half boundary.
 */
function buildStretches(
  timeline: readonly ScoreTimelineItem[],
  scoringRuns: readonly ScoringRun[],
  secondHalfStartPoint: number | null,
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
    const half = stretchHalf(
      first.startPointNumber,
      last.endPointNumber,
      secondHalfStartPoint,
    );
    if (j > i) {
      const allHold = slice.every((item) => item.holdOrBreak === "HOLD");
      stretches.push({
        kind: allHold ? "on-serve" : "trades",
        startPointNumber: first.startPointNumber,
        endPointNumber: last.endPointNumber,
        team: null,
        half,
        scorers: scorerTallies(slice),
      });
    } else {
      stretches.push({
        kind: "run",
        startPointNumber: first.startPointNumber,
        endPointNumber: last.endPointNumber,
        team: first.team,
        half,
        scorers: scorerTallies(slice),
      });
    }
    i = j + 1;
  }
  return stretches;
}

/**
 * Longest unbroken run for `team` over the timeline's attributed points. A
 * team is unbroken while every point it was on offence for ended in its own
 * HOLD: its HOLD grows the streak, the opponent's BREAK resets it, and an
 * unattributed point (null scoringTeam or holdOrBreak) resets it too. The
 * opponent's HOLDs and the team's own BREAKs are not offensive points for
 * the team and neither grow nor reset the streak. `start` and `end` are the
 * first and last held point numbers of the streak. Returns null when the
 * longest streak is under 2 holds.
 */
function longestHoldStreak(
  timeline: readonly ScoreTimelineItem[],
  team: string,
): { length: number; start: number; end: number } | null {
  let best: { length: number; start: number; end: number } | null = null;
  let length = 0;
  let start = 0;
  for (const item of timeline) {
    if (item.scoringTeam === null || item.holdOrBreak === null) {
      length = 0;
    } else if (item.scoringTeam === team && item.holdOrBreak === "HOLD") {
      if (length === 0) start = item.pointNumber;
      length += 1;
      if (best === null || length > best.length) {
        best = { length, start, end: item.pointNumber };
      }
    } else if (item.scoringTeam !== team && item.holdOrBreak === "BREAK") {
      length = 0;
    }
  }
  return best !== null && best.length >= 2 ? best : null;
}
/**
 * Per-roster-team conversion stats, over the timeline's attributed points
 * only (`scoringTeam` non-null; an attributed point with unresolvable lines
 * has a null holdOrBreak and counts as neither chance nor conversion). A
 * break chance is a point the team started on defence and did not win by
 * breaking: a HOLD scored by the other team, or a BREAK scored by this team.
 * A break conversion is a BREAK scored by this team. `survivedHalfBoundary`
 * is false without a streak or without a valid two-PULL half boundary.
 */
function buildConversions(
  payload: GamePayload,
  timeline: readonly ScoreTimelineItem[],
  secondHalfStartPoint: number | null,
): ConversionStats[] {
  return [payload.game.homeTeam, payload.game.awayTeam].map((team) => {
    let breakChances = 0;
    let breakConversions = 0;
    for (const item of timeline) {
      if (item.scoringTeam === null) continue;
      if (item.holdOrBreak === "BREAK") {
        if (item.scoringTeam === team) {
          breakChances += 1;
          breakConversions += 1;
        }
      } else if (item.holdOrBreak === "HOLD" && item.scoringTeam !== team) {
        breakChances += 1;
      }
    }
    const streak = longestHoldStreak(timeline, team);
    return {
      team,
      breakChances,
      breakConversions,
      longestHoldStreak: streak,
      survivedHalfBoundary:
        streak !== null &&
        secondHalfStartPoint !== null &&
        streak.start < secondHalfStartPoint &&
        secondHalfStartPoint <= streak.end,
    };
  });
}

/**
 * Whether the game entered its final attributed point tied: the timeline item
 * before the last attributed item shows equal home and away scores. Fewer
 * than two attributed points yield false.
 */
function buildUniversePoint(timeline: readonly ScoreTimelineItem[]): boolean {
  const attributed = timeline.filter((item) => item.scoringTeam !== null);
  if (attributed.length < 2) return false;
  const entering = attributed[attributed.length - 2]!;
  return entering.homeScore === entering.awayScore;
}

/**
 * Derive the narrative payload from a canonical game payload. Deterministic
 * and pure: nothing is invented, and unattributable data yields nulls or
 * empty lists. Stretches are classified from the timeline's scoring runs;
 * conversions track break chances, break conversions, and hold streaks.
 */
export function buildNarrative(payload: GamePayload): NarrativePayload {
  const { timeline, storyFacts } = buildScoreTimelineAndStoryFacts(payload);
  const secondHalfStartPoint = buildHalfBoundary(payload);
  return {
    secondHalfStartPoint,
    stretches: buildStretches(timeline, storyFacts.scoringRuns, secondHalfStartPoint),
    conversions: buildConversions(payload, timeline, secondHalfStartPoint),
    pointNotes: buildPointNotes(payload),
    universePoint: buildUniversePoint(timeline),
  };
}

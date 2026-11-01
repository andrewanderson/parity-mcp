import type {
  GamePayload,
  RawPlayerRef,
} from "../domain/types.js";
import { attribution } from "../data/normalize.js";

/** One scored point in the game's score progression, derived purely from event data. */
export type ScoreTimelineItem = {
  pointNumber: number;
  /** Season-scoped team name resolved from event/roster/stats data; null when unattributable. */
  scoringTeam: string | null;
  /** Raw scorer reference recorded on the POINT event; null when absent. */
  scorer: string | null;
  /** The scoring team started the point on offense (HOLD) or defense (BREAK); null when unattributable. */
  holdOrBreak: "HOLD" | "BREAK" | null;
  awayScore: number;
  homeScore: number;
};

/** The moment one team took the lead from the other (or from a tie). */
export type LeadItem = {
  team: string;
  pointNumber: number;
  awayScore: number;
  homeScore: number;
};

/** Consecutive scored points by the same team. */
export type ScoringRun = {
  team: string;
  length: number;
  startPointNumber: number;
  endPointNumber: number;
};

/** A team's climb back from a deficit. */
export type ComebackItem = {
  team: string;
  /** Deepest deficit (in points) the team faced on the way back. */
  maxDeficit: number;
  /** First point where the team reached a positive margin after trailing. */
  comebackCompletedAt: number | null;
};

/** Derived game-story facts. Empty/no-score data yields nulls and empty lists. */
export type GameStoryFacts = {
  finalPoint: ScoreTimelineItem | null;
  leadChanges: LeadItem[];
  scoringRuns: ScoringRun[];
  largestLead: LeadItem | null;
  /**
   * Largest comeback by the eventual winning team (the team with more
   * event-derived final points). Null for a tie or when the winner never
   * trailed. "First positive margin after trailing" is per brief; the deficit
   * is the deepest one faced on the way there.
   */
  largestComeback: ComebackItem | null;
};

/**
 * Attribute a point's scoring team and its line-based hold/break label from
 * the recorded POINT event. The implementation lives in `src/data/normalize.ts`
 * and is shared with `qualityReport`, so the label the timeline reports and
 * the label the quality stage compares against are always one attribution.
 */

/**
 * Which score bucket a scoring team name belongs to. Names are
 * season-scoped, so a stats-recorded name may differ from the game header's
 * name; roster membership of the scorer breaks that tie. Returns null when
 * neither evidence points to a side, in which case no score advances.
 */
function scoreSide(
  payload: GamePayload,
  scoringTeam: string,
  scorer: RawPlayerRef | null,
): "home" | "away" | null {
  if (scoringTeam === payload.game.homeTeam) return "home";
  if (scoringTeam === payload.game.awayTeam) return "away";
  if (scorer !== null) {
    const key = scorer.trim().toLowerCase();
    if (payload.game.homeRoster.some((r) => r.trim().toLowerCase() === key)) {
      return "home";
    }
    if (payload.game.awayRoster.some((r) => r.trim().toLowerCase() === key)) {
      return "away";
    }
  }
  return null;
}

/**
 * Derive the score timeline and game story facts from a canonical payload.
 * Deterministic and pure: scores come only from recorded POINT events;
 * nothing is invented. Points without a POINT event, or with an
 * unattributable scoring team, advance no score and carry null team data.
 */
export function buildScoreTimelineAndStoryFacts(payload: GamePayload): {
  timeline: ScoreTimelineItem[];
  storyFacts: GameStoryFacts;
} {
  const timeline: ScoreTimelineItem[] = [];
  let home = 0;
  let away = 0;

  for (const point of payload.game.points) {
    const attr = attribution(payload, point);
    if (attr.scoringTeam !== null) {
      const side = scoreSide(payload, attr.scoringTeam, attr.scorer);
      if (side === "home") home += 1;
      else if (side === "away") away += 1;
    }
    timeline.push({
      pointNumber: point.pointNumber,
      scoringTeam: attr.scoringTeam,
      scorer: attr.scorer,
      holdOrBreak: attr.holdOrBreak,
      homeScore: home,
      awayScore: away,
    });
  }

  // Story facts from the attributed progression.
  const finalPoint = timeline.length > 0 ? timeline[timeline.length - 1] ?? null : null;

  // Leader tracking: null on ties. A lead change is a transition to a
  // different leader (never the first lead from an initial tie).
  const leadChanges: LeadItem[] = [];
  let leader: string | null = null;
  let largestLead: LeadItem | null = null;
  const margin = (item: ScoreTimelineItem): number => item.homeScore - item.awayScore;

  for (const item of timeline) {
    let nextLeader: string | null = null;
    if (item.homeScore > item.awayScore) nextLeader = payload.game.homeTeam;
    else if (item.awayScore > item.homeScore) nextLeader = payload.game.awayTeam;
    if (nextLeader !== null && nextLeader !== leader && leader !== null) {
      leadChanges.push({
        team: nextLeader,
        pointNumber: item.pointNumber,
        awayScore: item.awayScore,
        homeScore: item.homeScore,
      });
    }
    if (nextLeader !== null) leader = nextLeader;

    if (margin(item) !== 0) {
      const team = item.homeScore > item.awayScore ? payload.game.homeTeam : payload.game.awayTeam;
      if (
        largestLead === null ||
        Math.abs(margin(item)) > Math.abs(marginOf(largestLead)) ||
        // Tie-break to the earliest observed instance.
        (Math.abs(margin(item)) === Math.abs(marginOf(largestLead)) &&
          item.pointNumber < largestLead.pointNumber)
      ) {
        largestLead = {
          team,
          pointNumber: item.pointNumber,
          awayScore: item.awayScore,
          homeScore: item.homeScore,
        };
      }
    }
  }

  // Scoring runs over attributed consecutive points.
  const scoringRuns: ScoringRun[] = [];
  for (const item of timeline) {
    if (item.scoringTeam === null) continue;
    const run = scoringRuns[scoringRuns.length - 1];
    if (
      run !== undefined &&
      run.team === item.scoringTeam &&
      run.endPointNumber === item.pointNumber - 1
    ) {
      run.length += 1;
      run.endPointNumber = item.pointNumber;
    } else {
      scoringRuns.push({
        team: item.scoringTeam,
        length: 1,
        startPointNumber: item.pointNumber,
        endPointNumber: item.pointNumber,
      });
    }
  }

  const largestComeback = deriveLargestComeback(payload, timeline);

  return {
    timeline,
    storyFacts: {
      finalPoint,
      leadChanges,
      scoringRuns,
      largestLead,
      largestComeback,
    },
  };
}

function marginOf(item: LeadItem): number {
  return item.homeScore - item.awayScore;
}

/**
 * The eventual winner's comeback: the deepest deficit faced before first
 * reaching a positive margin after trailing. No comeback for a tie or a
 * wire-to-wire winner.
 */
function deriveLargestComeback(
  payload: GamePayload,
  timeline: readonly ScoreTimelineItem[],
): ComebackItem | null {
  if (timeline.length === 0) return null;
  const last = timeline[timeline.length - 1];
  if (last === undefined) return null;
  if (last.homeScore === last.awayScore) return null;
  const winningSide = last.homeScore > last.awayScore ? "home" : "away";

  let trailed = false;
  let deepest = 0;
  for (const item of timeline) {
    const diff = winningSide === "home" ? item.homeScore - item.awayScore : item.awayScore - item.homeScore;
    if (diff < 0) {
      trailed = true;
      deepest = Math.max(deepest, -diff);
    }
    if (trailed && diff > 0) {
      return {
        team: winningSide === "home" ? payload.game.homeTeam : payload.game.awayTeam,
        maxDeficit: deepest,
        comebackCompletedAt: item.pointNumber,
      };
    }
  }
  return null;
}

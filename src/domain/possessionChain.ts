import type { Event } from "./types.js";

/** Index of the first recorded POINT event; events.length when none exists. */
export function firstPointIndex(events: readonly Event[]): number {
  for (let i = 0; i < events.length; i += 1) {
    if (events[i]!.type === "POINT") return i;
  }
  return events.length;
}

/** The possession facts one point's event chain yields. */
export type PossessionChain = {
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
   * point's offence-line team and alternates at every possession boundary, so
   * an odd index means the scoring team held the disc when the point started
   * and an even index means it did not; 0 without a recorded POINT event.
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

/**
 * The point's possession chain, computed from its events alone. The chain is
 * anchored at both ends and alternates between them: the point's offence-line
 * team holds every odd-numbered possession and the other team every even one,
 * while the possession containing the POINT event is the one that scored.
 * Every turnover moment ends the possession and starts the next. A THROWAWAY
 * immediately followed by a DEFENSE is one moment (the throw and the block):
 * the possession changes once, to the blocking team, and the throwaway itself
 * does not change possession; a standalone THROWAWAY, a DROP, and an unpaired
 * DEFENSE each change possession once. Events past the first recorded POINT
 * belong to the recording tail and are ignored. Without a recorded POINT
 * event the chain still yields its possession and turnover counts, but
 * `scoringPossessionIndex`, the scoring possession's length, and the tail
 * passes are 0, because no possession scores. In a rare capture row the
 * recorded lines and the event stream disagree about who had the disc; the
 * counts are the event facts either way. The quality stage (see
 * `qualityReport`) compares the chain's parity against the line-based
 * hold/break label and warns on the points that disagree.
 */
export function possessionChain(events: readonly Event[]): PossessionChain {
  const pointIndex = firstPointIndex(events);
  let moments = 0;
  let segmentPasses = 0;
  // Possession 1 belongs to the point's offence line; every turnover moment
  // flips the holding team to the other team.
  for (let i = 0; i < pointIndex; i += 1) {
    const event = events[i]!;
    if (event.type === "PASS") {
      segmentPasses += 1;
    } else if (event.type === "THROWAWAY") {
      if (events[i + 1]?.type === "DEFENSE") {
        i += 1;
      }
      moments += 1;
      segmentPasses = 0;
    } else if (event.type === "DROP" || event.type === "DEFENSE") {
      moments += 1;
      segmentPasses = 0;
    }
  }
  const scored = pointIndex < events.length;
  return {
    possessionCount: moments + 1,
    scoringPossessionLength: scored ? segmentPasses : 0,
    scoringPossessionIndex: scored ? moments + 1 : 0,
    turnoversBeforeGoal: moments,
    passesAfterLastTurnover: scored && moments > 0 ? segmentPasses : 0,
  };
}

import { describe, expect, it } from "vitest";

import type {
  ApiEvent,
  ApiGame,
  ApiPoint,
  ApiStatLine,
  GamePayload,
  SupportedLeague,
} from "../src/domain/types.js";
import { canonicalizeGame } from "../src/data/normalize.js";
import { buildNarrative } from "../src/engine/narrative.js";
import { buildScoreTimelineAndStoryFacts } from "../src/engine/timeline.js";

import game1013 from "./fixtures/captures/game-1013.json";

const league24: SupportedLeague = {
  id: 24,
  name: "Winter Indoor Parity 2026",
  lineSize: 6,
  salaryCalc: "pro_rate",
};

/** A PULL event with a parseable timestamp. */
function pullEvent(): ApiEvent {
  return {
    type: "PULL",
    firstActor: null,
    secondActor: null,
    timestamp: "3/14/2026, 6:00:00 PM",
  };
}

/** Synthetic controlled game: one array of raw events per point. */
function makeGame(pointEvents: ApiEvent[][]): ApiGame {
  return {
    id: 9996,
    league_id: 24,
    status: "final",
    week: 1,
    homeTeam: "Team A (Alice)",
    awayTeam: "Team B (Bob)",
    homeRoster: [],
    awayRoster: [],
    homeScore: pointEvents.length,
    awayScore: 0,
    points: pointEvents.map((events) => ({
      offensePlayers: [],
      defensePlayers: [],
      events,
    })),
    stats: {},
  };
}

function canonical(pointEvents: ApiEvent[][]): GamePayload {
  return canonicalizeGame(makeGame(pointEvents), league24);
}

/** A PASS event recorded `sec` seconds after 3/14/2026, 6:00:00 PM. */
function passEvent(sec: number): ApiEvent {
  const date = new Date(2026, 2, 14, 18, 0, sec);
  const hour = date.getHours();
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  const period = hour < 12 ? "AM" : "PM";
  const pad = (n: number): string => String(n).padStart(2, "0");
  return {
    type: "PASS",
    firstActor: null,
    secondActor: null,
    timestamp: `3/14/2026, ${hour12}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${period}`,
  };
}

/** A PASS event whose timestamp cannot be parsed (timestampSec null). */
function unparseablePassEvent(): ApiEvent {
  return {
    type: "PASS",
    firstActor: null,
    secondActor: null,
    timestamp: "sometime in the first half",
  };
}

describe("buildNarrative half boundary", () => {
  it("derives the half boundary from exactly two PULL events", () => {
    // Points: P1 with PULL, P2 no PULL, P3 with PULL -> the second PULL marks
    // the start of the second half at point 3. Both pulls' offence lines are
    // home (the away pull received by home, then the home pull), so the
    // receivers resolve and agree.
    const payload = stretchPayload([
      pullReceivingPoint([HOME_PAT], [AWAY_BEA], [pointEvent(HOME_PAT)]),
      scoredPoint(HOME_PAT, true),
      pullReceivingPoint([HOME_PAT], [AWAY_BEA], [pointEvent(HOME_PAT)]),
    ]);
    const narrative = buildNarrative(payload);

    expect(narrative.halves?.secondHalfStartPoint).toBe(3);
  });

  it("yields null for 0, 1, or 3 PULL events", () => {
    // Three variants of the same 3-point game with PULL counts 0, 1, 3.
    for (const pointEvents of [
      [[], [], []],
      [[pullEvent()], [], []],
      [[pullEvent()], [pullEvent()], [pullEvent()]],
    ]) {
      const payload = canonical(pointEvents);
      const narrative = buildNarrative(payload);

      expect(narrative.halves).toBe(null);
    }
  });

  it("returns one PointNote per point with zero completions for empty events", () => {
    const payload = canonical([[], []]);
    const narrative = buildNarrative(payload);

    expect(narrative.pointNotes).toEqual([
      {
        pointNumber: 1,
        completions: 0,
        longestGapSec: null,
        terms: [],
        possessionCount: 1,
        scoringPossessionLength: 0,
        scoringPossessionIndex: 0,
        turnoversBeforeGoal: 0,
        passesAfterLastTurnover: 0,
      },
      {
        pointNumber: 2,
        completions: 0,
        longestGapSec: null,
        terms: [],
        possessionCount: 1,
        scoringPossessionLength: 0,
        scoringPossessionIndex: 0,
        turnoversBeforeGoal: 0,
        passesAfterLastTurnover: 0,
      },
    ]);
    expect(narrative.stretches).toEqual([]);
    expect(narrative.conversions).toEqual([
      {
        team: "Team A (Alice)",
        breakChances: 0,
        breakConversions: 0,
        longestHoldStreak: null,
        survivedHalfBoundary: false,
      },
      {
        team: "Team B (Bob)",
        breakChances: 0,
        breakConversions: 0,
        longestHoldStreak: null,
        survivedHalfBoundary: false,
      },
    ]);
    expect(narrative.halves).toBe(null);
  });
});

describe("buildPointNotes gap detection", () => {
  it("excludes the pull from the interruption gap", () => {
    // PULL at 0, PASS at 40, PASS at 45, POINT at 46: the pull starts the
    // point, it is not a stoppage, so its 40-second flight time is not play
    // time and the longest gap is the 5 seconds between the two passes.
    const payload = canonical([
      [pullEvent(), passEvent(40), passEvent(45), pointEventAt(46, SCORER)],
    ]);
    const narrative = buildNarrative(payload);

    expect(narrative.pointNotes[0]!.longestGapSec).toBe(5);
  });

  it("yields null gap for a point whose only events are pulls", () => {
    // A pull-only point has no play at all: nothing to measure between.
    const payload = canonical([[pullEvent()]]);
    const narrative = buildNarrative(payload);

    expect(narrative.pointNotes[0]!.longestGapSec).toBe(null);
  });

  it("measures the longest gap between consecutive events", () => {
    // Three PASS events at sec 0, 10, 60 -> gaps 10 and 50 -> longest 50.
    const payload = canonical([[passEvent(0), passEvent(10), passEvent(60)]]);
    const narrative = buildNarrative(payload);

    expect(narrative.pointNotes).toEqual([
      {
        pointNumber: 1,
        completions: 3,
        longestGapSec: 50,
        terms: [],
        possessionCount: 1,
        scoringPossessionLength: 0,
        scoringPossessionIndex: 0,
        turnoversBeforeGoal: 0,
        passesAfterLastTurnover: 0,
      },
    ]);
  });

  it("yields null when any event lacks timestampSec", () => {
    // PASS at sec 0, PASS at sec null -> the gap is unattributable.
    const payload = canonical([[passEvent(0), unparseablePassEvent()]]);
    const narrative = buildNarrative(payload);

    expect(narrative.pointNotes).toEqual([
      {
        pointNumber: 1,
        completions: 2,
        longestGapSec: null,
        terms: [],
        possessionCount: 1,
        scoringPossessionLength: 0,
        scoringPossessionIndex: 0,
        turnoversBeforeGoal: 0,
        passesAfterLastTurnover: 0,
      },
    ]);
  });
});

const SCORER = "Score Sally";
const DEFENCE = "Dana D";
const OtherO = "Other O";

/** A point with recorded lines (raw names) and raw events. */
function linedPoint(offense: string[], defense: string[], events: ApiEvent[]): ApiPoint {
  return { offensePlayers: offense, defensePlayers: defense, events };
}

function statLine(team: string | null): ApiStatLine {
  return {
    goals: 0,
    assists: 0,
    second_assists: 0,
    d_blocks: 0,
    completions: 0,
    throw_aways: 0,
    threw_drops: 0,
    catches: 0,
    drops: 0,
    pulls: 0,
    callahan: 0,
    o_points_for: 0,
    o_points_against: 0,
    d_points_for: 0,
    d_points_against: 0,
    points_played: 0,
    pay: 0,
    team,
  };
}

/** A named typed event (DEFENSE/POINT/...) with a parseable shared timestamp. */
function namedEvent(type: string, actor: string): ApiEvent {
  return {
    type,
    firstActor: actor,
    secondActor: null,
    timestamp: "3/14/2026, 6:00:00 PM",
  };
}

/** A POINT scored by `actor` `sec` seconds after the shared 6:00 PM base. */
function pointEventAt(sec: number, actor: string): ApiEvent {
  return { ...passEvent(sec), type: "POINT", firstActor: actor };
}

/** A DEFENSE block credited to `actor`. */
function defenseEvent(actor: string): ApiEvent {
  return namedEvent("DEFENSE", actor);
}

/** A POINT scored by `actor`. */
function pointEvent(actor: string): ApiEvent {
  return namedEvent("POINT", actor);
}

/** `count` short timed PASS events (second offsets stay under 60). */
function passes(count: number): ApiEvent[] {
  return Array.from({ length: count }, (_, index) => passEvent(index + 1));
}

describe("buildPointNotes term classification", () => {
  it("awards callahan on an own block scored without a completion", () => {
    const payload = canonical([[defenseEvent(SCORER), pointEvent(SCORER)]]);
    const narrative = buildNarrative(payload);

    expect(narrative.pointNotes[0]!.terms).toEqual(["callahan"]);
  });

  it("awards double-happiness on an own block converted via completions", () => {
    const payload = canonical([[defenseEvent(SCORER), ...passes(5), pointEvent(SCORER)]]);
    const narrative = buildNarrative(payload);

    expect(narrative.pointNotes[0]!.terms).toEqual(["double-happiness"]);
  });

  it("awards no term on another player's block", () => {
    const payload = canonical([[defenseEvent(DEFENCE), pointEvent(SCORER)]]);
    const narrative = buildNarrative(payload);

    expect(narrative.pointNotes[0]!.terms).toEqual([]);
  });

  it("awards no term to a recorded point without a POINT event (DROP chain)", () => {
    const payload = canonical([[...passes(1), namedEvent("DROP", SCORER)]]);
    const narrative = buildNarrative(payload);

    expect(narrative.pointNotes[0]!.terms).toEqual([]);
  });

  it("awards no term to a recorded point without a POINT event (passes only)", () => {
    const payload = canonical([[...passes(5)]]);
    const narrative = buildNarrative(payload);

    expect(narrative.pointNotes[0]!.terms).toEqual([]);
  });

  it("normalizes actor names before comparing the block to the scorer", () => {
    const payload = canonical([[defenseEvent("score sally "), pointEvent(SCORER)]]);
    const narrative = buildNarrative(payload);

    expect(narrative.pointNotes[0]!.terms).toEqual(["callahan"]);
  });
});

describe("buildPointNotes possession chain", () => {
  it("counts one possession per turnover and reports the scoring possession", () => {
    // PASS, THROWAWAY, DEFENSE (the throw and its block: one moment), PASS,
    // PASS, POINT. Possession 1 holds for one pass; possession 2 opens on the
    // block and scores after two passes.
    const payload = canonical([
      [
        passEvent(1),
        namedEvent("THROWAWAY", "Thrower T"),
        defenseEvent(DEFENCE),
        passEvent(2),
        passEvent(3),
        pointEvent(SCORER),
      ],
    ]);
    const n = buildNarrative(payload);

    expect(n.pointNotes[0]!.possessionCount).toBe(2);
    expect(n.pointNotes[0]!.scoringPossessionIndex).toBe(2);
    expect(n.pointNotes[0]!.scoringPossessionLength).toBe(2);
    expect(n.pointNotes[0]!.turnoversBeforeGoal).toBe(1);
    expect(n.pointNotes[0]!.passesAfterLastTurnover).toBe(2);
    expect(n.pointNotes[0]!.terms).toEqual([]);
  });

  it("counts a zero-pass possession when a team takes the disc and turns it over", () => {
    // THROWAWAY, THROWAWAY, POINT: two standalone turnovers, each followed by
    // another turnover moment, so the scoring possession holds zero passes.
    const payload = canonical([
      [
        namedEvent("THROWAWAY", "Thrower T"),
        namedEvent("THROWAWAY", "Other O"),
        pointEvent(SCORER),
      ],
    ]);
    const n = buildNarrative(payload);

    expect(n.pointNotes[0]!.possessionCount).toBe(3);
    expect(n.pointNotes[0]!.scoringPossessionIndex).toBe(3);
    expect(n.pointNotes[0]!.scoringPossessionLength).toBe(0);
    expect(n.pointNotes[0]!.turnoversBeforeGoal).toBe(2);
    expect(n.pointNotes[0]!.passesAfterLastTurnover).toBe(0);
  });

  it("reports possession one when the scoring team held from the start", () => {
    const payload = canonical([[...passes(3), pointEvent(SCORER)]]);
    const n = buildNarrative(payload);

    expect(n.pointNotes[0]!.possessionCount).toBe(1);
    expect(n.pointNotes[0]!.scoringPossessionIndex).toBe(1);
    expect(n.pointNotes[0]!.scoringPossessionLength).toBe(3);
    expect(n.pointNotes[0]!.turnoversBeforeGoal).toBe(0);
    expect(n.pointNotes[0]!.passesAfterLastTurnover).toBe(0);
  });

  it("no longer reports transition or clean-possession terms", () => {
    // A point with a turnover and a later goal earns no transition term, and
    // a patient no-turnover point earns no clean-possession term.
    const turnover = canonical([
      [passEvent(1), namedEvent("THROWAWAY", "Thrower T"), passEvent(2), pointEvent(SCORER)],
    ]);
    const turnoverNarrative = buildNarrative(turnover);

    expect(turnoverNarrative.pointNotes[0]!.terms).toEqual([]);

    const patient = canonical([[...passes(6), pointEvent(SCORER)]]);
    const patientNarrative = buildNarrative(patient);

    expect(patientNarrative.pointNotes[0]!.terms).toEqual([]);
  });

  it("keeps callahan and double happiness", () => {
    // Own DEFENSE + 0 PASSes -> callahan; own DEFENSE + 5 PASSes ->
    // double-happiness; the pass-count rules are unchanged.
    const callahan = canonical([[defenseEvent(SCORER), pointEvent(SCORER)]]);
    const narrative = buildNarrative(callahan);

    expect(narrative.pointNotes[0]!.terms).toEqual(["callahan"]);

    const double = canonical([[defenseEvent(SCORER), ...passes(5), pointEvent(SCORER)]]);
    const doubleNarrative = buildNarrative(double);

    expect(doubleNarrative.pointNotes[0]!.terms).toEqual(["double-happiness"]);
  });

  it("counts a throwaway immediately followed by a block as one possession change", () => {
    // THROWAWAY ("Thrower T", offence), DEFENSE ("Dana D", defence), PASS,
    // POINT: the throw and the block are one moment, so the possession
    // changes once, to the blocking team.
    const payload = canonical([
      [
        namedEvent("THROWAWAY", "Thrower T"),
        defenseEvent(DEFENCE),
        passEvent(1),
        pointEvent(SCORER),
      ],
    ]);
    const n = buildNarrative(payload);

    expect(n.pointNotes[0]!.possessionCount).toBe(2);
    expect(n.pointNotes[0]!.turnoversBeforeGoal).toBe(1);
    expect(n.pointNotes[0]!.scoringPossessionIndex).toBe(2);
    expect(n.pointNotes[0]!.scoringPossessionLength).toBe(1);
    expect(n.pointNotes[0]!.passesAfterLastTurnover).toBe(1);
  });

  it("counts a standalone throwaway as a possession change", () => {
    // THROWAWAY ("Thrower T", offence), then a PASS by "Other O", then POINT:
    // the throwaway is its own moment and the pick-up possession scores.
    const payload = canonical([
      [
        namedEvent("THROWAWAY", "Thrower T"),
        namedEvent("PASS", "Other O"),
        pointEvent(SCORER),
      ],
    ]);
    const n = buildNarrative(payload);

    expect(n.pointNotes[0]!.possessionCount).toBe(2);
    expect(n.pointNotes[0]!.turnoversBeforeGoal).toBe(1);
    expect(n.pointNotes[0]!.scoringPossessionIndex).toBe(2);
    expect(n.pointNotes[0]!.scoringPossessionLength).toBe(1);
    expect(n.pointNotes[0]!.passesAfterLastTurnover).toBe(1);
  });

  it("starts the chain from the offence line even when the point opens with a turnover", () => {
    // THROWAWAY by an offence-line player ("Thrower T"), then a PASS by a
    // defence-line player ("Dana D"), then POINT ("Other O"). The chain still
    // starts at possession 1 with the offence line, so the defence possession
    // that scores is possession 2.
    const payload = stretchPayload([
      linedPoint(
        ["Thrower T"],
        ["Dana D", OtherO],
        [
          namedEvent("THROWAWAY", "Thrower T"),
          namedEvent("PASS", "Dana D"),
          pointEvent(OtherO),
        ],
      ),
    ]);
    const n = buildNarrative(payload);

    expect(n.pointNotes[0]!.possessionCount).toBe(2);
    expect(n.pointNotes[0]!.scoringPossessionIndex).toBe(2);
    expect(n.pointNotes[0]!.scoringPossessionLength).toBe(1);
    expect(n.pointNotes[0]!.turnoversBeforeGoal).toBe(1);
    expect(n.pointNotes[0]!.passesAfterLastTurnover).toBe(1);
  });

  it("gives an odd scoring possession index when the scoring team held from the start", () => {
    // PASS (home), THROWAWAY home, THROWAWAY away, PASS (home), POINT home:
    // two turnover moments put the scoring possession at 3, so it is odd and
    // the chain claims the scoring team (the offence line) held from the
    // start, matching the timeline's HOLD.
    const payload = stretchPayload([
      linedPoint(
        [HOME_PAT],
        [AWAY_BEA],
        [
          namedEvent("PASS", HOME_PAT),
          namedEvent("THROWAWAY", HOME_PAT),
          namedEvent("THROWAWAY", AWAY_BEA),
          namedEvent("PASS", HOME_PAT),
          pointEvent(HOME_PAT),
        ],
      ),
    ]);
    const n = buildNarrative(payload);

    expect(n.pointNotes[0]!.possessionCount).toBe(3);
    expect(n.pointNotes[0]!.scoringPossessionIndex).toBe(3);
    expect(n.pointNotes[0]!.scoringPossessionLength).toBe(1);
    expect(n.pointNotes[0]!.turnoversBeforeGoal).toBe(2);
    expect(n.pointNotes[0]!.passesAfterLastTurnover).toBe(1);
    // The chain parity agrees with the line-based label: no disagreement.
    expect(
      payload.quality.warnings.filter((w) => w.code === "LINE_EVENT_DISAGREE"),
    ).toHaveLength(0);
  });

  it("gives an even scoring possession index when the scoring team did not hold from the start", () => {
    // THROWAWAY home, then the defence picks up and scores (a BREAK): the
    // scoring possession is 2, so it is even and the chain claims the scoring
    // team did not hold from the start, matching the timeline's BREAK.
    const payload = stretchPayload([
      linedPoint(
        [HOME_PAT],
        [AWAY_BEA],
        [
          namedEvent("THROWAWAY", HOME_PAT),
          namedEvent("PASS", AWAY_BEA),
          pointEvent(AWAY_BEA),
        ],
      ),
    ]);
    const n = buildNarrative(payload);

    expect(n.pointNotes[0]!.possessionCount).toBe(2);
    expect(n.pointNotes[0]!.scoringPossessionIndex).toBe(2);
    expect(n.pointNotes[0]!.scoringPossessionLength).toBe(1);
    expect(n.pointNotes[0]!.turnoversBeforeGoal).toBe(1);
    expect(n.pointNotes[0]!.passesAfterLastTurnover).toBe(1);
    // The chain parity agrees with the line-based label: no disagreement.
    expect(
      payload.quality.warnings.filter((w) => w.code === "LINE_EVENT_DISAGREE"),
    ).toHaveLength(0);
  });

  it("warns when the chain parity disagrees with the line-based hold or break", () => {
    // The lines name home as the offence line and the home scorer resolves to
    // home (a HOLD by the timeline), but the events put one turnover moment
    // before the goal: the chain makes the scoring possession 2 (even), which
    // says the scoring team did not hold the disc when the point started.
    // The quality report carries a warning naming the point and the team.
    const payload = stretchPayload([
      linedPoint(
        [HOME_PAT],
        [AWAY_BEA],
        [
          namedEvent("THROWAWAY", HOME_PAT),
          defenseEvent(AWAY_BEA),
          namedEvent("PASS", HOME_PAT),
          pointEvent(HOME_PAT),
        ],
      ),
    ]);

    const warnings = payload.quality.warnings.filter(
      (w) => w.code === "LINE_EVENT_DISAGREE",
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.pointNumber).toBe(1);
    expect(warnings[0]!.message).toContain("HOLD");
    expect(warnings[0]!.message).toContain(payload.game.homeTeam);
  });
});

const HOME_PAT = "Home Pat";
const AWAY_BEA = "Away Bea";

/** A scored point: the scorer's team on offence (hold) or defence (break). */
function scoredPoint(scorer: string, holds: boolean): ApiPoint {
  const other = scorer === HOME_PAT ? AWAY_BEA : HOME_PAT;
  return {
    offensePlayers: holds ? [scorer] : [other],
    defensePlayers: holds ? [other] : [scorer],
    events: [pointEvent(scorer)],
  };
}

/** A point whose scorer resolves to no team (absent stats team, mixed lines). */
function unattributedPoint(): ApiPoint {
  return {
    offensePlayers: ["Mystery May", AWAY_BEA],
    defensePlayers: ["Mystery May", HOME_PAT],
    events: [pointEvent("Mystery May")],
  };
}

function stretchPayload(points: ApiPoint[], stats: Record<string, ApiStatLine> = {}): GamePayload {
  return canonicalizeGame(
    {
      id: 9995,
      league_id: 24,
      status: "final",
      week: 1,
      homeTeam: "Team A (Alice)",
      awayTeam: "Team B (Bob)",
      homeRoster: [HOME_PAT],
      awayRoster: [AWAY_BEA],
      homeScore: points.length,
      awayScore: 0,
      points,
      stats,
    },
    league24,
  );
}

function payload1013(): GamePayload {
  return canonicalizeGame(game1013 as unknown as ApiGame, league24);
}

/** A lined point that opens with a PULL (the defence pulls, the offence receives). */
function pullReceivingPoint(offense: string[], defense: string[], events: ApiEvent[]): ApiPoint {
  return linedPoint(offense, defense, [pullEvent(), ...events]);
}

describe("buildNarrative halves", () => {
  it("reports the half receivers from the two pulls", () => {
    // P1: the away pull, received by home (home on the offence line); P3:
    // the home pull, received by away. Each pull's receiver is the team on
    // the offence line of its point, the puller is the defence of its point,
    // and the boundary is the second pull's point number.
    const payload = stretchPayload([
      pullReceivingPoint([HOME_PAT], [AWAY_BEA], [pointEvent(HOME_PAT)]),
      scoredPoint(AWAY_BEA, false),
      pullReceivingPoint([AWAY_BEA], [HOME_PAT], [pointEvent(AWAY_BEA)]),
    ]);
    const n = buildNarrative(payload);

    expect(n.halves).toEqual({
      secondHalfStartPoint: 3,
      firstHalfReceiver: payload.game.homeTeam,
      secondHalfReceiver: payload.game.awayTeam,
    });
  });

  it("yields null halves when the game does not show exactly two pulls", () => {
    const onePull = stretchPayload([
      pullReceivingPoint([HOME_PAT], [AWAY_BEA], [pointEvent(HOME_PAT)]),
      scoredPoint(HOME_PAT, false),
    ]);
    const threePulls = stretchPayload([
      pullReceivingPoint([HOME_PAT], [AWAY_BEA], [pointEvent(HOME_PAT)]),
      pullReceivingPoint([HOME_PAT], [AWAY_BEA], [pointEvent(HOME_PAT)]),
      pullReceivingPoint([HOME_PAT], [AWAY_BEA], [pointEvent(HOME_PAT)]),
    ]);

    expect(buildNarrative(onePull).halves).toBe(null);
    expect(buildNarrative(threePulls).halves).toBe(null);
  });

  it("yields null halves when a pull's offence line resolves to no team", () => {
    // The first pull's offence line is a name neither roster nor stats nor
    // any line-majority resolves; the receiver would be a guess.
    const payload = stretchPayload([
      pullReceivingPoint(["Mystery May"], [AWAY_BEA], [pointEvent(HOME_PAT)]),
      scoredPoint(HOME_PAT, false),
      pullReceivingPoint([HOME_PAT], [AWAY_BEA], [pointEvent(HOME_PAT)]),
    ]);

    expect(buildNarrative(payload).halves).toBe(null);
  });
});

/** Expanded point-number span of a stretch, inclusive. */
function spanPoints(stretch: { startPointNumber: number; endPointNumber: number }): number[] {
  const points: number[] = [];
  for (let p = stretch.startPointNumber; p <= stretch.endPointNumber; p += 1) {
    points.push(p);
  }
  return points;
}

describe("buildNarrative stretches", () => {
  it("partitions attributed scored points exactly once for fixture 1013", () => {
    const payload = payload1013();
    const n = buildNarrative(payload);
    const { timeline } = buildScoreTimelineAndStoryFacts(payload);
    const attributed = timeline.filter((t) => t.scoringTeam !== null).map((t) => t.pointNumber);

    expect(n.stretches.length).toBeGreaterThan(0);
    // Union of stretch spans (pointNumbers, in order) equals attributed exactly once.
    expect(n.stretches.flatMap(spanPoints)).toEqual(attributed);

    for (const stretch of n.stretches) {
      const slice = timeline.filter(
        (t) => t.pointNumber >= stretch.startPointNumber && t.pointNumber <= stretch.endPointNumber,
      );
      if (stretch.kind === "run") {
        expect(stretch.team).not.toBeNull();
        expect(
          slice.every((t) => t.scoringTeam !== null && t.scoringTeam === stretch.team),
        ).toBe(true);
      } else {
        expect(stretch.team).toBeNull();
      }
      // Scorer tallies cover exactly the slice's non-null scorers.
      const tally = new Map(stretch.scorers.map((s) => [s.name, s.goals]));
      expect([...tally.values()].reduce((sum, g) => sum + g, 0)).toBe(
        slice.filter((t) => t.scorer !== null).length,
      );
      for (const item of slice) {
        if (item.scorer !== null) {
          expect(tally.get(item.scorer)).toBeGreaterThan(0);
        }
      }
    }
  });

  it("classifies an all-hold alternation as on-serve with scorer tallies", () => {
    const payload = stretchPayload([
      scoredPoint(HOME_PAT, true),
      scoredPoint(AWAY_BEA, true),
      scoredPoint(HOME_PAT, true),
      scoredPoint(AWAY_BEA, true),
    ]);
    const n = buildNarrative(payload);

    expect(n.stretches).toEqual([
      {
        kind: "on-serve",
        startPointNumber: 1,
        endPointNumber: 4,
        team: null,
        half: null,
        scorers: [
          { name: "Home Pat", goals: 2 },
          { name: "Away Bea", goals: 2 },
        ],
      },
    ]);
  });

  it("classifies a hold-break alternation as trades", () => {
    const payload = stretchPayload([
      scoredPoint(HOME_PAT, true),
      scoredPoint(AWAY_BEA, false),
    ]);
    const n = buildNarrative(payload);

    expect(n.stretches).toEqual([
      {
        kind: "trades",
        startPointNumber: 1,
        endPointNumber: 2,
        team: null,
        half: null,
        scorers: [
          { name: "Home Pat", goals: 1 },
          { name: "Away Bea", goals: 1 },
        ],
      },
    ]);
  });

  it("classifies three points by one team as a run stretch carrying the team", () => {
    const payload = stretchPayload([
      scoredPoint(HOME_PAT, true),
      scoredPoint(HOME_PAT, false),
      scoredPoint(HOME_PAT, true),
    ]);
    const n = buildNarrative(payload);

    expect(n.stretches).toEqual([
      {
        kind: "run",
        startPointNumber: 1,
        endPointNumber: 3,
        team: payload.game.homeTeam,
        half: null,
        scorers: [{ name: "Home Pat", goals: 3 }],
      },
    ]);
  });

  it("greedy grouping only forms alternation blocks from length-1 contiguous runs", () => {
    // Runs: home(2), away(1), home(1). The length-2 run is never in a block;
    // the trailing two length-1 runs form an all-hold on-serve block.
    const payload = stretchPayload([
      scoredPoint(HOME_PAT, true),
      scoredPoint(HOME_PAT, true),
      scoredPoint(AWAY_BEA, true),
      scoredPoint(HOME_PAT, true),
    ]);
    const n = buildNarrative(payload);

    expect(n.stretches).toEqual([
      {
        kind: "run",
        startPointNumber: 1,
        endPointNumber: 2,
        team: payload.game.homeTeam,
        half: null,
        scorers: [{ name: "Home Pat", goals: 2 }],
      },
      {
        kind: "on-serve",
        startPointNumber: 3,
        endPointNumber: 4,
        team: null,
        half: null,
        scorers: [
          { name: "Away Bea", goals: 1 },
          { name: "Home Pat", goals: 1 },
        ],
      },
    ]);
  });

  it("excludes an unattributable point from stretches and keeps the partition", () => {
    const payload = stretchPayload(
      [scoredPoint(HOME_PAT, true), unattributedPoint(), scoredPoint(AWAY_BEA, true)],
      { "Mystery May": statLine("Unknown") },
    );
    const n = buildNarrative(payload);
    const { timeline } = buildScoreTimelineAndStoryFacts(payload);

    expect(timeline[1]!.scoringTeam).toBe(null);
    const attributed = timeline.filter((t) => t.scoringTeam !== null).map((t) => t.pointNumber);
    expect(n.stretches.flatMap(spanPoints)).toEqual(attributed);
    // The unattributed point 2 belongs to no stretch: two one-point run stretches.
    expect(n.stretches).toEqual([
      {
        kind: "run",
        startPointNumber: 1,
        endPointNumber: 1,
        team: payload.game.homeTeam,
        half: null,
        scorers: [{ name: "Home Pat", goals: 1 }],
      },
      {
        kind: "run",
        startPointNumber: 3,
        endPointNumber: 3,
        team: payload.game.awayTeam,
        half: null,
        scorers: [{ name: "Away Bea", goals: 1 }],
      },
    ]);
  });

  it("assigns half 1 before the boundary and half 2 from the boundary onward", () => {
    // PULLs at P1 and P3 put the boundary at P3; the home run P1-P2 is wholly
    // in half 1, the away run P3-P4 starts at the boundary and is half 2. The
    // offence line at both pull points is home (home received each pull, even
    // the away break at P3), so the receivers resolve and agree.
    const payload = stretchPayload([
      scoredPointWithPull(HOME_PAT, true),
      scoredPoint(HOME_PAT, false),
      scoredPointWithPull(AWAY_BEA, false),
      scoredPoint(AWAY_BEA, true),
    ]);
    const n = buildNarrative(payload);

    expect(n.halves?.secondHalfStartPoint).toBe(3);
    expect(
      n.stretches.map((s) => [s.startPointNumber, s.endPointNumber, s.half]),
    ).toEqual([
      [1, 2, 1],
      [3, 4, 2],
    ]);
  });

  it('assigns "spans" to a stretch that straddles the half boundary', () => {
    // One home run P1-P4 contains the boundary at P3; both pulls are received
    // by home (home on the offence line at both pull points).
    const payload = stretchPayload([
      scoredPointWithPull(HOME_PAT, true),
      scoredPoint(HOME_PAT, false),
      scoredPointWithPull(HOME_PAT, true),
      scoredPoint(HOME_PAT, false),
    ]);
    const n = buildNarrative(payload);

    expect(n.halves?.secondHalfStartPoint).toBe(3);
    expect(n.stretches).toHaveLength(1);
    expect(n.stretches[0]!.half).toBe("spans");
  });

  it("derives every stretch half from the boundary for fixture 1013 (null when no boundary)", () => {
    const n = buildNarrative(payload1013());

    if (n.halves === null) {
      expect(n.stretches.every((s) => s.half === null)).toBe(true);
    } else {
      for (const s of n.stretches) {
        const expected =
          s.endPointNumber < n.halves.secondHalfStartPoint
            ? 1
            : s.startPointNumber >= n.halves.secondHalfStartPoint
              ? 2
              : "spans";
        expect(s.half).toBe(expected);
      }
    }
  });
});

/** A scored point that also opens with a PULL event (for half boundaries). */
function scoredPointWithPull(scorer: string, holds: boolean): ApiPoint {
  const base = scoredPoint(scorer, holds);
  return { ...base, events: [pullEvent(), ...base.events] };
}

describe("buildNarrative conversions", () => {
  it("counts one break chance per point started on defence", () => {
    // P1 home hold, P2 away hold, P3 away break, P4 away hold:
    // home started on defence at P2 and P4 (chances 2, conversions 0);
    // away started on defence at P1 and P3 (chances 2, conversions 1).
    const payload = stretchPayload([
      scoredPoint(HOME_PAT, true),
      scoredPoint(AWAY_BEA, true),
      scoredPoint(AWAY_BEA, false),
      scoredPoint(AWAY_BEA, true),
    ]);
    const n = buildNarrative(payload);

    expect(n.conversions).toEqual([
      {
        team: payload.game.homeTeam,
        breakChances: 2,
        breakConversions: 0,
        longestHoldStreak: null,
        survivedHalfBoundary: false,
      },
      {
        team: payload.game.awayTeam,
        breakChances: 2,
        breakConversions: 1,
        // Away's own P3 break does not interrupt the P2-P4 unbroken run.
        longestHoldStreak: { length: 2, start: 2, end: 4 },
        survivedHalfBoundary: false,
      },
    ]);
  });

  it("never counts unattributed points", () => {
    // Same breakdown as above with an unresolvable scorer inserted: the
    // unattributed point contributes no chance and no conversion.
    const payload = stretchPayload(
      [
        scoredPoint(HOME_PAT, true),
        scoredPoint(AWAY_BEA, true),
        unattributedPoint(),
        scoredPoint(AWAY_BEA, false),
        scoredPoint(AWAY_BEA, true),
      ],
      { "Mystery May": statLine("Unknown") },
    );
    const n = buildNarrative(payload);

    expect(n.conversions).toEqual([
      {
        team: payload.game.homeTeam,
        breakChances: 2,
        breakConversions: 0,
        longestHoldStreak: null,
        survivedHalfBoundary: false,
      },
      {
        team: payload.game.awayTeam,
        breakChances: 2,
        breakConversions: 1,
        longestHoldStreak: null,
        survivedHalfBoundary: false,
      },
    ]);
  });

  it("finds the longest unbroken hold streak and the half boundary cross", () => {
    // Alternating holds P1-P8 (away on odd points, home on even), then a home
    // break at P9; PULLs at P1 and P5 put the half boundary at P5. Away's
    // holds do not interrupt home's unbroken run: home's offensive points
    // P2/P4/P6/P8 give start 2, end 8, length 4, crossing the boundary. Away
    // holds P1/P3/P5/P7 (start 1, end 7, length 4) and also crosses it; the
    // P9 home break comes after and does not shorten the recorded streak.
    const payload = stretchPayload([
      scoredPointWithPull(AWAY_BEA, true),
      scoredPoint(HOME_PAT, true),
      scoredPoint(AWAY_BEA, true),
      scoredPoint(HOME_PAT, true),
      scoredPointWithPull(AWAY_BEA, true),
      scoredPoint(HOME_PAT, true),
      scoredPoint(AWAY_BEA, true),
      scoredPoint(HOME_PAT, true),
      scoredPoint(HOME_PAT, false),
    ]);
    const n = buildNarrative(payload);

    expect(n.halves?.secondHalfStartPoint).toBe(5);
    expect(n.conversions).toEqual([
      {
        team: payload.game.homeTeam,
        breakChances: 5,
        breakConversions: 1,
        longestHoldStreak: { length: 4, start: 2, end: 8 },
        survivedHalfBoundary: true,
      },
      {
        team: payload.game.awayTeam,
        breakChances: 4,
        breakConversions: 0,
        longestHoldStreak: { length: 4, start: 1, end: 7 },
        survivedHalfBoundary: true,
      },
    ]);
  });

  it("lets an opponent break reset the unbroken streak mid-run", () => {
    // Home holds P2, away holds P3, home holds P4 (home length 2, P2-P4);
    // away breaks P5, which breaks home, so home's P6 hold starts afresh at 1
    // and the best stays P2-P4.
    const payload = stretchPayload([
      scoredPoint(AWAY_BEA, true),
      scoredPoint(HOME_PAT, true),
      scoredPoint(AWAY_BEA, true),
      scoredPoint(HOME_PAT, true),
      scoredPoint(AWAY_BEA, false),
      scoredPoint(HOME_PAT, true),
    ]);
    const n = buildNarrative(payload);

    expect(n.conversions[0]!.longestHoldStreak).toEqual({ length: 2, start: 2, end: 4 });
  });

  it("starts a fresh streak after an opponent break instead of continuing it", () => {
    // Home holds P2, away breaks P3 (resets), home holds P4, away holds P5,
    // home holds P6: the streak is P4-P6 (length 2), not P2-P6.
    const payload = stretchPayload([
      scoredPoint(AWAY_BEA, true),
      scoredPoint(HOME_PAT, true),
      scoredPoint(AWAY_BEA, false),
      scoredPoint(HOME_PAT, true),
      scoredPoint(AWAY_BEA, true),
      scoredPoint(HOME_PAT, true),
    ]);
    const n = buildNarrative(payload);

    expect(n.conversions[0]!.longestHoldStreak).toEqual({ length: 2, start: 4, end: 6 });
  });

  it("does not reset the streak on the team's own break", () => {
    // Home holds P2, away holds P3, home holds P4, away holds P5, home BREAKs
    // P6 (not an offensive point for home), home holds P7: start 2, end 7,
    // length 3.
    const payload = stretchPayload([
      scoredPoint(AWAY_BEA, true),
      scoredPoint(HOME_PAT, true),
      scoredPoint(AWAY_BEA, true),
      scoredPoint(HOME_PAT, true),
      scoredPoint(AWAY_BEA, true),
      scoredPoint(HOME_PAT, false),
      scoredPoint(HOME_PAT, true),
    ]);
    const n = buildNarrative(payload);

    expect(n.conversions[0]!.longestHoldStreak).toEqual({ length: 3, start: 2, end: 7 });
  });

  it("resets the streak on an unattributed point", () => {
    // Home holds P2 and P4 around an unattributed P3: the run is cut, so
    // neither side of it reaches 2.
    const payload = stretchPayload(
      [
        scoredPoint(AWAY_BEA, true),
        scoredPoint(HOME_PAT, true),
        unattributedPoint(),
        scoredPoint(HOME_PAT, true),
      ],
      { "Mystery May": statLine("Unknown") },
    );
    const n = buildNarrative(payload);

    expect(n.conversions[0]!.longestHoldStreak).toBe(null);
  });

  it("yields no streak under 2 even with a valid half boundary", () => {
    // Home holds only P2; the boundary at P3 never applies to a null streak.
    const pullOnlyPoint = (side: string[]): ApiPoint => ({
      offensePlayers: side,
      defensePlayers: side,
      events: [pullEvent()],
    });
    const payload = stretchPayload([
      pullOnlyPoint([HOME_PAT]),
      scoredPoint(HOME_PAT, true),
      pullOnlyPoint([HOME_PAT]),
    ]);
    const n = buildNarrative(payload);

    expect(n.halves?.secondHalfStartPoint).toBe(3);
    expect(n.conversions).toEqual([
      {
        team: payload.game.homeTeam,
        breakChances: 0,
        breakConversions: 0,
        longestHoldStreak: null,
        survivedHalfBoundary: false,
      },
      {
        team: payload.game.awayTeam,
        breakChances: 1,
        breakConversions: 0,
        longestHoldStreak: null,
        survivedHalfBoundary: false,
      },
    ]);
  });
});

describe("buildNarrative universe point", () => {
  it("is true when the game entered the final point tied", () => {
    // Scores 1-0, 1-1, 2-1: the game stood 1-1 entering the final point.
    const payload = stretchPayload([
      scoredPoint(HOME_PAT, true),
      scoredPoint(AWAY_BEA, true),
      scoredPoint(HOME_PAT, true),
    ]);

    expect(buildNarrative(payload).universePoint).toBe(true);
  });

  it("is false when a two-point game ends tied (entered the final point at 1-0)", () => {
    // P1 home hold (1-0), P2 away hold (1-1): the score entering P2 was 1-0.
    const payload = stretchPayload([
      scoredPoint(HOME_PAT, true),
      scoredPoint(AWAY_BEA, true),
    ]);

    expect(buildNarrative(payload).universePoint).toBe(false);
  });

  it("is false when the game was not tied entering the final point", () => {
    // Scores 1-0, 2-0, 2-1: entering the final point the game stood 2-0.
    const payload = stretchPayload([
      scoredPoint(HOME_PAT, true),
      scoredPoint(HOME_PAT, false),
      scoredPoint(AWAY_BEA, true),
    ]);

    expect(buildNarrative(payload).universePoint).toBe(false);
  });

  it("is false with fewer than two attributed points", () => {
    const payload = stretchPayload([scoredPoint(HOME_PAT, true)]);

    expect(buildNarrative(payload).universePoint).toBe(false);
  });
});

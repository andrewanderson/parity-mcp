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
    // the start of the second half at point 3.
    const payload = canonical([[], [], []].map((events, index) =>
      index === 0 || index === 2 ? [pullEvent()] : events,
    ));
    const narrative = buildNarrative(payload);

    expect(narrative.secondHalfStartPoint).toBe(3);
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

      expect(narrative.secondHalfStartPoint).toBe(null);
    }
  });

  it("returns one PointNote per point with zero completions for empty events", () => {
    const payload = canonical([[], []]);
    const narrative = buildNarrative(payload);

    expect(narrative.pointNotes).toEqual([
      { pointNumber: 1, completions: 0, longestGapSec: null, terms: [] },
      { pointNumber: 2, completions: 0, longestGapSec: null, terms: [] },
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
    expect(narrative.secondHalfStartPoint).toBe(null);
  });
});

describe("buildPointNotes gap detection", () => {
  it("measures the longest gap between consecutive events", () => {
    // Three PASS events at sec 0, 10, 60 -> gaps 10 and 50 -> longest 50.
    const payload = canonical([[passEvent(0), passEvent(10), passEvent(60)]]);
    const narrative = buildNarrative(payload);

    expect(narrative.pointNotes).toEqual([
      { pointNumber: 1, completions: 3, longestGapSec: 50, terms: [] },
    ]);
  });

  it("yields null when any event lacks timestampSec", () => {
    // PASS at sec 0, PASS at sec null -> the gap is unattributable.
    const payload = canonical([[passEvent(0), unparseablePassEvent()]]);
    const narrative = buildNarrative(payload);

    expect(narrative.pointNotes).toEqual([
      { pointNumber: 1, completions: 2, longestGapSec: null, terms: [] },
    ]);
  });
});

const SCORER = "Score Sally";
const DEFENCE = "Dana D";

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

  it("awards transition on a block by a scoring-team player who did not score", () => {
    const payload = canonical([[defenseEvent(DEFENCE), ...passes(3), pointEvent(SCORER)]]);
    const narrative = buildNarrative(payload);

    expect(narrative.pointNotes[0]!.terms).toEqual(["transition"]);
  });

  it("awards clean-possession with no turnover events and eight completions", () => {
    const payload = canonical([[...passes(8), pointEvent(SCORER)]]);
    const narrative = buildNarrative(payload);

    expect(narrative.pointNotes[0]!.terms).toEqual(["clean-possession"]);
  });

  it("awards no term below the five-completion floor", () => {
    const payload = canonical([[...passes(3), pointEvent(SCORER)]]);
    const narrative = buildNarrative(payload);

    expect(narrative.pointNotes[0]!.terms).toEqual([]);
  });

  it("awards only transition on another player's block (never callahan or double-happiness)", () => {
    const payload = canonical([[defenseEvent(DEFENCE), pointEvent(SCORER)]]);
    const narrative = buildNarrative(payload);

    expect(narrative.pointNotes[0]!.terms).toEqual(["transition"]);
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
        scorers: [{ name: "Home Pat", goals: 2 }],
      },
      {
        kind: "on-serve",
        startPointNumber: 3,
        endPointNumber: 4,
        team: null,
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
        scorers: [{ name: "Home Pat", goals: 1 }],
      },
      {
        kind: "run",
        startPointNumber: 3,
        endPointNumber: 3,
        team: payload.game.awayTeam,
        scorers: [{ name: "Away Bea", goals: 1 }],
      },
    ]);
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
        longestHoldStreak: null,
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

  it("finds the longest hold streak and the half boundary cross", () => {
    // Away hold P1, home holds P2-P7, away break P8; PULLs at P1 and P5 put
    // the half boundary at P5. Home's streak spans P2-P7 (length 6) and
    // crosses it; away's best is the single P1 hold (under 2 -> null).
    const payload = stretchPayload([
      scoredPointWithPull(AWAY_BEA, true),
      scoredPoint(HOME_PAT, true),
      scoredPoint(HOME_PAT, true),
      scoredPoint(HOME_PAT, true),
      scoredPointWithPull(HOME_PAT, true),
      scoredPoint(HOME_PAT, true),
      scoredPoint(HOME_PAT, true),
      scoredPoint(AWAY_BEA, false),
    ]);
    const n = buildNarrative(payload);

    expect(n.secondHalfStartPoint).toBe(5);
    expect(n.conversions).toEqual([
      {
        team: payload.game.homeTeam,
        breakChances: 1,
        breakConversions: 0,
        longestHoldStreak: { length: 6, start: 2, end: 7 },
        survivedHalfBoundary: true,
      },
      {
        team: payload.game.awayTeam,
        breakChances: 7,
        breakConversions: 1,
        longestHoldStreak: null,
        survivedHalfBoundary: false,
      },
    ]);
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

    expect(n.secondHalfStartPoint).toBe(3);
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

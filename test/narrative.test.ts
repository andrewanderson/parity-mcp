import { describe, expect, it } from "vitest";

import type { ApiEvent, ApiGame, GamePayload, SupportedLeague } from "../src/domain/types.js";
import { canonicalizeGame } from "../src/data/normalize.js";
import { buildNarrative } from "../src/engine/narrative.js";

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
    expect(narrative.conversions).toEqual([]);
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

  it("normalizes actor names before comparing the block to the scorer", () => {
    const payload = canonical([[defenseEvent("score sally "), pointEvent(SCORER)]]);
    const narrative = buildNarrative(payload);

    expect(narrative.pointNotes[0]!.terms).toEqual(["callahan"]);
  });
});

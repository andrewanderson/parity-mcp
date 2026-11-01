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

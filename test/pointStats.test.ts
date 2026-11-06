import { describe, expect, it } from "vitest";
import { canonicalizeGame, normalizePlayerRef } from "../src/data/normalize.js";
import { buildPointStats } from "../src/engine/pointStats.js";
import type { PointStatsPayload } from "../src/engine/pointStats.js";
import type {
  ApiGame,
  Event,
  EventType,
  GamePayload,
  Point,
  RawPlayerRef,
  SupportedLeague,
} from "../src/domain/types.js";
import game1000 from "./fixtures/captures/game-1000.json";
import game1001 from "./fixtures/captures/game-1001.json";
import game1002 from "./fixtures/captures/game-1002.json";
import game1008 from "./fixtures/captures/game-1008.json";
import game1013 from "./fixtures/captures/game-1013.json";

const LEAGUE: SupportedLeague = {
  id: 24,
  name: "Winter Indoor Parity 2026",
  statValues: "v2",
  lineSize: 6,
  salaryCalc: "pro_rate",
};

// All five captured game fixtures, table-driven like the server test's
// direct JSON imports.
const FIXTURES: Array<{ id: number; game: ApiGame }> = [
  { id: 1000, game: game1000 as unknown as ApiGame },
  { id: 1001, game: game1001 as unknown as ApiGame },
  { id: 1002, game: game1002 as unknown as ApiGame },
  { id: 1008, game: game1008 as unknown as ApiGame },
  { id: 1013, game: game1013 as unknown as ApiGame },
];

for (const { id, game } of FIXTURES) {
  const payload = canonicalizeGame(game, LEAGUE);
  describe(`buildPointStats: fixture game ${id}`, () => {
    it("reconciles exactly against the API game-level stats for all ten dimensions", () => {
      const result = buildPointStats(payload);
      expect(result.warnings).toEqual([]);
      for (const stat of payload.stats) {
        const total = result.totals.find(
          (entry) => entry.name.toLowerCase() === stat.name.toLowerCase(),
        );
        expect(total, `missing totals for ${stat.name}`).toBeDefined();
        expect(total?.counts.goals).toBe(stat.goals);
        expect(total?.counts.assists).toBe(stat.assists);
        expect(total?.counts.second_assists).toBe(stat.secondAssists);
        expect(total?.counts.d_blocks).toBe(stat.dBlocks);
        expect(total?.counts.completions).toBe(stat.completions);
        expect(total?.counts.catches).toBe(stat.catches);
        expect(total?.counts.drops).toBe(stat.drops);
        expect(total?.counts.throw_aways).toBe(stat.throwAways);
        expect(total?.counts.threw_drops).toBe(stat.threwDrops);
        expect(total?.counts.pulls).toBe(stat.pulls);
      }
    });
  });
}

function makeEvent(
  type: EventType,
  firstActor: RawPlayerRef | null,
  secondActor: RawPlayerRef | null,
): Event {
  return {
    type,
    firstActor,
    secondActor,
    timestamp: "3/15/2026, 6:13:40 PM",
    timestampLocal: "3/15/2026, 6:13:40 PM",
    timestampSec: 1773612820,
  };
}

function makePoint(
  pointNumber: number,
  offense: RawPlayerRef[],
  defense: RawPlayerRef[],
  events: Event[],
): Point {
  return {
    pointNumber,
    offensePlayers: offense.map(normalizePlayerRef),
    defensePlayers: defense.map(normalizePlayerRef),
    durationSec: null,
    events,
  };
}

function makePayload(points: Point[]): GamePayload {
  return {
    schemaVersion: 1,
    league: LEAGUE,
    game: {
      id: 1,
      week: 1,
      status: "final",
      date: null,
      homeTeam: "Home Team",
      awayTeam: "Away Team",
      homeScore: 0,
      awayScore: 0,
      homeRoster: [],
      awayRoster: [],
      points,
    },
    stats: [],
    quality: { warnings: [] },
  };
}

function playerOf(
  result: PointStatsPayload,
  pointNumber: number,
  name: string,
) {
  const point = result.points.find((p) => p.pointNumber === pointNumber);
  expect(point, `missing point ${pointNumber}`).toBeDefined();
  const player = point?.players.find(
    (p) => p.name.toLowerCase() === name.toLowerCase(),
  );
  expect(player, `missing player ${name} on point ${pointNumber}`).toBeDefined();
  return player as NonNullable<typeof player>;
}

function warningCodes(result: PointStatsPayload): string[] {
  return result.warnings.map((warning) => warning.code);
}

describe("buildPointStats: synthetic points", () => {
  it("a PASS followed by a DROP by the receiver awards threw_drop and drop, not completion or catch", () => {
    const result = buildPointStats(
      makePayload([
        makePoint(1, ["Ann"], ["Bea"], [
          makeEvent("PASS", "Ann", "Bea"),
          makeEvent("DROP", "Bea", null),
        ]),
      ]),
    );
    const ann = playerOf(result, 1, "Ann");
    const bea = playerOf(result, 1, "Bea");
    expect(ann.counts.threw_drops).toBe(1);
    expect(bea.counts.drops).toBe(1);
    expect(ann.counts.completions).toBe(0);
    expect(bea.counts.catches).toBe(0);
    expect(result.warnings).toEqual([]);
  });

  it("a PASS with a null thrower followed by a DROP by the receiver awards nothing and warns on both events", () => {
    // The PASS has no thrower, so it awards nothing. The DROP cannot pair:
    // its only candidate thrower is null, so the dropper gets no drops and
    // the drop is reported unmatched. The pairing condition is the salary
    // engine's four-part condition, copied deliberately so the two engines
    // cannot drift.
    const result = buildPointStats(
      makePayload([
        makePoint(1, ["Ann"], ["Bea"], [
          makeEvent("PASS", null, "Bea"),
          makeEvent("DROP", "Bea", null),
        ]),
      ]),
    );
    const ann = playerOf(result, 1, "Ann");
    const bea = playerOf(result, 1, "Bea");
    expect(ann.counts.completions).toBe(0);
    expect(bea.counts.catches).toBe(0);
    expect(bea.counts.drops).toBe(0);
    expect(ann.counts.threw_drops).toBe(0);
    expect(warningCodes(result)).toContain("POINT_STATS_MISSING_EVENT_ACTOR");
    expect(warningCodes(result)).toContain("UNMATCHED_DROP");
  });

  it("a D-line player who scores because possession flipped still gets the goal", () => {
    const result = buildPointStats(
      makePayload([
        makePoint(1, ["Ann"], ["Bea"], [makeEvent("POINT", "Bea", null)]),
      ]),
    );
    expect(playerOf(result, 1, "Bea").counts.goals).toBe(1);
    expect(playerOf(result, 1, "Ann").counts.goals).toBe(0);
    expect(result.warnings).toEqual([]);
  });

  it("a player recorded on both lines of one point appears exactly once, taking the offense recording", () => {
    const result = buildPointStats(
      makePayload([
        makePoint(1, ["Ann", "Bea"], ["bea (S)", "Cic"], [
          makeEvent("PULL", "Ann", null),
        ]),
      ]),
    );
    const entries = result.points[0]!.players.filter(
      (p) => p.name.toLowerCase() === "bea",
    );
    expect(entries).toHaveLength(1);
    // Offense row registers first: its spelling and substitute status win
    // over the defense row's "bea (S)" recording.
    expect(entries[0]!.name).toBe("Bea");
    expect(entries[0]!.isSubstitute).toBe(false);
    expect(entries[0]!.counts.pulls).toBe(0);
    expect(result.warnings).toEqual([]);
  });

  it("a line player with no events gets a zero-count entry", () => {
    const result = buildPointStats(
      makePayload([makePoint(1, ["Ann"], ["Bea"], [])]),
    );
    expect(playerOf(result, 1, "Ann").counts).toEqual({
      goals: 0,
      assists: 0,
      second_assists: 0,
      d_blocks: 0,
      completions: 0,
      catches: 0,
      drops: 0,
      throw_aways: 0,
      threw_drops: 0,
      pulls: 0,
    });
    expect(playerOf(result, 1, "Bea").touches).toBe(0);
  });

  it("a POINT with a null firstActor awards no goal and warns POINT_STATS_MISSING_EVENT_ACTOR", () => {
    const result = buildPointStats(
      makePayload([
        makePoint(1, ["Ann"], ["Bea"], [makeEvent("POINT", null, null)]),
      ]),
    );
    expect(playerOf(result, 1, "Ann").counts.goals).toBe(0);
    expect(playerOf(result, 1, "Bea").counts.goals).toBe(0);
    expect(warningCodes(result)).toContain("POINT_STATS_MISSING_EVENT_ACTOR");
  });

  it("an unmatched DROP awards nothing and warns UNMATCHED_DROP", () => {
    const result = buildPointStats(
      makePayload([
        makePoint(1, ["Ann"], ["Bea"], [makeEvent("DROP", "Bea", null)]),
      ]),
    );
    expect(warningCodes(result)).toContain("UNMATCHED_DROP");
    expect(playerOf(result, 1, "Bea").counts.drops).toBe(0);
    expect(playerOf(result, 1, "Ann").counts.threw_drops).toBe(0);
  });

  it("a PASS with a null secondActor awards no completion or catch and does not throw", () => {
    const result = buildPointStats(
      makePayload([
        makePoint(1, ["Ann"], ["Bea"], [makeEvent("PASS", "Ann", null)]),
      ]),
    );
    expect(playerOf(result, 1, "Ann").counts.completions).toBe(0);
    expect(playerOf(result, 1, "Bea").counts.catches).toBe(0);
    expect(warningCodes(result)).toContain("POINT_STATS_MISSING_EVENT_ACTOR");
  });

  it("touches count every actor event, counting both actors and PULL", () => {
    const result = buildPointStats(
      makePayload([
        makePoint(1, ["Ann"], ["Bea"], [
          makeEvent("PULL", "Bea", null),
          makeEvent("PASS", "Ann", "Bea"),
          makeEvent("PASS", "Bea", "Ann"),
          makeEvent("POINT", "Ann", null),
        ]),
      ]),
    );
    expect(playerOf(result, 1, "Ann").touches).toBe(3);
    expect(playerOf(result, 1, "Bea").touches).toBe(3);
  });
});

import { describe, expect, it } from "vitest";
import fs from "node:fs";
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

const LEAGUE: SupportedLeague = {
  id: 24,
  name: "Winter Indoor Parity 2026",
  statValues: "v2",
  lineSize: 6,
  salaryCalc: "pro_rate",
};

const raw = JSON.parse(
  fs.readFileSync("./test/fixtures/captures/game-1000.json", "utf8"),
) as ApiGame;
const payload = canonicalizeGame(raw, LEAGUE);

describe("buildPointStats", () => {
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

  it("a player recorded on both lines of one point appears exactly once", () => {
    const result = buildPointStats(
      makePayload([
        makePoint(1, ["Ann", "Bea"], ["Bea", "Cic"], [
          makeEvent("PULL", "Ann", null),
        ]),
      ]),
    );
    const entries = result.points[0]!.players.filter(
      (p) => p.name.toLowerCase() === "bea",
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.counts.pulls).toBe(0);
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

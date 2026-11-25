import { describe, expect, it } from "vitest";
import { buildPlayerContext, type PriorGames } from "../src/engine/playerContext.js";
import type { GamePayload, PlayerStatLine, SupportedLeague } from "../src/domain/types.js";

const LEAGUE: SupportedLeague = {
  id: 24,
  name: "Winter Indoor Parity 2026",
  statValues: "v2",
  lineSize: 6,
  salaryCalc: "pro_rate",
};

function makePayload(
  week: number,
  home: string[],
  away: string[],
  stats: PlayerStatLine[] = [],
  homeTeam = "Swing Break (Des)",
  awayTeam = "Canada Geese (Jer)",
): GamePayload {
  return {
    schemaVersion: 1,
    league: LEAGUE,
    game: {
      id: 2001,
      week,
      status: "final",
      date: null,
      homeTeam,
      awayTeam,
      homeScore: 5,
      awayScore: 3,
      homeRoster: home,
      awayRoster: away,
      points: [],
    },
    stats,
    quality: { warnings: [] },
  };
}

function statLine(
  name: string,
  overrides: Partial<PlayerStatLine> = {},
): PlayerStatLine {
  return {
    raw: name,
    name,
    isSubstitute: name.trim().endsWith("(S)"),
    goals: 0,
    assists: 0,
    secondAssists: 0,
    dBlocks: 0,
    completions: 0,
    throwAways: 0,
    threwDrops: 0,
    catches: 0,
    drops: 0,
    pulls: 0,
    callahan: 0,
    oPointsFor: 0,
    oPointsAgainst: 0,
    dPointsFor: 0,
    dPointsAgainst: 0,
    pointsPlayed: 0,
    pay: 0,
    team: null,
    ...overrides,
  };
}

const noPrior: PriorGames = { available: true, rows: [] };

describe("buildPlayerContext: substitutes and block skeleton", () => {
  it("lists substitutes with resolved teams", () => {
    const payload = makePayload(2, ["Nick Theriault"], ["Justin Ye"], [
      statLine("Nadine Cann(S)", { name: "Nadine Cann", team: "Swing Break (Des)" }),
      statLine("Justin Ye", { name: "Justin Ye", team: "Canada Geese (Jer)" }),
    ]);
    const context = buildPlayerContext(payload, noPrior);
    expect(context.substitutes).toEqual([
      { player: "Nadine Cann", team: "Swing Break (Des)" },
    ]);
    expect(context.transitions).toEqual([]);
  });

  it("reports a substitute with an unresolved team as null", () => {
    const payload = makePayload(2, ["Nick Theriault"], ["Justin Ye"], [
      statLine("Sam Lanesmith(S)", { name: "Sam Lanesmith", team: null }),
    ]);
    const context = buildPlayerContext(payload, noPrior);
    expect(context.substitutes).toEqual([
      { player: "Sam Lanesmith", team: null },
    ]);
  });

  it("returns a first-week note and no transitions on week 1", () => {
    const payload = makePayload(1, ["Nick Theriault"], ["Justin Ye"]);
    const context = buildPlayerContext(payload, { available: true, rows: [] });
    expect(context.priorDataAvailable).toBe(true);
    expect(context.transitions).toEqual([]);
    expect(context.note).toBe(
      "First week of the season: no earlier-week games.",
    );
  });

  it("returns a degraded block when prior data is unavailable", () => {
    const payload = makePayload(2, ["Nick Theriault"], ["Justin Ye"]);
    const context = buildPlayerContext(payload, {
      available: false,
      reason: "list failed",
    });
    expect(context.priorDataAvailable).toBe(false);
    expect(context.transitions).toEqual([]);
    expect(context.note).toBe(
      "Earlier-week data was unavailable (list failed); roster transitions were not computed.",
    );
  });
});

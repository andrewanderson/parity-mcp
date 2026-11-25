import { describe, expect, it } from "vitest";
import { gameForLeague } from "../src/server.js";
import { SourceError, type DataSource, type ListGamesOptions } from "../src/data/source.js";
import type { GamePayload, PriorGameRow, SupportedLeague } from "../src/domain/types.js";

const LEAGUE: SupportedLeague = {
  id: 24,
  name: "Winter Indoor Parity 2026",
  statValues: "v2",
  lineSize: 6,
  salaryCalc: "pro_rate",
};

function canonicalPayload(): GamePayload {
  return {
    schemaVersion: 1,
    league: LEAGUE,
    game: {
      id: 2001,
      week: 3,
      status: "final",
      date: null,
      homeTeam: "Swing Break (Des)",
      awayTeam: "Canada Geese (Jer)",
      homeScore: 5,
      awayScore: 3,
      homeRoster: ["Nick Theriault"],
      awayRoster: ["Justin Ye"],
      points: [],
    },
    stats: [],
    quality: { warnings: [] },
  };
}

const PRIOR_ROWS: PriorGameRow[] = [
  { id: 2000, week: 1, status: "final", homeTeam: "Team Des (Des)", awayTeam: "Canada Geese (Jer)", homeRoster: ["Nick Theriault"], awayRoster: ["Justin Ye"] },
  { id: 2001, week: 2, status: "final", homeTeam: "Team Des (Des)", awayTeam: "Canada Geese (Jer)", homeRoster: ["Nick Theriault"], awayRoster: ["Justin Ye"] },
];

function stubSource(listGames: () => Promise<unknown>): DataSource {
  return {
    listSupportedLeagues: async () => [LEAGUE],
    listGames: listGames as (
      league: Parameters<DataSource["listGames"]>[0],
      options?: ListGamesOptions,
    ) => Promise<never>,
    getGame: async () => canonicalPayload(),
    getTeamRoster: async () => [],
  };
}

describe("gameForLeague: player context plumbing", () => {
  it("attaches the player context to the full payload", async () => {
    const source = stubSource(() => Promise.resolve(PRIOR_ROWS));
    const { payload } = await gameForLeague(source, { id: 24 }, 2001);
    expect(payload.playerContext.priorDataAvailable).toBe(true);
    expect(payload.playerContext.transitions).toEqual([]);
    expect(payload.playerContext.note).toBeNull();
  });

  it("degrades the block when listGames fails", async () => {
    const source = stubSource(() =>
      Promise.reject(new SourceError("REQUEST_FAILED", "boom")),
    );
    const { payload } = await gameForLeague(source, { id: 24 }, 2001);
    expect(payload.playerContext.priorDataAvailable).toBe(false);
    expect(
      payload.playerContext.note?.startsWith("Earlier-week data was unavailable"),
    ).toBe(true);
  });
});

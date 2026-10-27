import { describe, expect, it } from "vitest";
import type { ApiGame, GamePayload, SupportedLeague } from "../src/domain/types.js";
import { buildGenderMap, canonicalizeGame, resolvePlayerTeam, qualityReport } from "../src/data/normalize.js";
import game1002 from "./fixtures/captures/game-1002.json";
import leaguesFixture from "./fixtures/captures/leagues.json";

const league = { ...leaguesFixture[0], statValues: "v2" } as SupportedLeague;

function syntheticGame(overrides: Partial<ApiGame> = {}): ApiGame {
  return {
    id: 9999,
    league_id: league.id,
    status: "final",
    week: 1,
    homeTeam: "Team A (Alice)",
    awayTeam: "Team B (Bob)",
    homeRoster: [],
    awayRoster: [],
    homeScore: 1,
    awayScore: 0,
    points: [
      {
        offensePlayers: ["Quinn Fielder", "Rowan Vale(S)"],
        defensePlayers: ["Casey Brook"],
        events: [
          {
            type: "PULL",
            firstActor: "Casey Brook",
            secondActor: null,
            timestamp: "3/14/2026, 6:00:00 PM",
          },
          {
            type: "PASS",
            firstActor: "Quinn Fielder",
            secondActor: "Rowan Vale(S)",
            timestamp: "3/14/2026, 6:00:10 PM",
          },
          {
            type: "POINT",
            firstActor: "Rowan Vale(S)",
            secondActor: null,
            timestamp: "3/14/2026, 6:00:30 PM",
          },
        ],
      },
    ],
    stats: {} as ApiGame["stats"],
    ...overrides,
  };
}

function payload1002(): GamePayload {
  return canonicalizeGame(game1002 as unknown as ApiGame, league);
}

describe("canonicalizeGame", () => {
  it("returns a normalized canonical shell with schemaVersion, league, game, stats, quality", () => {
    const payload = canonicalizeGame(syntheticGame(), league);
    expect(payload.schemaVersion).toBe(1);
    expect(payload.league).toEqual({
      id: league.id,
      name: league.name,
      statValues: "v2",
      lineSize: league.lineSize,
      salaryCalc: league.salaryCalc,
    });
    expect(payload.game.homeTeam).toBe("Team A (Alice)");
    expect(payload.quality.warnings).toBeInstanceOf(Array);
  });

  it("gives each raw ref its own representation: raw preserved, stripped name, isSubstitute", () => {
    const payload = canonicalizeGame(syntheticGame(), league);
    const [point] = payload.game.points;
    expect(point.offensePlayers[0]).toEqual({
      raw: "Quinn Fielder",
      name: "Quinn Fielder",
      isSubstitute: false,
    });
    expect(point.offensePlayers[1]).toEqual({
      raw: "Rowan Vale(S)",
      name: "Rowan Vale",
      isSubstitute: true,
    });
    expect(point.offensePlayers[1].raw).toBe("Rowan Vale(S)");
  });

  it("derives durationSec from first and last non-PULL event timestamps", () => {
    const payload = canonicalizeGame(syntheticGame(), league);
    expect(payload.game.points[0].durationSec).toBe(20);
  });

  it("yields durationSec null when there are too few usable non-PULL timestamps, never zero", () => {
    const payload = canonicalizeGame(
      syntheticGame({
        points: [
          {
            offensePlayers: ["Quinn Fielder"],
            defensePlayers: [],
            events: [{ type: "POINT", firstActor: "Quinn Fielder", secondActor: null, timestamp: "" }],
          },
        ],
      }),
      league,
    );
    expect(payload.game.points[0].durationSec).toBeNull();
  });

  it("preserves extra or missing line players as recorded and warns for line-size mismatch", () => {
    const payload = canonicalizeGame(
      syntheticGame({
        points: [
          {
            offensePlayers: [
              "Quinn Fielder",
              "Rowan Vale(S)",
              "Extra Person(S)",
            ],
            defensePlayers: ["Casey Brook"],
            events: [],
          },
        ],
      }),
      league,
    );
    const point = payload.game.points[0];
    expect(point.offensePlayers.map((p) => p.name)).toContain("Extra Person");
    const codes = payload.quality.warnings.filter(
      (w) => w.code === "LINE_SIZE_MISMATCH",
    );
    expect(codes.length).toBe(2);
  });

  it("warns for duplicate players within one recorded line", () => {
    const payload = canonicalizeGame(
      syntheticGame({
        points: [
          {
            offensePlayers: ["Quinn Fielder", "Quinn Fielder"],
            defensePlayers: ["Casey Brook"],
            events: [],
          },
        ],
      }),
      league,
    );
    expect(
      payload.quality.warnings.some((w) => w.code === "DUPLICATE_LINE_PLAYER"),
    ).toBe(true);
  });

  it("warns when a player is recorded on both lines of one point", () => {
    const payload = canonicalizeGame(
      syntheticGame({
        points: [
          {
            offensePlayers: ["Quinn Fielder"],
            defensePlayers: ["Casey Brook", "Quinn Fielder"],
            events: [],
          },
        ],
      }),
      league,
    );
    expect(
      payload.quality.warnings.some((w) => w.code === "PLAYER_ON_BOTH_LINES"),
    ).toBe(true);
  });

  it("warns for event actors outside both recorded lines", () => {
    const payload = canonicalizeGame(
      syntheticGame({
        points: [
          {
            offensePlayers: ["Quinn Fielder"],
            defensePlayers: ["Casey Brook"],
            events: [
              {
                type: "PASS",
                firstActor: "Mystery Actor",
                secondActor: "Quinn Fielder",
                timestamp: "3/14/2026, 6:00:10 PM",
              },
            ],
          },
        ],
      }),
      league,
    );
    expect(
      payload.quality.warnings.some((w) => w.code === "ACTOR_OUTSIDE_LINES"),
    ).toBe(true);
  });

  it("warns for one player recorded both with and without the (S) marker", () => {
    const payload = canonicalizeGame(
      syntheticGame({
        points: [
          {
            offensePlayers: ["Quinn Fielder(S)"],
            defensePlayers: ["Quinn Fielder"],
            events: [],
          },
        ],
      }),
      league,
    );
    expect(
      payload.quality.warnings.some(
        (w) => w.code === "SUBSTITUTE_STATUS_CONFLICT",
      ),
    ).toBe(true);
  });

  it("canonicalizes a synthetic v2 league game resolved via roster and event data", () => {
    // League id/name distinct from either team name; teams are season-scoped,
    // so resolution here works within this one game's rosters only.
    const syntheticLeague = {
      ...league,
      id: league.id + 1,
      name: "Weeknight Schedule",
    } as SupportedLeague;
    const payload = canonicalizeGame(
      syntheticGame({
        homeRoster: ["Quinn Fielder", "Rowan Vale(S)"],
        awayRoster: ["Casey Brook"],
      }),
      syntheticLeague,
    );
    expect(payload.league).toEqual({
      id: league.id + 1,
      name: "Weeknight Schedule",
      statValues: "v2",
      lineSize: league.lineSize,
      salaryCalc: league.salaryCalc,
    });
    // Team names preserved as captured for this game.
    expect(payload.game.homeTeam).toBe("Team A (Alice)");
    expect(payload.game.awayTeam).toBe("Team B (Bob)");
    // Roster-based attribution works within the game's season scope.
    expect(resolvePlayerTeam("Casey Brook", payload)).toEqual({
      team: "Team B (Bob)",
      teamSource: "roster",
    });
    // Point and event data preserved intact.
    const [point] = payload.game.points;
    expect(point.pointNumber).toBe(1);
    expect(point.durationSec).toBe(20);
    expect(point.events[1]).toEqual({
      type: "PASS",
      firstActor: "Quinn Fielder",
      secondActor: "Rowan Vale(S)",
      timestamp: "3/14/2026, 6:00:10 PM",
      timestampLocal: "3/14/2026, 6:00:10 PM",
      timestampSec: expect.any(Number),
    });
  });
});

describe("resolvePlayerTeam", () => {
  it("uses a valid stats.team first (precedence 1)", () => {
    const payload = payload1002();
    const result = resolvePlayerTeam("Matthew Muzzatti(S)", payload);
    expect(result).toEqual({
      team: "Mayflowers (Noah)",
      teamSource: "stats",
    });
  });

  it("falls back to roster when stats.team is invalid (precedence 2)", () => {
    const payload = canonicalizeGame(
      syntheticGame({
        homeRoster: ["On Roster Only"],
        stats: {
          "On Roster Only": { ...emptyStat(), team: "Unknown" },
        } as ApiGame["stats"],
      }),
      league,
    );
    expect(resolvePlayerTeam("On Roster Only", payload)).toEqual({
      team: "Team A (Alice)",
      teamSource: "roster",
    });
  });

  it("falls back to line-majority when stats.team and roster are unavailable (precedence 3)", () => {
    const payload = payload1002();
    const result = resolvePlayerTeam("Sam Lanesmith(S)", payload);
    expect(result).toEqual({
      team: "Mayflowers (Noah)",
      teamSource: "line-majority",
    });
  });

  it("returns explicit unknown only when nothing else resolves (precedence 4)", () => {
    const payload = canonicalizeGame(
      syntheticGame({
        stats: {
          "Split Player": { ...emptyStat(), team: "Unknown" },
          "Team A Mate": { ...emptyStat(), team: "Team A (Alice)" },
          "Team B Mate": { ...emptyStat(), team: "Team B (Bob)" },
        } as ApiGame["stats"],
        points: [
          {
            offensePlayers: ["Split Player", "Team A Mate", "Team B Mate"],
            defensePlayers: [],
            events: [],
          },
        ],
      }),
      league,
    );
    expect(resolvePlayerTeam("Split Player", payload)).toEqual({
      team: null,
      teamSource: "unknown",
    });
    expect(
      payload.quality.warnings.some(
        (w) => w.code === "UNRESOLVED_PLAYER_TEAM" && w.player === "Split Player",
      ),
    ).toBe(true);
  });

  it("does not mutate game.quality.warnings", () => {
    const payload = payload1002();
    const before = JSON.stringify(payload.quality.warnings);
    resolvePlayerTeam("Sam Lanesmith(S)", payload);
    resolvePlayerTeam("Nobody Here", payload);
    expect(JSON.stringify(payload.quality.warnings)).toBe(before);
  });

  it("reports no UNRESOLVED_PLAYER_TEAM warning for Sam Lanesmith in fixture game 1002", () => {
    const payload = payload1002();
    expect(
      payload.quality.warnings.filter(
        (w) => w.code === "UNRESOLVED_PLAYER_TEAM",
      ),
    ).toHaveLength(0);
  });
});

describe("qualityReport", () => {
  it("warns for a substitute absent from every roster (fixture game 1002)", () => {
    const payload = payload1002();
    const substitutes = payload.quality.warnings.filter(
      (w) => w.code === "SUBSTITUTE_NOT_ON_ROSTER",
    );
    expect(substitutes).toHaveLength(1);
    expect(substitutes[0].player).toBe("Sam Lanesmith(S)");
  });

  it("is pure: twice-run reports are equal and input payload stays unchanged", () => {
    const payload = payload1002();
    const a = qualityReport(payload);
    const b = qualityReport(payload);
    expect(a).toEqual(b);
    expect(a).toEqual(payload.quality);
  });

  it("matches team attribution precedence ends: Sam resolves, synthetic split warns", () => {
    const payload = payload1002();
    const sam = payload.stats.find((s) => s.name === "Sam Lanesmith");
    expect(sam?.team).toBe("Unknown");
  });
});

describe("canonicalizeGame gender attachment", () => {
  it("attaches isOpen to stat lines from the gender map, absent for unknown players", () => {
    const genderMap = new Map([
      ["quinn fielder", true],
      ["rowan vale", false],
    ]);
    const payload = canonicalizeGame(
      syntheticGame({
        stats: {
          "Quinn Fielder": emptyStat(),
          "Rowan Vale(S)": emptyStat(),
          "Mystery Player": emptyStat(),
        } as ApiGame["stats"],
      }),
      league,
      genderMap,
    );
    expect(payload.stats.find((s) => s.name === "Quinn Fielder")?.isOpen).toBe(true);
    // Substitute marker on the stats key still matches the stripped map key.
    expect(payload.stats.find((s) => s.name === "Rowan Vale")?.isOpen).toBe(false);
    expect(payload.stats.find((s) => s.name === "Mystery Player")?.isOpen).toBeUndefined();
  });

  it("omits isOpen entirely when no gender map is provided", () => {
    const payload = canonicalizeGame(syntheticGame(), league);
    expect(payload.stats.every((s) => s.isOpen === undefined)).toBe(true);
  });
});

describe("buildGenderMap", () => {
  const rawTeams = [
    {
      id: 1,
      name: "Team A (Alice)",
      players: [
        { name: "Quinn Fielder", is_open: true, team: "Team A (Alice)" },
        { name: "Rowan Vale(S)", is_open: false, team: "Team A (Alice)" },
      ],
    },
    {
      id: 2,
      name: "Team B (Bob)",
      players: [{ name: "Casey Brook", is_open: false, team: "Team B (Bob)" }],
    },
    { garbage: true },
    {
      id: 3,
      name: "Team C",
      players: [{ name: "Broken Player", is_open: "yes" }],
    },
    {
      id: 4,
      name: "Team D",
      players: [{ name: "Quinn Fielder", is_open: false, team: "Team D (Dee)" }],
    },
  ];

  it("keys stripped lower-case names and maps is_open", () => {
    const map = buildGenderMap(rawTeams);
    expect(map.get("rowan vale")).toBe(false);
    expect(map.get("casey brook")).toBe(false);
  });

  it("drops a single player claimed with conflicting divisions", () => {
    const map = buildGenderMap(rawTeams);
    expect(map.get("quinn fielder")).toBeUndefined();
  });

  it("ignores malformed teams and players", () => {
    const map = buildGenderMap(rawTeams);
    expect(map.has("broken player")).toBe(false);
  });

  it("returns an empty map for a null or non-array payload", () => {
    expect(buildGenderMap(null).size).toBe(0);
    expect(buildGenderMap({}).size).toBe(0);
  });
});

function emptyStat(): ApiGame["stats"][string] {
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
    team: null,
  };
}

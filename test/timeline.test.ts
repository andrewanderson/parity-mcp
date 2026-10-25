import { describe, expect, it } from "vitest";

import type { ApiGame, GamePayload, SupportedLeague, ApiStatLine } from "../src/domain/types.js";
import { canonicalizeGame } from "../src/data/normalize.js";
import { buildScoreTimelineAndStoryFacts } from "../src/engine/timeline.js";

import game1008 from "./fixtures/captures/game-1008.json";

const league24: SupportedLeague = {
  id: 24,
  name: "Winter Indoor Parity 2026",
  lineSize: 6,
  salaryCalc: "pro_rate",
};

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

function payload1008(): GamePayload {
  return canonicalizeGame(game1008 as unknown as ApiGame, league24);
}

describe("buildScoreTimelineAndStoryFacts for fixture game 1008", () => {
  it("builds one scored point per POINT event and ends at the event-derived final 20-19", () => {
    const payload = payload1008();
    const { timeline, storyFacts } = buildScoreTimelineAndStoryFacts(payload);

    expect(timeline.length).toBe(39);
    const last = timeline[timeline.length - 1];
    expect(last.homeScore).toBe(20);
    expect(last.awayScore).toBe(19);
    expect(last.pointNumber).toBe(39);

    // The final scored point is by the eventual winning team (home, 20 > 19).
    expect(storyFacts.finalPoint).not.toBeNull();
    expect(storyFacts.finalPoint?.scoringTeam).toBe(payload.game.homeTeam);
    expect(payload.game.homeScore).toBe(20);
    expect(payload.game.awayScore).toBe(19);
  });

  it("derives the comeback: eventual winner trailed by 4 and completed the comeback", () => {
    const payload = payload1008();
    const { storyFacts } = buildScoreTimelineAndStoryFacts(payload);

    expect(storyFacts.largestComeback).not.toBeNull();
    expect(storyFacts.largestComeback?.team).toBe(payload.game.homeTeam);
    expect(storyFacts.largestComeback?.maxDeficit).toBe(4);
    expect(storyFacts.largestComeback?.comebackCompletedAt).toBe(33);
  });

  it("derives story facts from attributed scored points with no invented numbers", () => {
    const payload = payload1008();
    const { timeline, storyFacts } = buildScoreTimelineAndStoryFacts(payload);

    // Every timeline step advances exactly one team's score by exactly one.
    let home = 0;
    let away = 0;
    for (const item of timeline) {
      expect(item.homeScore - home).toBeLessThanOrEqual(1);
      expect(item.awayScore - away).toBeLessThanOrEqual(1);
      expect(
        item.homeScore - home === 1 ? item.awayScore - away === 0 : item.awayScore - away === 1,
      ).toBe(true);
      home = item.homeScore;
      away = item.awayScore;
    }

    // Runs partition the timeline.
    const runLengths = storyFacts.scoringRuns.reduce((sum, run) => sum + run.length, 0);
    expect(runLengths).toBe(timeline.length);

    // Largest lead is a real observed margin from the progression.
    const largest = storyFacts.largestLead;
    expect(largest).not.toBeNull();
    expect(Math.abs(largest!.homeScore - largest!.awayScore)).toBe(4);
  });
});

describe("synthetic controlled games", () => {
  it("uses event data for scoring team names, which are season-scoped and may differ from a former name", () => {
    // The roster and header carry last season's name; this season's stats name
    // differs. The timeline must attribute by the event-resolved team name.
    const rawGame: ApiGame = {
      id: 9998,
      league_id: 24,
      status: "final",
      week: 1,
      homeTeam: "Team A (Alice)",
      awayTeam: "Old Side (Bob)",
      homeRoster: ["Keeper Pat"],
      awayRoster: ["Scorer Sue"],
      homeScore: 5,
      awayScore: 0,
      points: [
        {
          offensePlayers: ["Keeper Pat"],
          defensePlayers: ["Scorer Sue"],
          events: [
            {
              type: "PULL",
              firstActor: "Keeper Pat",
              secondActor: null,
              timestamp: "3/14/2026, 6:00:00 PM",
            },
            {
              type: "POINT",
              firstActor: "Scorer Sue",
              secondActor: null,
              timestamp: "3/14/2026, 6:00:30 PM",
            },
          ],
        },
      ],
      stats: {
        "Scorer Sue": statLine("Renamed Side (Bob)"),
      },
    };
    const payload = canonicalizeGame(rawGame, league24);
    const { timeline, storyFacts } = buildScoreTimelineAndStoryFacts(payload);

    expect(timeline.length).toBe(1);
    expect(timeline[0].scoringTeam).toBe("Renamed Side (Bob)");
    expect(timeline[0].holdOrBreak).toBe("BREAK");
    expect(timeline[0].homeScore).toBe(0);
    expect(timeline[0].awayScore).toBe(1);
    expect(storyFacts.finalPoint?.scoringTeam).toBe("Renamed Side (Bob)");
  });

  it("leaves scoringTeam null with a quality warning when the scorer resolves to no team", () => {
    const rawGame: ApiGame = {
      id: 9997,
      league_id: 24,
      status: "final",
      week: 1,
      homeTeam: "Team A (Alice)",
      awayTeam: "Team B (Bob)",
      homeRoster: [],
      awayRoster: [],
      homeScore: 0,
      awayScore: 0,
      points: [
        {
          offensePlayers: ["Mystery Player", "Home One", "Away One"],
          defensePlayers: ["Home Two", "Away Two"],
          events: [
            {
              type: "POINT",
              firstActor: "Mystery Player",
              secondActor: null,
              timestamp: "3/14/2026, 6:00:30 PM",
            },
          ],
        },
      ],
      stats: {
        "Mystery Player": statLine("Unknown"),
        "Home One": statLine("Team A (Alice)"),
        "Away One": statLine("Team B (Bob)"),
        "Home Two": statLine("Team A (Alice)"),
        "Away Two": statLine("Team B (Bob)"),
      },
    };
    const payload = canonicalizeGame(rawGame, league24);
    const { timeline, storyFacts } = buildScoreTimelineAndStoryFacts(payload);

    expect(timeline.length).toBe(1);
    expect(timeline[0].scoringTeam).toBe(null);
    expect(timeline[0].holdOrBreak).toBe(null);
    expect(timeline[0].homeScore).toBe(0);
    expect(timeline[0].awayScore).toBe(0);
    expect(storyFacts.finalPoint?.scoringTeam).toBe(null);

    const unresolved = payload.quality.warnings.filter(
      (w) => w.code === "UNRESOLVED_PLAYER_TEAM" && w.player === "Mystery Player",
    );
    expect(unresolved.length).toBe(1);
  });
});

import { describe, expect, it } from "vitest";
import { buildPlayerContext, type PriorGames, type PriorGameRow } from "../src/engine/playerContext.js";
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

function row(
  id: number,
  week: number,
  team: string,
  roster: string[],
): PriorGameRow {
  return {
    id,
    week,
    status: "final",
    homeTeam: team,
    awayTeam: "Bye Week (Bye)",
    homeRoster: roster,
    awayRoster: ["Roster Filler"],
  };
}

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

describe("buildPlayerContext: transitions", () => {
  it("reports a trade debut with prior team and week", () => {
    const payload = makePayload(4, ["Nick Theriault"], ["Justin Ye"]);
    const context = buildPlayerContext(payload, {
      available: true,
      rows: [
        row(2000, 2, "Team Des (Des)", ["Nick Theriault"]),
        row(2001, 3, "Canada Geese (Jer)", ["Nick Theriault"]),
      ],
    });
    expect(context.transitions).toHaveLength(1);
    const transition = context.transitions[0];
    expect(transition.player).toBe("Nick Theriault");
    expect(transition.team).toBe("Swing Break (Des)");
    expect(transition.priorTeam).toBe("Canada Geese (Jer)");
    expect(transition.priorWeek).toBe(3);
    expect(transition.tradeDebut).toBe(true);
    expect(transition.teamNumber).toBe(2);
    expect(transition.formerTeams).toContainEqual({
      team: "Canada Geese (Jer)",
      franchiseLabel: "Jer",
      weeks: [3],
    });
  });

  it("does not count a substitute stint as team membership", () => {
    const payload = makePayload(
      4,
      ["Alisha Zhao"],
      ["Justin Ye"],
      [],
      "Mayflowers (Noah)",
    );
    const context = buildPlayerContext(payload, {
      available: true,
      rows: [
        row(2000, 2, "Team Des (Des)", ["Alisha Zhao"]),
        row(2001, 3, "Canada Geese (Jer)", ["Alisha Zhao(S)"]),
      ],
    });
    expect(context.transitions).toHaveLength(1);
    const transition = context.transitions[0];
    expect(transition.priorTeam).toBe("Team Des (Des)");
    expect(transition.priorWeek).toBe(2);
    expect(transition.tradeDebut).toBe(true);
    expect(transition.teamNumber).toBe(2);
    expect(transition.formerTeams).toEqual([
      { team: "Team Des (Des)", franchiseLabel: "Des", weeks: [2] },
    ]);
  });

  it("treats a renamed franchise as one franchise via captain label", () => {
    const payload = makePayload(3, ["Nick Theriault"], ["Justin Ye"]);
    const context = buildPlayerContext(payload, {
      available: true,
      rows: [
        row(2000, 1, "Team Des (Des)", ["Nick Theriault"]),
        row(2001, 2, "Team Des (Des)", ["Nick Theriault"]),
        // The Geese roster registers their own players too, so the rename is
        // the only fact under test.
        row(2000, 1, "Canada Geese (Jer)", ["Justin Ye"]),
        row(2001, 2, "Canada Geese (Jer)", ["Justin Ye"]),
      ],
    });
    expect(context.transitions).toEqual([]);
  });

  it("reports a return to a former franchise", () => {
    const payload = makePayload(
      6,
      ["Alisha Zhao"],
      ["Justin Ye"],
      [],
      "Mayflowers (Noah)",
    );
    const context = buildPlayerContext(payload, {
      available: true,
      rows: [
        row(2000, 1, "Mayflowers (Noah)", ["Alisha Zhao"]),
        row(2001, 4, "Canada Geese (Jer)", ["Alisha Zhao"]),
        row(2002, 5, "Canada Geese (Jer)", ["Alisha Zhao"]),
      ],
    });
    expect(context.transitions).toHaveLength(1);
    const transition = context.transitions[0];
    expect(transition.tradeDebut).toBe(true);
    expect(transition.priorTeam).toBe("Canada Geese (Jer)");
    expect(transition.returnToFranchise).toBe(true);
    expect(transition.teamNumber).toBe(2);
    expect(transition.priorWeeksOnTeam).toEqual([1]);
    expect(transition.formerTeams).toEqual([
      { team: "Canada Geese (Jer)", franchiseLabel: "Jer", weeks: [4, 5] },
    ]);
  });

  it("counts distinct franchises as teamNumber, null when 1", () => {
    const payload = makePayload(
      6,
      ["Alisha Zhao"],
      ["Justin Ye"],
      [],
      "Mayflowers (Noah)",
    );
    const context = buildPlayerContext(payload, {
      available: true,
      rows: [
        row(2000, 1, "Mayflowers (Noah)", ["Alisha Zhao"]),
        row(2001, 3, "Canada Geese (Jer)", ["Alisha Zhao"]),
        row(2002, 5, "Team Des (Des)", ["Alisha Zhao"]),
      ],
    });
    expect(context.transitions[0]?.teamNumber).toBe(3);
    expect(context.transitions[0]?.returnToFranchise).toBe(true);

    const sameTeam = buildPlayerContext(
      makePayload(4, ["Nick Theriault"], ["Justin Ye"]),
      {
        available: true,
        rows: [row(2000, 2, "Swing Break (Des)", ["Nick Theriault"])],
      },
    );
    expect(sameTeam.transitions).toEqual([]);
  });

  it("builds former-opponent subsets from the opponent label", () => {
    const payload = makePayload(
      6,
      ["Alisha Zhao"],
      ["Justin Ye"],
      [],
      "Mayflowers (Noah)",
      "Canada Geese (Jer)",
    );
    const context = buildPlayerContext(payload, {
      available: true,
      rows: [
        row(2000, 2, "Team Des (Des)", ["Alisha Zhao"]),
        row(2001, 3, "Team Des (Des)", ["Alisha Zhao"]),
        row(2002, 4, "Canada Geese (Jer)", ["Alisha Zhao"]),
        row(2003, 5, "Canada Geese (Jer)", ["Alisha Zhao"]),
      ],
    });
    expect(context.transitions[0]?.formerTeams).toEqual([
      { team: "Team Des (Des)", franchiseLabel: "Des", weeks: [2, 3] },
      { team: "Canada Geese (Jer)", franchiseLabel: "Jer", weeks: [4, 5] },
    ]);
    expect(context.transitions[0]?.opponentFormerTeams).toEqual([
      { team: "Canada Geese (Jer)", franchiseLabel: "Jer", weeks: [4, 5] },
    ]);
  });

  it("omits transition rows when a player has two registered games in one earlier week", () => {
    const payload = makePayload(4, ["Nick Theriault"], ["Justin Ye"]);
    const context = buildPlayerContext(payload, {
      available: true,
      rows: [
        row(2000, 2, "Team Des (Des)", ["Nick Theriault"]),
        row(2001, 2, "Canada Geese (Jer)", ["Nick Theriault"]),
      ],
    });
    expect(
      context.transitions.find((t) => t.player === "Nick Theriault"),
    ).toBeUndefined();
  });

  it("omits players whose only prior franchise is today's", () => {
    const payload = makePayload(4, ["Nick Theriault"], ["Justin Ye"]);
    const context = buildPlayerContext(payload, {
      available: true,
      rows: [row(2000, 2, "Swing Break (Des)", ["Nick Theriault"])],
    });
    expect(context.transitions).toEqual([]);
  });
});

describe("buildPlayerContext: first appearances and unaccounted weeks", () => {
  it("reports a first appearance when every earlier week is accounted", () => {
    const payload = makePayload(3, ["Tiger Ye"], ["Justin Ye"]);
    const context = buildPlayerContext(payload, {
      available: true,
      rows: [
        row(2000, 1, "Canada Geese (Jer)", ["Justin Ye"]),
        row(2001, 2, "Canada Geese (Jer)", ["Justin Ye"]),
      ],
    });
    expect(context.transitions).toHaveLength(1);
    const transition = context.transitions[0];
    expect(transition.player).toBe("Tiger Ye");
    expect(transition.firstAppearance).toBe(true);
    expect(transition.priorTeam).toBeNull();
    expect(transition.priorWeek).toBeNull();
    expect(transition.tradeDebut).toBe(false);
    expect(transition.teamNumber).toBeNull();
    expect(transition.returnToFranchise).toBe(false);
    expect(transition.formerTeams).toEqual([]);
    expect(context.note).toBeNull();
  });

  it("suppresses first-appearance rows when an earlier week is missing entirely", () => {
    const payload = makePayload(3, ["Tiger Ye"], ["Justin Ye"]);
    const context = buildPlayerContext(payload, {
      available: true,
      rows: [row(2000, 1, "Canada Geese (Jer)", ["Justin Ye"])],
    });
    expect(
      context.transitions.find((t) => t.player === "Tiger Ye"),
    ).toBeUndefined();
    expect(context.priorDataAvailable).toBe(true);
    expect(context.note).toBe(
      "Earlier weeks without usable data: weeks 2.",
    );
  });

  it("suppresses first-appearance rows when an earlier week has no usable row", () => {
    const payload = makePayload(3, ["Tiger Ye"], ["Justin Ye"]);
    const context = buildPlayerContext(payload, {
      available: true,
      rows: [
        row(2000, 1, "Canada Geese (Jer)", ["Justin Ye"]),
        { ...row(2001, 2, "Canada Geese (Jer)", ["Justin Ye"]), status: "scheduled" },
      ],
    });
    expect(
      context.transitions.find((t) => t.player === "Tiger Ye"),
    ).toBeUndefined();
    expect(context.note).toBe(
      "Earlier weeks without usable data: weeks 2.",
    );
  });

  it("keeps debut and return rows when a week is unaccounted", () => {
    const payload = makePayload(
      6,
      ["Alisha Zhao"],
      ["Justin Ye"],
      [],
      "Mayflowers (Noah)",
    );
    const context = buildPlayerContext(payload, {
      available: true,
      rows: [
        row(2000, 1, "Mayflowers (Noah)", ["Alisha Zhao"]),
        row(2001, 4, "Canada Geese (Jer)", ["Alisha Zhao"]),
      ],
    });
    expect(context.transitions).toHaveLength(1);
    const transition = context.transitions[0];
    expect(transition.returnToFranchise).toBe(true);
    expect(transition.priorTeam).toBe("Canada Geese (Jer)");
    expect(context.note).toBe(
      "Earlier weeks without usable data: weeks 2, 3, 5.",
    );
  });
});

describe("buildPlayerContext: review fixes", () => {
  it("ignores today's own and later-week rows when deriving transitions", () => {
    const payload = makePayload(4, ["Nick Theriault"], ["Justin Ye"]);
    const context = buildPlayerContext(payload, {
      available: true,
      rows: [
        row(2000, 2, "Team Des (Des)", ["Nick Theriault"]),
        row(2001, 3, "Canada Geese (Jer)", ["Nick Theriault"]),
        // Today's own final row and a later-week final row: neither may
        // contribute a prior appearance.
        { ...row(2001, 4, "Swing Break (Des)", ["Nick Theriault"]) },
        row(2002, 5, "Canada Geese (Jer)", ["Nick Theriault"]),
      ],
    });
    expect(context.transitions).toHaveLength(1);
    const transition = context.transitions[0];
    expect(transition.tradeDebut).toBe(true);
    expect(transition.priorTeam).toBe("Canada Geese (Jer)");
    expect(transition.priorWeek).toBe(3);
    expect(transition.teamNumber).toBe(2);
  });

  it("resolves a substitute team through the existing team-resolution rules", () => {
    const payload = makePayload(
      2,
      ["Kendall Carmichael(S)"],
      ["Justin Ye"],
      [
        statLine("Sam Lanesmith(S)", { name: "Sam Lanesmith", team: "Unknown" }),
        statLine("Kendall Carmichael(S)", { name: "Kendall Carmichael", team: "Unknown" }),
      ],
    );
    const context = buildPlayerContext(payload, noPrior);
    expect(context.substitutes).toEqual([
      { player: "Sam Lanesmith", team: null },
      { player: "Kendall Carmichael", team: "Swing Break (Des)" },
    ]);
  });

  it("suppresses first-appearance rows when the player already appeared as a substitute", () => {
    const payload = makePayload(2, ["Alisha Zhao"], ["Justin Ye"]);
    const context = buildPlayerContext(payload, {
      available: true,
      rows: [row(2000, 1, "Canada Geese (Jer)", ["Alisha Zhao(S)"])],
    });
    expect(
      context.transitions.find((t) => t.player === "Alisha Zhao"),
    ).toBeUndefined();
  });

  it("keeps a today substitute with prior registered play out of transitions", () => {
    const payload = makePayload(2, ["Sam Lanesmith(S)"], ["Justin Ye"], [
      statLine("Sam Lanesmith(S)", { name: "Sam Lanesmith", team: "Team Des (Des)" }),
    ]);
    const context = buildPlayerContext(payload, {
      available: true,
      rows: [
        row(2000, 1, "Team Des (Des)", ["Sam Lanesmith"]),
        row(2001, 1, "Canada Geese (Jer)", ["Justin Ye"]),
      ],
    });
    expect(context.transitions).toEqual([]);
    expect(context.substitutes).toEqual([
      { player: "Sam Lanesmith", team: "Team Des (Des)" },
    ]);
  });

  it("resolves a today player to their registered side when they also appear as a sub on the other roster", () => {
    const payload = makePayload(
      4,
      ["Nick Theriault(S)"],
      ["Nick Theriault"],
    );
    const context = buildPlayerContext(payload, {
      available: true,
      rows: [row(2000, 2, "Team Des (Des)", ["Nick Theriault"])],
    });
    const transition = context.transitions.find(
      (t) => t.player === "Nick Theriault",
    );
    expect(transition?.team).toBe("Canada Geese (Jer)");
    expect(transition?.franchiseLabel).toBe("Jer");
    expect(transition?.priorTeam).toBe("Team Des (Des)");
    expect(transition?.tradeDebut).toBe(true);
  });

  it("skips transition derivation for a player registered on both rosters today", () => {
    const payload = makePayload(4, ["Nick Theriault"], ["Nick Theriault"]);
    const context = buildPlayerContext(payload, {
      available: true,
      rows: [row(2000, 2, "Team Des (Des)", ["Nick Theriault"])],
    });
    expect(
      context.transitions.find((t) => t.player === "Nick Theriault"),
    ).toBeUndefined();
  });

  it("prefers today's roster casing for the player name", () => {
    const payload = makePayload(4, ["Nadine Cann"], ["Justin Ye"]);
    const context = buildPlayerContext(payload, {
      available: true,
      rows: [row(2000, 2, "Canada Geese (Jer)", ["nadine cann"])],
    });
    expect(context.transitions).toHaveLength(1);
    expect(context.transitions[0]?.player).toBe("Nadine Cann");
  });
});

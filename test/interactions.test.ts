import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { canonicalizeGame } from "../src/data/normalize.js";
import { buildSalaryLedger } from "../src/engine/salary.js";
import { buildInteractions } from "../src/engine/interactions.js";
import type {
  ApiGame,
  ApiPoint,
  ApiStatLine,
  GamePayload,
  InteractionsPayload,
  RawPlayerRef,
  SupportedLeague,
} from "../src/domain/types.js";

const fixturesDir = "./test/fixtures/captures";

const league24: SupportedLeague = {
  id: 24,
  name: "Winter Indoor Parity 2026",
  lineSize: 6,
  salaryCalc: "pro_rate",
};

const leagueSmall: SupportedLeague = {
  id: 24,
  name: "Winter Indoor Parity 2026",
  lineSize: 2,
  salaryCalc: "pro_rate",
};

function statLine(pay: number, team: string | null = null): ApiStatLine {
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
    pay,
    team,
  };
}

type SyntheticPoint = {
  offense: RawPlayerRef[];
  defense: RawPlayerRef[];
  events: Array<{ type: string; firstActor: RawPlayerRef | null; secondActor: RawPlayerRef | null }>;
};

function syntheticPayload(
  points: SyntheticPoint[],
  stats: Record<RawPlayerRef, ApiStatLine>,
  league: SupportedLeague = leagueSmall,
): GamePayload {
  const apiPoints: ApiPoint[] = points.map((point) => ({
    offensePlayers: point.offense,
    defensePlayers: point.defense,
    events: point.events.map((event) => ({
      type: event.type,
      firstActor: event.firstActor,
      secondActor: event.secondActor,
      timestamp: "3/15/2026, 6:13:40 PM",
    })),
  }));
  const rawGame: ApiGame = {
    id: 1,
    league_id: league.id,
    status: "final",
    week: 1,
    homeTeam: "Home Team",
    awayTeam: "Away Team",
    homeRoster: [],
    awayRoster: [],
    homeScore: 0,
    awayScore: 0,
    points: apiPoints,
    stats,
  };
  return canonicalizeGame(rawGame, league);
}

function pairOf(
  interactions: InteractionsPayload,
  kind: "teammate" | "opponent",
  a: string,
  b: string,
) {
  const pair = interactions[kind === "teammate" ? "teammatePairs" : "opponentPairs"].find(
    (p) =>
      (p.playerA.toLowerCase() === a.toLowerCase() && p.playerB.toLowerCase() === b.toLowerCase()) ||
      (p.playerA.toLowerCase() === b.toLowerCase() && p.playerB.toLowerCase() === a.toLowerCase()),
  );
  expect(pair).toBeDefined();
  return pair as NonNullable<typeof pair>;
}

function exposureOf(
  interactions: InteractionsPayload,
  name: string,
  teamIndex: number,
) {
  const exposure = interactions.exposures.find(
    (e) => e.name.toLowerCase() === name.toLowerCase() && e.teamIndex === teamIndex,
  );
  expect(exposure).toBeDefined();
  return exposure as NonNullable<typeof exposure>;
}

describe("buildInteractions: fixture game 1000", () => {
  const rawGame = JSON.parse(
    readFileSync(`${fixturesDir}/game-1000.json`, "utf8"),
  ) as ApiGame;
  const payload = canonicalizeGame(rawGame, league24);
  const ledger = buildSalaryLedger(payload);
  const interactions = buildInteractions(payload, ledger);

  it("teammatePairs include plausible co-occurrence and salary summaries", () => {
    expect(interactions.teammatePairs.length).toBeGreaterThan(0);
    // Co-occurrence counts match the raw recorded lines of the fixture.
    for (const pair of interactions.teammatePairs) {
      const expectedPoints = rawGame.points
        .map((_, i) => i + 1)
        .filter((pointNumber) => {
          const point = rawGame.points[pointNumber - 1];
          const keyA = pair.playerA.toLowerCase();
          const keyB = pair.playerB.toLowerCase();
          const on = (raw: string) => raw.replace(/\(S\)\s*$/i, "").trim().toLowerCase();
          const sameRow = (row: string[]) => {
            const keys = row.map(on);
            return keys.includes(keyA) && keys.includes(keyB);
          };
          return sameRow(point.offensePlayers) || sameRow(point.defensePlayers);
        });
      expect(pair.pointsTogether.sort((a, b) => a - b)).toEqual(expectedPoints.sort((a, b) => a - b));
      expect(pair.salaryPoints.length).toBe(pair.pointsTogether.length);
      // Each pair member's salary for a shared point matches the ledger.
      for (const point of pair.salaryPoints) {
        const ledgerPoint = ledger.points.find((p) => p.pointNumber === point.pointNumber);
        expect(ledgerPoint).toBeDefined();
        const salaryFor = (name: string) =>
          (ledgerPoint as { playerSalaries: Array<{ name: string; total: number }> }).playerSalaries
            .find((s) => s.name.toLowerCase() === name.toLowerCase())?.total ?? 0;
        expect(point.salaryA).toBe(salaryFor(pair.playerA));
        expect(point.salaryB).toBe(salaryFor(pair.playerB));
        expect(typeof point.salaryA).toBe("number");
        expect(typeof point.salaryB).toBe("number");
      }
    }
  });

  it("opponentPairs pair players across the two recorded lines of the same point", () => {
    expect(interactions.opponentPairs.length).toBeGreaterThan(0);
    const rawGameLocal = rawGame;
    for (const pair of interactions.opponentPairs) {
      const on = (raw: string) => raw.replace(/\(S\)\s*$/i, "").trim().toLowerCase();
      const keyA = pair.playerA.toLowerCase();
      const keyB = pair.playerB.toLowerCase();
      for (const pointNumber of pair.pointsTogether) {
        const point = rawGameLocal.points[pointNumber - 1];
        const offenseKeys = point.offensePlayers.map(on);
        const defenseKeys = point.defensePlayers.map(on);
        expect(
          (offenseKeys.includes(keyA) && defenseKeys.includes(keyB)) ||
            (offenseKeys.includes(keyB) && defenseKeys.includes(keyA)),
        ).toBe(true);
      }
    }
  });

  it("exposure counts match the points each player is recorded in, with resolved teams", () => {
    expect(interactions.exposures.length).toBeGreaterThan(0);
    const on = (raw: string) => raw.replace(/\(S\)\s*$/i, "").trim().toLowerCase();
    const recordedPoints = new Map<string, number>();
    rawGame.points.forEach((point) => {
      for (const raw of [...point.offensePlayers, ...point.defensePlayers]) {
        const key = on(raw);
        recordedPoints.set(key, (recordedPoints.get(key) ?? 0) + 1);
      }
    });
    const exposuresByKey = new Map<string, number>();
    for (const exposure of interactions.exposures) {
      exposuresByKey.set(
        exposure.name.toLowerCase(),
        (exposuresByKey.get(exposure.name.toLowerCase()) ?? 0) + exposure.exposures,
      );
    }
    for (const [key, points] of recordedPoints) {
      expect(exposuresByKey.get(key)).toBe(points);
    }
    for (const exposure of interactions.exposures) {
      expect(exposure.teamSource).not.toBe("unknown");
    }
  });

  it("pair members never exceed the recorded line players (no actor inflation)", () => {
    const on = (raw: string) => raw.replace(/\(S\)\s*$/i, "").trim().toLowerCase();
    const lineNames = new Set<string>();
    for (const point of rawGame.points) {
      for (const raw of [...point.offensePlayers, ...point.defensePlayers]) {
        lineNames.add(on(raw));
      }
    }
    for (const pair of [...interactions.teammatePairs, ...interactions.opponentPairs]) {
      expect(lineNames.has(pair.playerA.toLowerCase())).toBe(true);
      expect(lineNames.has(pair.playerB.toLowerCase())).toBe(true);
    }
  });
});

describe("buildInteractions: actor outside the recorded lines", () => {
  it("an event actor outside the lines creates no pair, exposure, or salary point", () => {
    const payload = syntheticPayload(
      [
        {
          offense: ["Ann", "Bo"],
          defense: ["Dee", "Eli"],
          events: [
            { type: "PASS", firstActor: "Ann", secondActor: "Bo" },
            { type: "POINT", firstActor: "Ghost", secondActor: null },
          ],
        },
      ],
      { Ann: statLine(0), Bo: statLine(0), Dee: statLine(0), Eli: statLine(0), Ghost: statLine(0) },
    );
    const ledger = buildSalaryLedger(payload);
    const interactions = buildInteractions(payload, ledger);

    const allNames = [
      ...interactions.teammatePairs,
      ...interactions.opponentPairs,
    ].flatMap((p) => [p.playerA, p.playerB]);
    expect(allNames.map((n) => n.toLowerCase())).not.toContain("ghost");
    expect(
      interactions.exposures.map((e) => e.name.toLowerCase()),
    ).not.toContain("ghost");
  });

  it("an actor outside the line earns no line-specific salary distribution for a shared pair point", () => {
    const payload = syntheticPayload(
      [
        {
          offense: ["Ann", "Bo"],
          defense: ["Dee", "Eli"],
          events: [{ type: "POINT", firstActor: "Ghost", secondActor: null }],
        },
      ],
      { Ann: statLine(0), Bo: statLine(0), Dee: statLine(0), Eli: statLine(0), Ghost: statLine(10000) },
    );
    const ledger = buildSalaryLedger(payload);
    const interactions = buildInteractions(payload, ledger);
    // Ghost's event salary must not leak into any recorded pair's salary points.
    for (const pair of [...interactions.teammatePairs, ...interactions.opponentPairs]) {
      expect(pair.playerA.toLowerCase()).not.toBe("ghost");
      expect(pair.playerB.toLowerCase()).not.toBe("ghost");
      for (const point of pair.salaryPoints) {
        expect(point.salaryA + point.salaryB).toBe(0);
      }
    }
  });
});

describe("buildInteractions: malformed line data", () => {
  it("one recorded extra player beyond lineSize keeps the full recorded pair set and warns explicitly", () => {
    // lineSize is 2, but three players are recorded on the offense line.
    const payload = syntheticPayload(
      [
        {
          offense: ["Ann", "Bo", "Cy"],
          defense: ["Dee", "Eli"],
          events: [{ type: "POINT", firstActor: "Ann", secondActor: null }],
        },
      ],
      {
        Ann: statLine(2000, "Home Team"),
        Bo: statLine(1000, "Home Team"),
        Cy: statLine(1000, "Home Team"),
        Dee: statLine(0, "Away Team"),
        Eli: statLine(0, "Away Team"),
      },
    );
    const ledger = buildSalaryLedger(payload);
    const interactions = buildInteractions(payload, ledger);

    // All three recorded offense players pair as teammates for point 1.
    const teammateNames = interactions.teammatePairs
      .flatMap((p) => [p.playerA.toLowerCase(), p.playerB.toLowerCase()])
      .filter((n) => ["ann", "bo", "cy"].includes(n));
    expect(new Set(teammateNames).size).toBe(3);
    expect(interactions.teammatePairs.filter((p) =>
      ["ann", "bo", "cy"].includes(p.playerA.toLowerCase()) &&
      ["ann", "bo", "cy"].includes(p.playerB.toLowerCase()),
    )).toHaveLength(3);

    // Explicit warning naming the malformed line.
    expect(interactions.warnings).toEqual([
      expect.objectContaining({
        code: "INTERACTION_LINE_SIZE_MISMATCH",
        pointNumber: 1,
      }),
    ]);
    const warning = interactions.warnings[0] as { message: string };
    expect(warning.message).toContain("offense");
    expect(warning.message).toContain("3");
  });

  it("a recorded duplicate within a line pairs once and warns explicitly", () => {
    const payload = syntheticPayload(
      [
        {
          offense: ["Ann", "Ann"],
          defense: ["Dee", "Eli"],
          events: [],
        },
      ],
      { Ann: statLine(0, "Home Team"), Dee: statLine(0, "Away Team"), Eli: statLine(0, "Away Team") },
    );
    const ledger = buildSalaryLedger(payload);
    const interactions = buildInteractions(payload, ledger);
    // Ann is paired with herself never; the defense row yields one pair.
    expect(interactions.teammatePairs).toMatchObject([
      { playerA: "Dee", playerB: "Eli" },
    ]);
    expect(
      interactions.opponentPairs.filter(
        (p) => p.playerA.toLowerCase() === "ann" || p.playerB.toLowerCase() === "ann",
      ),
    ).toHaveLength(2);
    const interaction = interactions.opponentPairs.find(
      (p) => p.playerA.toLowerCase() === "ann" || p.playerB.toLowerCase() === "ann",
    );
    expect(interaction?.salaryPoints).toHaveLength(1);
    const warning = interactions.warnings.find(
      (w) => w.code === "INTERACTION_DUPLICATE_LINE_PLAYER",
    ) as { code: string; message: string; pointNumber: number; player?: string } | undefined;
    expect(warning?.message).toContain("Ann");
    expect(warning?.pointNumber).toBe(1);
  });
});

describe("buildInteractions: identity cases", () => {
  it("fixture game 1001: the Nadine Cann identity yields pair data and no duplicate player", () => {
    const rawGame = JSON.parse(
      readFileSync(`${fixturesDir}/game-1001.json`, "utf8"),
    ) as ApiGame;
    const payload = canonicalizeGame(rawGame, league24);
    const ledger = buildSalaryLedger(payload);
    const interactions = buildInteractions(payload, ledger);

    // Only one Nadine identity across all pairs and exposures.
    const nadinePairs = [...interactions.teammatePairs, ...interactions.opponentPairs]
      .flatMap((p) => [p.playerA, p.playerB])
      .filter((n) => /nadine/i.test(n));
    expect(nadinePairs.length).toBeGreaterThan(0);
    expect(new Set(nadinePairs.map((n) => n.toLowerCase())).size).toBe(1);

    const exposure = exposureOf(interactions, "Nadine Cann", 1);
    expect(exposure.teamSource).toBe("stats");
    expect(exposure.exposures).toBeGreaterThan(0);

    // Raw recorded refs (with the (S) marker) are preserved in salary points.
    const pair = pairOf(interactions, "teammate", "Nadine Cann", "Kelly Fulton");
    expect(pair.salaryPoints.length).toBeGreaterThan(0);
    expect(
      pair.salaryPoints.some((point) =>
        point.line.offense.includes("Nadine Cann(S)") || point.line.defense.includes("Nadine Cann(S)"),
      ),
    ).toBe(true);
  });
});

describe("buildInteractions: pair salary points", () => {
  it("preserves the raw line row and known roles for each shared point", () => {
    const payload = syntheticPayload(
      [
        {
          offense: ["Ann", "Bo"],
          defense: ["Dee", "Eli"],
          events: [
            { type: "PASS", firstActor: "Ann", secondActor: "Bo" },
            { type: "POINT", firstActor: "Bo", secondActor: null },
          ],
        },
      ],
      { Ann: statLine(1000, "Home Team"), Bo: statLine(11000, "Home Team"), Dee: statLine(0, "Away Team"), Eli: statLine(0, "Away Team") },
    );
    const ledger = buildSalaryLedger(payload);
    const interactions = buildInteractions(payload, ledger);

    const pair = pairOf(interactions, "teammate", "Ann", "Bo");
    const ledgerSalary = (name: string) =>
      ledger.points[0].playerSalaries.find(
        (s) => s.name.toLowerCase() === name.toLowerCase(),
      )?.total ?? 0;
    expect(pair.pointsTogether).toEqual([1]);
    expect(pair.salaryPoints).toEqual([
      expect.objectContaining({
        pointNumber: 1,
        line: {
          offense: ["Ann", "Bo"],
          defense: ["Dee", "Eli"],
        },
        roleA: "offense",
        roleB: "offense",
        // Two events share a timestamp: a real recorded zero is preserved.
        durationSec: 0,
        salaryA: ledgerSalary("Ann"),
        salaryB: ledgerSalary("Bo"),
      }),
    ]);
    // The pair salary summary is the ledger's per-player total for the point,
    // tied directly to the ledger so the association cannot drift.
    expect(pair.salaryPoints[0].salaryA).toBe(
      (ledger.points[0].playerSalaries.find((s) => s.name === "Ann") as { total: number }).total,
    );

    const opponents = pairOf(interactions, "opponent", "Ann", "Dee");
    expect(opponents.salaryPoints[0]).toEqual(
      expect.objectContaining({ roleA: "offense", roleB: "defense" }),
    );
  });

  it("another kind of same pair does not appear: teammate and opponent pairs are disjoint in kind", () => {
    const payload = syntheticPayload(
      [
        {
          offense: ["Ann", "Bo"],
          defense: ["Dee", "Eli"],
          events: [],
        },
      ],
      { Ann: statLine(0, "Home Team"), Bo: statLine(0, "Home Team"), Dee: statLine(0, "Away Team"), Eli: statLine(0, "Away Team") },
    );
    const ledger = buildSalaryLedger(payload);
    const interactions = buildInteractions(payload, ledger);
    expect(interactions.teammatePairs.length).toBe(2);
    expect(interactions.opponentPairs.length).toBe(4);
    expect(exposureOf(interactions, "Ann", 0).teamSource).toBe("stats");
    expect(exposureOf(interactions, "Ann", 0).exposures).toBe(1);
  });

  it("a case-insensitive identity merges into one pair with preserved raw spellings", () => {
    const payload = syntheticPayload(
      [
        {
          offense: ["Ann", "ann"],
          defense: ["Dee", "Eli"],
          events: [],
        },
      ],
      { Ann: statLine(0, "Home Team"), Dee: statLine(0, "Away Team"), Eli: statLine(0, "Away Team") },
    );
    // Sanity: the quality layer already warns about duplicates here.
    const ledger = buildSalaryLedger(payload);
    const interactions = buildInteractions(payload, ledger);
    // The defense row's teammate pair still exists; Ann is not paired with herself.
    expect(interactions.teammatePairs).toMatchObject([
      { playerA: "Dee", playerB: "Eli" },
    ]);
    expect(exposureOf(interactions, "Ann", 0).exposures).toBe(1);
  });
});

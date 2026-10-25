import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { canonicalizeGame } from "../src/data/normalize.js";
import {
  buildSalaryLedger,
  pairSalary,
} from "../src/engine/salary.js";
import type {
  ApiGame,
  ApiPoint,
  ApiStatLine,
  GamePayload,
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
    league_id: 24,
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
  return canonicalizeGame(rawGame, league24);
}

function salariesFor(
  ledger: ReturnType<typeof buildSalaryLedger>,
  pointNumber: number,
  name: string,
) {
  const point = ledger.points.find((p) => p.pointNumber === pointNumber);
  expect(point).toBeDefined();
  const player = point?.playerSalaries.find(
    (s) => s.name.toLowerCase() === name.toLowerCase(),
  );
  expect(player).toBeDefined();
  return player as NonNullable<typeof player>;
}

function totalFor(
  ledger: ReturnType<typeof buildSalaryLedger>,
  name: string,
): number {
  const total = ledger.totals.find((t) => t.name.toLowerCase() === name.toLowerCase());
  expect(total).toBeDefined();
  return (total as { total: number }).total;
}

function salaryWarnings(
  ledger: ReturnType<typeof buildSalaryLedger>,
): typeof ledger.warnings {
  return ledger.warnings.filter((w) =>
    ["SALARY_RECONCILIATION_MISMATCH", "SALARY_UNKNOWN_PLAYER", "UNMATCHED_DROP", "SALARY_MISSING_EVENT_ACTOR"].includes(w.code),
  );
}

describe("buildSalaryLedger: synthetic points", () => {
  it("an ordinary PASS with receiver yields +500 completion and +500 catch", () => {
    const payload = syntheticPayload(
      [
        {
          offense: ["Ann"],
          defense: ["Bea"],
          events: [
            { type: "PASS", firstActor: "Ann", secondActor: "Bea" },
            { type: "PASS", firstActor: "Bea", secondActor: "Ann" },
          ],
        },
      ],
      { Ann: statLine(1000), Bea: statLine(1000) },
    );
    const ledger = buildSalaryLedger(payload);
    expect(salariesFor(ledger, 1, "Ann").components).toEqual([
      { type: "SALARY_RULE", ruleName: "COMPLETION", amount: 500, eventIndex: 0, actor: "Ann" },
      { type: "SALARY_RULE", ruleName: "CATCH", amount: 500, eventIndex: 1, actor: "Ann" },
    ]);
    expect(salariesFor(ledger, 1, "Bea").components).toEqual([
      { type: "SALARY_RULE", ruleName: "CATCH", amount: 500, eventIndex: 0, actor: "Bea" },
      { type: "SALARY_RULE", ruleName: "COMPLETION", amount: 500, eventIndex: 1, actor: "Bea" },
    ]);
    expect(totalFor(ledger, "Ann")).toBe(1000);
    expect(totalFor(ledger, "Bea")).toBe(1000);
    expect(salaryWarnings(ledger)).toEqual([]);
  });

  it("the assist PASS and its previous PASS carry assist and second-assist salary, inferred from sequence", () => {
    const payload = syntheticPayload(
      [
        {
          offense: ["Ann", "Bo", "Cy"],
          defense: ["Dee", "Eli", "Fay"],
          events: [
            { type: "PASS", firstActor: "Ann", secondActor: "Bo" },
            { type: "PASS", firstActor: "Bo", secondActor: "Cy" },
            { type: "POINT", firstActor: "Cy", secondActor: null },
          ],
        },
      ],
      { Ann: statLine(9500), Bo: statLine(12000), Cy: statLine(11500), Dee: statLine(0), Eli: statLine(0), Fay: statLine(0) },
    );
    const ledger = buildSalaryLedger(payload);
    const salaries = ledger.points[0].playerSalaries;
    const byName = new Map(salaries.map((s) => [s.name, s]));
    expect(byName.get("Ann")?.components.map((c) => [c.ruleName, c.amount])).toEqual([
      ["COMPLETION", 500],
      ["SECOND_ASSIST", 8000],
      ["HOLD", 1000],
    ]);
    expect(byName.get("Bo")?.components.map((c) => [c.ruleName, c.amount])).toEqual([
      ["CATCH", 500],
      ["COMPLETION", 500],
      ["ASSIST", 10000],
      ["HOLD", 1000],
    ]);
    // The scoring receiver earns goal plus catch, never an extra catch bonus.
    expect(byName.get("Cy")?.components.map((c) => [c.ruleName, c.amount])).toEqual([
      ["CATCH", 500],
      ["GOAL", 10000],
      ["HOLD", 1000],
    ]);
    expect(totalFor(ledger, "Ann")).toBe(9500);
    expect(totalFor(ledger, "Bo")).toBe(12000);
    expect(totalFor(ledger, "Cy")).toBe(11500);
    // Defensive-line players get no line salary when the offense scores.
    for (const defender of ["Dee", "Eli", "Fay"]) {
      expect(totalFor(ledger, defender)).toBe(0);
    }
    expect(salaryWarnings(ledger)).toEqual([]);
  });

  it("a dropped pass earns no completion/catch, only -1,000 throw-drop and -4,000 drop", () => {
    const payload = syntheticPayload(
      [
        {
          offense: ["Ann", "Bo", "Cy", "Dae"],
          defense: ["Dee", "Eli", "Fay"],
          events: [
            { type: "PASS", firstActor: "Ann", secondActor: "Bo" },
            { type: "DROP", firstActor: "Bo", secondActor: null },
            { type: "PASS", firstActor: "Bo", secondActor: "Cy" },
            { type: "PASS", firstActor: "Cy", secondActor: "Dae" },
            { type: "POINT", firstActor: "Dae", secondActor: null },
          ],
        },
      ],
      { Ann: statLine(0), Bo: statLine(5500), Cy: statLine(12000), Dae: statLine(11500), Dee: statLine(0), Eli: statLine(0), Fay: statLine(0) },
    );
    const ledger = buildSalaryLedger(payload);
    expect(salariesFor(ledger, 1, "Ann").components.map((c) => [c.ruleName, c.amount])).toEqual([
      ["THREW_DROP", -1000],
      ["HOLD", 1000],
    ]);
    // The dropper earns no catch for the pass they dropped.
    expect(salariesFor(ledger, 1, "Bo").components.map((c) => [c.ruleName, c.amount])).toEqual([
      ["DROP", -4000],
      ["COMPLETION", 500],
      ["SECOND_ASSIST", 8000],
      ["HOLD", 1000],
    ]);
    expect(totalFor(ledger, "Ann")).toBe(0);
    expect(totalFor(ledger, "Bo")).toBe(5500);
    expect(salaryWarnings(ledger)).toEqual([]);
  });

  it("a POINT on the offensive line yields +10,000 goal and +1,000 hold per offensive-line player", () => {
    const payload = syntheticPayload(
      [
        {
          offense: ["Ann", "Bo"],
          defense: ["Dee", "Eli"],
          events: [{ type: "POINT", firstActor: "Ann", secondActor: null }],
        },
      ],
      { Ann: statLine(11000), Bo: statLine(1000), Dee: statLine(0), Eli: statLine(0) },
    );
    const ledger = buildSalaryLedger(payload);
    expect(totalFor(ledger, "Ann")).toBe(11000);
    expect(totalFor(ledger, "Bo")).toBe(1000);
    expect(totalFor(ledger, "Dee")).toBe(0);
    expect(totalFor(ledger, "Eli")).toBe(0);
    expect(salaryWarnings(ledger)).toEqual([]);
  });

  it("a POINT on the defensive line yields +10,000 goal and +2,000 break per defensive-line player", () => {
    const payload = syntheticPayload(
      [
        {
          offense: ["Ann", "Bo"],
          defense: ["Dee", "Eli"],
          events: [{ type: "POINT", firstActor: "Eli", secondActor: null }],
        },
      ],
      { Ann: statLine(0), Bo: statLine(0), Dee: statLine(2000), Eli: statLine(12000) },
    );
    const ledger = buildSalaryLedger(payload);
    expect(totalFor(ledger, "Ann")).toBe(0);
    expect(totalFor(ledger, "Bo")).toBe(0);
    expect(totalFor(ledger, "Dee")).toBe(2000);
    expect(totalFor(ledger, "Eli")).toBe(12000);
    expect(salaryWarnings(ledger)).toEqual([]);
  });

  it("a scorer outside both recorded lines earns event salary but no line salary", () => {
    const payload = syntheticPayload(
      [
        {
          offense: ["Bo"],
          defense: ["Dee"],
          events: [
            { type: "PASS", firstActor: "Bo", secondActor: "Ghost" },
            { type: "POINT", firstActor: "Ghost", secondActor: null },
          ],
        },
      ],
      { Bo: statLine(10500), Ghost: statLine(10500), Dee: statLine(0) },
    );
    const ledger = buildSalaryLedger(payload);
    // Bo is the assist thrower: completion 500 + assist 10000.
    expect(totalFor(ledger, "Bo")).toBe(10500);
    // Ghost is not on either line: catch 500 + goal 10000, no hold/break.
    expect(totalFor(ledger, "Ghost")).toBe(10500);
    expect(salariesFor(ledger, 1, "Ghost").components.map((c) => [c.ruleName, c.amount])).toEqual([
      ["CATCH", 500],
      ["GOAL", 10000],
    ]);
    expect(ledger.points[0].playerSalaries.every((s) => !s.components.some((c) => c.ruleName === "HOLD" || c.ruleName === "BREAK"))).toBe(true);
    expect(salaryWarnings(ledger)).toEqual([]);
  });

  it("DEFENSE yields +8,000 for the first actor", () => {
    const payload = syntheticPayload(
      [
        {
          offense: ["Bo"],
          defense: ["Zed"],
          events: [{ type: "DEFENSE", firstActor: "Zed", secondActor: null }],
        },
      ],
      { Bo: statLine(0), Zed: statLine(8000) },
    );
    const ledger = buildSalaryLedger(payload);
    expect(salariesFor(ledger, 1, "Zed").components).toEqual([
      { type: "SALARY_RULE", ruleName: "DEFENSE", amount: 8000, eventIndex: 0, actor: "Zed" },
    ]);
    expect(totalFor(ledger, "Zed")).toBe(8000);
    expect(salaryWarnings(ledger)).toEqual([]);
  });

  it("a Callahan earns only ordinary DEFENSE plus POINT salary, no special bonus", () => {
    const payload = syntheticPayload(
      [
        {
          offense: ["Ann", "Bo"],
          defense: ["Zed", "Dee"],
          events: [
            { type: "DEFENSE", firstActor: "Zed", secondActor: null },
            { type: "POINT", firstActor: "Zed", secondActor: null },
          ],
        },
      ],
      { Ann: statLine(0), Bo: statLine(0), Zed: statLine(20000), Dee: statLine(2000) },
    );
    const ledger = buildSalaryLedger(payload);
    expect(salariesFor(ledger, 1, "Zed").components.map((c) => [c.ruleName, c.amount])).toEqual([
      ["DEFENSE", 8000],
      ["GOAL", 10000],
      ["BREAK", 2000],
    ]);
    expect(totalFor(ledger, "Zed")).toBe(20000);
    expect(totalFor(ledger, "Dee")).toBe(2000);
    expect(salaryWarnings(ledger)).toEqual([]);
  });

  it("THROWAWAY is -5,000", () => {
    const payload = syntheticPayload(
      [
        {
          offense: ["Bo"],
          defense: ["Zed"],
          events: [{ type: "THROWAWAY", firstActor: "Bo", secondActor: null }],
        },
      ],
      { Bo: statLine(-5000), Zed: statLine(0) },
    );
    const ledger = buildSalaryLedger(payload);
    expect(salariesFor(ledger, 1, "Bo").components).toEqual([
      { type: "SALARY_RULE", ruleName: "THROWAWAY", amount: -5000, eventIndex: 0, actor: "Bo" },
    ]);
    expect(totalFor(ledger, "Bo")).toBe(-5000);
    expect(salaryWarnings(ledger)).toEqual([]);
  });

  it("PULL contributes no salary", () => {
    const payload = syntheticPayload(
      [
        {
          offense: ["Ann", "Bo"],
          defense: ["Zed", "Dee"],
          events: [
            { type: "PULL", firstActor: "Zed", secondActor: null },
            { type: "PASS", firstActor: "Ann", secondActor: "Bo" },
            { type: "PASS", firstActor: "Bo", secondActor: "Ann" },
          ],
        },
      ],
      { Ann: statLine(1000), Bo: statLine(1000), Zed: statLine(0), Dee: statLine(0) },
    );
    const ledger = buildSalaryLedger(payload);
    const rules = ledger.points[0].playerSalaries.flatMap((s) => s.components.map((c) => c.ruleName));
    expect(rules).not.toContain("PULL");
    expect(totalFor(ledger, "Zed")).toBe(0);
    expect(totalFor(ledger, "Ann")).toBe(1000);
    expect(totalFor(ledger, "Bo")).toBe(1000);
    expect(salaryWarnings(ledger)).toEqual([]);
  });

  it("two PASSes immediately before a POINT without two consecutive PASSes produce no second assist", () => {
    const payload = syntheticPayload(
      [
        {
          offense: ["Ann", "Bo"],
          defense: ["Dee"],
          events: [
            { type: "DROP", firstActor: "Ann", secondActor: null },
            { type: "PASS", firstActor: "Bo", secondActor: "Ann" },
          ],
        },
      ],
      { Ann: statLine(500), Bo: statLine(500), Dee: statLine(0) },
    );
    const ledger = buildSalaryLedger(payload);
    const rules = ledger.points[0].playerSalaries.flatMap((s) => s.components.map((c) => c.ruleName));
    expect(rules).not.toContain("SECOND_ASSIST");
    expect(salaryWarnings(ledger)).toEqual([expect.objectContaining({ code: "UNMATCHED_DROP" })]);
  });
});

describe("buildSalaryLedger: reconciliation warnings", () => {
  it("a derived total that disagrees with API pay surfaces an explicit warning without repair", () => {
    const payload = syntheticPayload(
      [
        {
          offense: ["Ann"],
          defense: ["Dee"],
          events: [{ type: "POINT", firstActor: "Ann", secondActor: null }],
        },
      ],
      { Ann: statLine(11001), Dee: statLine(0) },
    );
    const ledger = buildSalaryLedger(payload);
    expect(totalFor(ledger, "Ann")).toBe(11000);
    expect(ledger.warnings.some((w) =>
      w.code === "SALARY_RECONCILIATION_MISMATCH" &&
      w.player === "Ann" &&
      w.message.includes("11000") && w.message.includes("11001"),
    )).toBe(true);
  });

  it("an earning identity with no stats row surfaces an explicit warning", () => {
    const payload = syntheticPayload(
      [
        {
          offense: ["Bo"],
          defense: [],
          events: [
            { type: "PASS", firstActor: "Bo", secondActor: "Spook" },
          ],
        },
      ],
      { Bo: statLine(500) },
    );
    const ledger = buildSalaryLedger(payload);
    expect(ledger.warnings.some((w) => w.code === "SALARY_UNKNOWN_PLAYER" && w.player === "Spook")).toBe(true);
  });
});

describe("buildSalaryLedger: fixture reconciliation", () => {
  for (const gameId of [1000, 1001]) {
    it(`game ${gameId}: derived totals exactly match API pay for every player`, () => {
      const rawGame = JSON.parse(
        readFileSync(`${fixturesDir}/game-${gameId}.json`, "utf8"),
      ) as ApiGame;
      const payload = canonicalizeGame(rawGame, league24);
      const before = JSON.stringify(payload);
      const ledger = buildSalaryLedger(payload);
      expect(JSON.stringify(payload)).toBe(before);

      expect(ledger.totals.length).toBe(Object.keys(rawGame.stats).length);
      for (const [raw, stat] of Object.entries(rawGame.stats)) {
        const name = raw.replace(/\(S\)\s*$/i, "").trim();
        expect(totalFor(ledger, name)).toBe(stat.pay);
      }
      expect(ledger.warnings).toEqual([]);
    });
  }
});

describe("pairSalary", () => {
  it("sums each player's salary over the given paired points, by case-insensitive identity", () => {
    const payload = syntheticPayload(
      [
        {
          offense: ["Ann", "Bo", "Cy"],
          defense: ["Dee", "Eli", "Fay"],
          events: [
            { type: "PASS", firstActor: "Ann", secondActor: "Bo" },
            { type: "PASS", firstActor: "Bo", secondActor: "Cy" },
            { type: "POINT", firstActor: "Cy", secondActor: null },
          ],
        },
        {
          offense: ["Ann", "Bo", "Cy"],
          defense: ["Dee", "Eli", "Fay"],
          events: [{ type: "POINT", firstActor: "Bo", secondActor: null }],
        },
      ],
      { Ann: statLine(10500), Bo: statLine(23000), Cy: statLine(12500), Dee: statLine(0), Eli: statLine(0), Fay: statLine(0) },
    );
    const ledger = buildSalaryLedger(payload);
    // Point 1: Ann 9500, Bo 12000. Point 2: Ann HOLD 1000, Bo GOAL+HOLD 11000.
    expect(pairSalary(ledger, new Set([1]), "Ann", "Bo")).toEqual({ a: 9500, b: 12000 });
    expect(pairSalary(ledger, new Set([1, 2]), "ann", "bo")).toEqual({ a: 10500, b: 23000 });
    expect(pairSalary(ledger, new Set([2]), "Cy", "Bo")).toEqual({ a: 1000, b: 11000 });
  });
});


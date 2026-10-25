import { describe, expect, it } from "vitest";
import type { Response as FetchResponse } from "undici-types";
import game1000 from "./fixtures/captures/game-1000.json";
import games24 from "./fixtures/captures/games-24.json";
import leaguesFixture from "./fixtures/captures/leagues.json";
import teams24 from "./fixtures/captures/teams-24.json";
import { createParityApiSource } from "../src/data/api.js";
import { SourceError } from "../src/data/source.js";

type ApiGame = typeof games24[number];

type RecordedCall = { method: string; path: string };

/**
 * Build a fetch-like function serving fixture data by path. Every request is
 * recorded so tests can assert endpoints were called (and that no /schedule /
 * /export or non-GET request ever happens).
 */
function fixtureFetch(routes: Record<string, unknown>): {
  fetchLike: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchLike = async (input: URL | string, init?: RequestInit): Promise<FetchResponse> => {
    const url = new URL(String(input));
    const path = url.pathname + (url.search || "");
    calls.push({ method: init?.method ?? "GET", path });
    const body = routes[path];
    if (body === undefined) {
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    }) as FetchResponse;
  };
  // The source must only ever issue GETs through init-free calls; keep the
  // signature type-compatible with the real fetch it replaces.
  return { fetchLike: fetchLike as unknown as typeof fetch, calls };
}

function apiSource() {
  const { fetchLike, calls } = fixtureFetch({
    "/api/leagues": leaguesFixture,
    "/api/24/teams": teams24,
    "/api/24/weeks": [],
    "/api/24/games": games24,
    "/api/24/games?includePoints=true": games24,
    "/api/24/games/1000": game1000,
  });
  return { source: createParityApiSource({ baseUrl: "https://parity.example", fetchLike }), calls };
}

const V1_LEAGUE_ID = 9; // 2018/2019 Session 2 (unique in the fixture)
const V1_LEAGUE_NAME = "2014 Spring"; // unique name, id 1

describe("ParityApiSource", () => {
  it("listSupportedLeagues returns only supported v2 leagues", async () => {
    const { source, calls } = apiSource();
    const leagues = await source.listSupportedLeagues();
    expect(leagues.length).toBeGreaterThan(0);
    expect(leagues.every((l) => l.statValues === "v2")).toBe(true);
    expect(leagues.map((l) => l.id)).not.toContain(V1_LEAGUE_ID);
    expect(calls).toEqual([{ method: "GET", path: "/api/leagues" }]);
  });

  it("direct v1 league by id rejects with UNSUPPORTED_LEAGUE_VERSION and fetches nothing else", async () => {
    const { source, calls } = apiSource();
    await expect(source.getGame({ id: V1_LEAGUE_ID }, "1000")).rejects.toMatchObject({
      code: "UNSUPPORTED_LEAGUE_VERSION",
    });
    await expect(source.listGames({ id: V1_LEAGUE_ID })).rejects.toMatchObject({
      code: "UNSUPPORTED_LEAGUE_VERSION",
    });
    expect(calls.map((c) => c.path)).toEqual(["/api/leagues"]);
  });

  it("direct v1 league by name rejects with UNSUPPORTED_LEAGUE_VERSION", async () => {
    const { source } = apiSource();
    await expect(source.getGame({ name: V1_LEAGUE_NAME }, "1000")).rejects.toBeInstanceOf(SourceError);
    await expect(source.getGame({ name: V1_LEAGUE_NAME }, "1000")).rejects.toMatchObject({
      code: "UNSUPPORTED_LEAGUE_VERSION",
    });
  });

  it("v2 league by id and by name resolve to the full registry", async () => {
    const { source } = apiSource();
    const byId = await source.getGame({ id: 24 }, "1000");
    expect(byId.league.id).toBe(24);
    expect(byId.league.statValues).toBe("v2");

    const byName = await source.getGame({ name: "Winter Indoor Parity 2026" }, "1000");
    expect(byName.league.id).toBe(24);
  });

  it("getGame returns a canonical game payload, not a shell wrapper", async () => {
    const { source } = apiSource();
    const payload = await source.getGame({ id: 24 }, "1000");
    expect(payload.schemaVersion).toBe(1);
    expect(String(payload.game.id)).toBe("1000");
    expect(payload.game.points.length).toBeGreaterThan(0);
    expect(payload.stats.length).toBeGreaterThan(0);
    expect(Array.isArray(payload.quality.warnings)).toBe(true);
  });

  it("listGames hits the plain games endpoint and includePoints for date filtering", async () => {
    const { source, calls } = apiSource();
    const plain = await source.listGames({ id: 24 });
    expect(plain.length).toBe(games24.length);
    expect(plain.every((g: ApiGame) => g.league_id === 24)).toBe(true);

    const dated = await source.listGames({ id: 24 }, { date: "3/15/2026" });
    expect(Array.isArray(dated)).toBe(true);

    const withPoints = await source.listGames({ id: 24 }, { includePoints: true });
    expect(withPoints.length).toBe(games24.length);

    const paths = calls.map((c) => c.path);
    expect(paths).toContain("/api/24/games");
    expect(paths).toContain("/api/24/games?includePoints=true");
  });

  it("exposes teams and weeks endpoints for the resolved league", async () => {
    const { source, calls } = apiSource();
    await source.getTeams({ id: 24 });
    await source.getWeeks({ id: 24 });
    const paths = calls.map((c) => c.path);
    expect(paths).toContain("/api/24/teams");
    expect(paths).toContain("/api/24/weeks");
  });

  it("never calls /schedule, /export, or non-GET methods", async () => {
    const { source, calls } = apiSource();
    await source.listSupportedLeagues();
    await source.getTeams({ id: 24 });
    await source.getWeeks({ id: 24 });
    await source.listGames({ id: 24 });
    await source.listGames({ id: 24 }, { date: "3/15/2026" });
    await source.getGame({ id: 24 }, "1000");

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(calls.every((c) => !/schedule|export/.test(c.path))).toBe(true);
  });
});

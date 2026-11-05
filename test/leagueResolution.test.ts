import { describe, expect, it } from "vitest";
import type { Response as FetchResponse } from "undici-types";
import leaguesFixture from "./fixtures/captures/leagues.json";
import { createParityApiSource } from "../src/data/api.js";
import type { SupportedLeague } from "../src/domain/types.js";

type RecordedCall = { method: string; path: string };

/**
 * Build a fetch-like function serving fixture data by path. Every request is
 * recorded so tests can assert which league endpoint was actually used.
 */
function fixtureFetch(routes: Record<string, unknown>): {
  fetchLike: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchLike = async (
    input: URL | string,
    init?: RequestInit,
  ): Promise<FetchResponse> => {
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
  return { fetchLike: fetchLike as unknown as typeof fetch, calls };
}

/** League 22 and league 21 share an identical name in the API registry. */
const DUPLICATE_NAME = "Winter Indoor 2024/2025 Winter Sunday Parity League";

function apiSource(overrides: Record<string, unknown> = {}) {
  const { fetchLike, calls } = fixtureFetch({
    "/api/leagues": leaguesFixture,
    "/api/21/games": [],
    "/api/22/games": [],
    "/api/24/games": [],
    ...overrides,
  });
  return {
    source: createParityApiSource({ baseUrl: "https://parity.example", fetchLike }),
    calls,
  };
}

describe("league id resolution", () => {
  it("resolves a numeric string reference by id, not by name", async () => {
    const { source, calls } = apiSource();
    const games = await source.listGames({ name: "22" } as never);
    expect(games).toEqual([]);
    expect(calls.map((call) => call.path)).toContain("/api/22/games");
    expect(calls.map((call) => call.path)).not.toContain("/api/21/games");
  });

  it("resolves a numeric string reference for a game by id", async () => {
    const { source, calls } = apiSource({
      "/api/22/games/926": { id: "926", league_id: 22 },
    });
    await expect(source.getGame({ name: "22" } as never, "926")).rejects.toBeTruthy();
    expect(calls.map((call) => call.path)).toContain("/api/22/games/926");
  });

  it("still resolves a non-numeric name reference by exact name", async () => {
    const { source, calls } = apiSource();
    await source.listGames({ name: "Winter Indoor Parity 2026" });
    expect(calls.map((call) => call.path)).toContain("/api/24/games");
  });
});

describe("duplicate league names", () => {
  it("reports an actionable ambiguity error listing every matching id", async () => {
    const { source } = apiSource();
    await expect(source.listGames({ name: DUPLICATE_NAME })).rejects.toMatchObject({
      code: "LEAGUE_NOT_FOUND",
      message: expect.stringContaining("21"),
    });
    await expect(source.listGames({ name: DUPLICATE_NAME })).rejects.toMatchObject({
      message: expect.stringContaining("22"),
    });
  });

  it("keeps both duplicate-named leagues reachable by id", async () => {
    const { source } = apiSource();
    const leagues = await source.listSupportedLeagues();
    const duplicates = leagues.filter((league) => league.name === DUPLICATE_NAME);
    expect(duplicates.map((league) => league.id).sort((a, b) => a - b)).toEqual([21, 22]);
  });
});

describe("listSupportedLeagues disambiguation", () => {
  it("exposes the Zuluru link for each league so duplicates are distinguishable", async () => {
    const { source } = apiSource();
    const leagues = await source.listSupportedLeagues();
    const league22 = leagues.find((league) => league.id === 22);
    expect(league22).toBeDefined();
    expect(league22?.zuluru).toBe(
      "https://www.ocua.ca/zuluru/divisions/view?division=1641",
    );
    const league21 = leagues.find((league) => league.id === 21);
    expect(league21?.zuluru).toBe(
      "https://www.ocua.ca/zuluru/divisions/view?division=1631",
    );
  });

  it("exposes a display label that is unique per league id", async () => {
    const { source } = apiSource();
    const leagues = (await source.listSupportedLeagues()) as Array<
      SupportedLeague & { displayName?: string }
    >;
    const labels = leagues.map((league) => league.displayName ?? league.name);
    expect(new Set(labels).size).toBe(leagues.length);
  });
});

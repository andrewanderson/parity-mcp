import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createParityServer } from "../src/server.js";
import type { ApiGame, SupportedLeague } from "../src/domain/types.js";
import type { DataSource, ListGamesOptions } from "../src/data/source.js";
import { canonicalizeGame } from "../src/data/normalize.js";
import game1000 from "./fixtures/captures/game-1000.json";
import games24Fixture from "./fixtures/captures/games-24.json";
import leaguesFixture from "./fixtures/captures/leagues.json";

const LEAGUE_ID = 24;
const league24 = {
  ...leaguesFixture.find((l) => l.id === LEAGUE_ID),
  statValues: "v2",
} as SupportedLeague;

/**
 * A stub `DataSource` backed only by captured fixture files, no network.
 * Mirrors the real source's behavior for the pieces the server relies on:
 * only `v2` leagues are supported, `week` filtering is server-side, and
 * `date` filtering goes through `ListGamesOptions.date`.
 */
class StubSource implements DataSource {
  readonly calledListGamesOptions: ListGamesOptions[] = [];

  async listSupportedLeagues(): Promise<SupportedLeague[]> {
    return leaguesFixture
      .filter((l) => l.statValues === "v2")
      .map((l) => ({ ...l, statValues: "v2" }) as SupportedLeague);
  }

  async listGames(
    leagueRef: { id: number } | { name: string },
    options?: ListGamesOptions,
  ): Promise<ApiGame[]> {
    const id = "id" in leagueRef ? leagueRef.id : undefined;
    const name = "name" in leagueRef ? leagueRef.name : undefined;
    const matched = leaguesFixture.find(
      (l) => l.id === id || l.name === name,
    );
    if (matched === undefined || matched.statValues !== "v2") {
      throw new Error(`unsupported league ${String(id ?? name)}`);
    }
    if (matched.id !== LEAGUE_ID) {
      return [];
    }
    this.calledListGamesOptions.push(options ?? {});
    let games = games24Fixture.map((entry) => {
      const game = entry as unknown as ApiGame;
      return {
        ...game,
        id: Number(entry.id),
        league_id: matched.id,
        homeTeam: `Home (${entry.id})`,
        awayTeam: `Away (${entry.id})`,
        homeScore: 1,
        awayScore: 0,
        homeRoster: [] as string[],
        awayRoster: [] as string[],
        points: [],
        stats: {} as ApiGame["stats"],
      };
    });
    if (options?.date !== undefined) {
      games = games.filter(
        (game) => (game as ApiGame & { date?: string }).date === options.date,
      );
    }
    return games;
  }

  async getGame(
    leagueRef: { id: number } | { name: string },
    gameId: number | string,
  ): Promise<ReturnType<typeof canonicalizeGame>> {
    const id = "id" in leagueRef ? leagueRef.id : undefined;
    const name = "name" in leagueRef ? leagueRef.name : undefined;
    const matched = leaguesFixture.find(
      (l) => l.id === id || l.name === name,
    );
    if (matched === undefined || matched.statValues !== "v2") {
      throw new Error(`unsupported league ${String(id ?? name)}`);
    }
    const raw = game1000 as unknown as { id: string | number } as Parameters<typeof canonicalizeGame>[0];
    if (String(gameId) !== String(raw.id)) {
      throw new Error(`game ${String(gameId)} not found in league ${matched.id}`);
    }
    return canonicalizeGame(raw, {
      id: matched.id,
      name: matched.name,
      statValues: "v2",
      lineSize: matched.lineSize,
      salaryCalc: matched.salaryCalc,
    } as SupportedLeague);
  }
}

const tmpDirs: string[] = [];

async function makeDataDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "parity-server-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

type CallOK = { ok: true; data: unknown };
type CallErr = { ok: false; isError: true; text: string };
type CallResult = CallOK | CallErr;

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallResult> {
  const result = await client.callTool({ name, arguments: args });
  const text =
    result.content[0]?.type === "text" ? result.content[0].text : "";
  if (result.isError === true) {
    return { ok: false, isError: true, text };
  }
  return { ok: true, data: JSON.parse(text) as unknown };
}

describe("parity MCP server tool wiring", () => {
  it("registers exactly the four expected tool names", async () => {
    const dataDir = await makeDataDir();
    const mcp = createParityServer({ source: new StubSource(), dataDir });
    const client = new Client({ name: "test-client", version: "0.0.1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await mcp.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "parity_get_game",
      "parity_get_interactions",
      "parity_list_games",
      "parity_list_leagues",
    ]);
    await client.close();
  });

  it("parity_list_leagues returns only supported v2 leagues", async () => {
    const dataDir = await makeDataDir();
    const mcp = createParityServer({ source: new StubSource(), dataDir });
    const client = new Client({ name: "test-client", version: "0.0.1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await mcp.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await call(client, "parity_list_leagues", {});
    if (!result.ok) throw new Error(result.text);
    const data = result.data as { leagues: Array<{ id: number; statValues: string }> };
    expect(data.leagues.length).toBeGreaterThan(0);
    expect(
      data.leagues.every((entry) => entry.statValues === "v2"),
    ).toBe(true);
    const v1Ids = leaguesFixture
      .filter((l) => l.statValues !== "v2")
      .map((l) => l.id);
    expect(
      data.leagues.some((entry) => v1Ids.includes(entry.id)),
    ).toBe(false);
    await client.close();
  });

  it("parity_list_games applies the week filter server-side without a league argument", async () => {
    const dataDir = await makeDataDir();
    const source = new StubSource();
    const mcp = createParityServer({ source, dataDir });
    const client = new Client({ name: "test-client", version: "0.0.1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await mcp.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await call(client, "parity_list_games", { week: 1 });
    if (!result.ok) throw new Error(result.text);
    const data = result.data as {
      games: Array<{ id: number; week: number; date: string | null }>;
    };
    expect(data.games.length).toBeGreaterThan(0);
    // Exactly the captured week-1 games, with no points payload included.
    expect(data.games.map((game) => game.id).sort()).toEqual([
      1000, 1001, 1002,
    ]);
    expect(data.games.every((game) => game.week === 1)).toBe(true);
    expect(
      data.games.every((game) => Object.hasOwn(game, "date")),
    ).toBe(true);
    expect(source.calledListGamesOptions.length).toBe(1);
    expect(source.calledListGamesOptions[0]).toEqual({});
    await client.close();
  });

  it("parity_list_games forwards date to the source and applies the week filter itself", async () => {
    const dataDir = await makeDataDir();
    const source = new StubSource();
    const mcp = createParityServer({ source, dataDir });
    const client = new Client({ name: "test-client", version: "0.0.1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await mcp.connect(serverTransport);
    await client.connect(clientTransport);
    await call(client, "parity_list_games", { week: 1, date: "2026-03-14" });
    expect(source.calledListGamesOptions).toEqual([{ date: "2026-03-14" }]);
    await client.close();
  });

  it("parity_get_game returns the canonical payload with salaryLedger, timeline, storyFacts, interactions, quality, and persists automatically", async () => {
    const dataDir = await makeDataDir();
    const mcp = createParityServer({ source: new StubSource(), dataDir });
    const client = new Client({ name: "test-client", version: "0.0.1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await mcp.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await call(client, "parity_get_game", {
      league: LEAGUE_ID,
      gameId: 1000,
    });
    if (!result.ok) throw new Error(result.text);
    const data = result.data as {
      schemaVersion: number;
      salaryLedger: unknown;
      timeline: unknown[];
      storyFacts: unknown;
      interactions: { teammatePairs: unknown[]; opponentPairs: unknown[] };
      quality: { warnings: unknown[] };
      game: { id: number };
    };
    expect(data.schemaVersion).toBe(1);
    expect(data.game.id).toBe(game1000.id);
    expect(data.salaryLedger).toBeDefined();
    expect(Array.isArray(data.timeline)).toBe(true);
    expect(data.storyFacts).toBeDefined();
    expect(Array.isArray(data.interactions.teammatePairs)).toBe(true);
    expect(Array.isArray(data.interactions.opponentPairs)).toBe(true);
    expect(Array.isArray(data.quality.warnings)).toBe(true);
    // Automatic persistence, no separate save tool call.
    const gameDataPath = path.join(dataDir, "games", "1000.json");
    expect(existsSync(gameDataPath)).toBe(true);
    const persisted = JSON.parse(await readFile(gameDataPath, "utf8")) as {
      game: { id: number };
    };
    expect(persisted.game.id).toBe(game1000.id);
    const index = JSON.parse(
      await readFile(path.join(dataDir, "index.json"), "utf8"),
    ) as { games: Record<string, { gameDataPath: string }> };
    expect(index.games["1000"].gameDataPath).toBe(
      path.join("games", "1000.json"),
    );
    await client.close();
  });

  it("parity_get_interactions returns teammatePairs and opponentPairs, not a dedicated impact payload", async () => {
    const dataDir = await makeDataDir();
    const mcp = createParityServer({ source: new StubSource(), dataDir });
    const client = new Client({ name: "test-client", version: "0.0.1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await mcp.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await call(client, "parity_get_interactions", {
      gameId: 1000,
    });
    if (!result.ok) throw new Error(result.text);
    const data = result.data as {
      teammatePairs: unknown[];
      opponentPairs: unknown[];
    };
    expect(Array.isArray(data.teammatePairs)).toBe(true);
    expect(Array.isArray(data.opponentPairs)).toBe(true);
    expect(
      Object.keys(data).filter((key) => key !== "teammatePairs" && key !== "opponentPairs"),
    ).toEqual([]);
    await client.close();
  });
});

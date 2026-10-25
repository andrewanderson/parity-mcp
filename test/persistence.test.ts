import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GamePayload, SupportedLeague } from "../src/domain/types.js";
import { canonicalizeGame } from "../src/data/normalize.js";
import { persistCanonicalGame } from "../src/data/persistence.js";
import game1000 from "./fixtures/captures/game-1000.json";
import leaguesFixture from "./fixtures/captures/leagues.json";

const league = { ...leaguesFixture[0], statValues: "v2" } as SupportedLeague;

function payload1000(): GamePayload {
  return canonicalizeGame(game1000 as unknown as Parameters<typeof canonicalizeGame>[0], league);
}

const tmpDirs: string[] = [];

async function makeDataDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "parity-persist-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("persistCanonicalGame", () => {
  it("writes the canonical payload to games/<gameId>.json and returns its path", async () => {
    const dataDir = await makeDataDir();
    const payload = payload1000();
    const result = await persistCanonicalGame(payload, dataDir);
    const gameDataPath = path.join(dataDir, "games", "1000.json");
    expect(result).toEqual({ gameDataPath });
    expect(existsSync(gameDataPath)).toBe(true);
    const written = JSON.parse(await readFile(gameDataPath, "utf8")) as GamePayload;
    expect(written).toEqual(payload);
    expect(written.game.id).toBe(game1000.id);
    expect(written.game.points.length).toBeGreaterThan(0);
  });

  it("updates index.json with a gameDataPath entry and no analysisPaths", async () => {
    const dataDir = await makeDataDir();
    await persistCanonicalGame(payload1000(), dataDir);
    const indexPath = path.join(dataDir, "index.json");
    expect(existsSync(indexPath)).toBe(true);
    const raw = JSON.parse(await readFile(indexPath, "utf8")) as {
      schemaVersion: number;
      games: Record<string, { gameId: string; gameDataPath: string; analysisPaths?: string[] }>;
    };
    expect(raw.games["1000"]).toBeDefined();
    expect(raw.games["1000"].gameDataPath).toBe(path.join("games", "1000.json"));
    expect("analysisPaths" in raw.games["1000"]).toBe(false);
  });

  it("is idempotent: repeating the save produces the same game file and index", async () => {
    const dataDir = await makeDataDir();
    const payload = payload1000();
    const first = await persistCanonicalGame(payload, dataDir);
    const second = await persistCanonicalGame(payload, dataDir);
    expect(second.gameDataPath).toBe(first.gameDataPath);
    expect(await readFile(second.gameDataPath, "utf8")).toBe(
      JSON.stringify(payload, null, 2),
    );
  });

  it("is rerun-safe: existing analysis files are never overwritten", async () => {
    const dataDir = await makeDataDir();
    const analysisDir = path.join(dataDir, "analyses");
    await mkdir(analysisDir);
    const analysisPath = path.join(analysisDir, "1000.json");
    await writeFile(analysisPath, "original analysis", "utf8");
    await persistCanonicalGame(payload1000(), dataDir);
    await persistCanonicalGame(payload1000(), dataDir);
    expect(await readFile(analysisPath, "utf8")).toBe("original analysis");
  });

  it("is save-then-index: if the index save fails, the game file is still saved intact", async () => {
    const dataDir = await makeDataDir();
    const payload = payload1000();
    // Make the index path a directory so the index write cannot succeed.
    await mkdir(path.join(dataDir, "index.json"));
    let thrown: unknown = null;
    try {
      await persistCanonicalGame(payload, dataDir);
    } catch (cause) {
      thrown = cause;
    }
    expect(thrown).not.toBeNull();
    // The game data must already be saved when the index write fails.
    const saved = JSON.parse(
      await readFile(path.join(dataDir, "games", "1000.json"), "utf8"),
    ) as GamePayload;
    expect(saved).toEqual(payload);
  });

  it("a later invocation after a failed index save re-saves the game data without losing anything", async () => {
    const dataDir = await makeDataDir();
    const payload = payload1000();
    // First run: index write fails (directory blocks it).
    await mkdir(path.join(dataDir, "index.json"));
    await expect(persistCanonicalGame(payload, dataDir)).rejects.toThrow();
    // Remove the obstruction and re-run: game file identical, index now written.
    await rm(path.join(dataDir, "index.json"), { recursive: true, force: true });
    await persistCanonicalGame(payload, dataDir);
    const saved = JSON.parse(
      await readFile(path.join(dataDir, "games", "1000.json"), "utf8"),
    ) as GamePayload;
    expect(saved).toEqual(payload);
    const index = JSON.parse(
      await readFile(path.join(dataDir, "index.json"), "utf8"),
    ) as { games: Record<string, { gameDataPath: string }> };
    expect(index.games["1000"].gameDataPath).toBe(path.join("games", "1000.json"));
  });

  it("preserves other index entries when adding a new game", async () => {
    const dataDir = await makeDataDir();
    await persistCanonicalGame(payload1000(), dataDir);
    const other = { ...payload1000(), game: { ...payload1000().game, id: 1188 } };
    await persistCanonicalGame(other, dataDir);
    const index = JSON.parse(
      await readFile(path.join(dataDir, "index.json"), "utf8"),
    ) as { games: Record<string, { gameDataPath: string }> };
    expect(Object.keys(index.games).sort()).toEqual(["1000", "1188"]);
    expect(existsSync(path.join(dataDir, "games", "1000.json"))).toBe(true);
    expect(existsSync(path.join(dataDir, "games", "1188.json"))).toBe(true);
  });
});

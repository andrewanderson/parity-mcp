import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { GamePayload } from "../domain/types.js";
import { SourceError } from "./source.js";

/** One entry in the file-based data directory index for one game. */
type IndexEntry = {
  gameId: string;
  gameDataPath: string;
  /** Curated analysis paths added by the recap skill; preserved on re-persist. */
  analysisPaths?: string[];
};

/** The in-memory shape of the persisted index. */
type GameIndex = {
  schemaVersion: 1;
  games: Record<string, IndexEntry>;
};

/** The file layout inside `dataDir` for one canonical game. */
export const INDEX_FILE = "index.json";
export const GAMES_DIR = "games";

/**
 * Persist one canonical game payload to a file-based data directory.
 *
 * Layout:
 *   <dataDir>/games/<gameId>.json  (canonical game payload)
 *   <dataDir>/index.json           (index mapping gameId -> gameDataPath)
 *
 * Ordering guarantee (save-then-index):
 *   1. Write the game payload file first, atomically (tmp file + rename).
 *   2. Only then update the index, also atomically. Index entries are merged
 *      from the existing on-disk index, never rebuilt from memory, so a
 *      failed or crashed index write loses nothing: the game file is already
 *      on disk and a later invocation re-saves identical game data and
 *      repairs the index.
 *
 * Rerun safety: this function only ever touches `games/<gameId>.json` and
 * `index.json`. It never reads or writes analysis files, so repeated
 * analyses stored alongside (e.g. `analysis/` directories) are never
 * overwritten or deleted.
 *
 * Idempotency: the same payload produces byte-identical files via stable
 * 2-space-pretty JSON formatting with deterministic key insertion order.
 */
export async function persistCanonicalGame(
  payload: GamePayload,
  dataDir: string,
): Promise<{ gameDataPath: string }> {
  const gameId = String(payload.game.id);
  if (gameId.trim() === "") {
    throw new SourceError("REQUEST_FAILED", "Game payload has no usable id.");
  }

  const gamesDir = path.join(dataDir, GAMES_DIR);
  const gameDataPath = path.join(gamesDir, `${gameId}.json`);
  const indexPath = path.join(dataDir, INDEX_FILE);

  // 1. Save the game payload atomically before touching the index.
  await mkdir(gamesDir, { recursive: true });
  await atomicWriteJson(gameDataPath, payload);

  // 2. Merge into the existing index and save it atomically. The entry is
  //    spread from what is on disk so externally curated fields (such as
  //    analysisPaths) survive a re-persist; only the ids are owned here.
  const index = await loadIndex(indexPath);
  index.games[gameId] = {
    ...(index.games[gameId] ?? {}),
    gameId,
    gameDataPath: path.join(GAMES_DIR, `${gameId}.json`),
  };
  await atomicWriteJson(indexPath, index);

  return { gameDataPath };
}

/** Read the current index from disk, tolerating a missing file. */
async function loadIndex(indexPath: string): Promise<GameIndex> {
  if (!existsSync(indexPath)) {
    return { schemaVersion: 1, games: {} };
  }
  const raw = JSON.parse(await readFile(indexPath, "utf8")) as GameIndex;
  return {
    schemaVersion: 1,
    games: raw.games ?? {},
  };
}

/**
 * Atomic JSON write in two steps:
 *   1. Write to a sibling temp file, then flush by renaming over the target.
 *      A crash mid-write leaves the previous file intact, never a truncated
 *      or corrupt JSON file.
 *   2. Remove the temp file if the write failed, so no litter is left behind.
 */
async function atomicWriteJson(
  targetPath: string,
  value: unknown,
): Promise<void> {
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(tmpPath, formatJson(value), "utf8");
    await rename(tmpPath, targetPath);
  } catch (cause) {
    await rm(tmpPath, { force: true });
    throw new SourceError(
      "REQUEST_FAILED",
      `Failed to persist JSON at ${targetPath}: ${String(cause)}`,
    );
  }
}

/** Stable JSON formatting: 2-space indent, keys in their existing insertion order. */
function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

// Fetches real data from the public parity API and writes fixtures under
// test/fixtures/captures. This is the only place network calls are made;
// unit tests must not hit the network.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE_URL = process.env.PARITY_API_BASE_URL ?? "https://parity.kevinhughes27.workers.dev";
const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures", "captures");

const LEAGUES = ["leagues"];
const SEASON = "24";
const GAMES = ["1000", "1001", "1002", "1008", "1013"];

async function fetchJson(urlPath, outName) {
  const url = `${BASE_URL}${urlPath}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}`);
  }
  const body = await res.text();
  // Validate JSON before writing.
  JSON.parse(body);
  await writeFile(path.join(OUT_DIR, outName), body.endsWith("\n") ? body : body + "\n", "utf8");
  console.log(`captured ${outName} <- ${url}`);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  for (const endpoint of LEAGUES) {
    await fetchJson(`/api/${endpoint}`, `${endpoint}.json`);
  }
  await fetchJson(`/api/${SEASON}/teams`, `teams-${SEASON}.json`);
  await fetchJson(`/api/${SEASON}/games`, `games-${SEASON}.json`);
  for (const gameId of GAMES) {
    await fetchJson(`/api/${SEASON}/games/${gameId}`, `game-${gameId}.json`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

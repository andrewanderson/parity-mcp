import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type {
  GamePayload,
  LeagueSummary,
  SupportedLeague,
} from "./domain/types.js";
import type { DataSource, LeagueRef, ListGamesOptions } from "./data/source.js";
import { SourceError } from "./data/source.js";
import { persistCanonicalGame } from "./data/persistence.js";
import { buildSalaryLedger, type SalaryLedger } from "./engine/salary.js";
import {
  buildScoreTimelineAndStoryFacts,
  type GameStoryFacts,
  type ScoreTimelineItem,
} from "./engine/timeline.js";
import {
  buildInteractions,
  type InteractionsPayload,
} from "./engine/interactions.js";

/**
 * A summary of one listed game: raw list data reduced to its identifying
 * fields, with the (potentially large) points payload always omitted.
 */
type GameSummary = {
  leagueId: number;
  id: number;
  week: number;
  status: string;
  date: string | null;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
};

/** The complete canonical payload: game payload plus every derived stage. */
export type FullGamePayload = GamePayload & {
  salaryLedger: SalaryLedger;
  timeline: ScoreTimelineItem[];
  storyFacts: GameStoryFacts;
  interactions: InteractionsPayload;
};

/** The InteractionsPayload re-exported directly, as the tool returns exactly it. */
export type { InteractionsPayload };

/**
 * Assemble the full canonical game payload by running every derived stage on
 * one canonical payload. Pure: the input payload is never mutated. The derived
 * stages run in dependency order: salary first, interactions need the ledger.
 */
export function assembleFullGame(payload: GamePayload): FullGamePayload {
  const salaryLedger = buildSalaryLedger(payload);
  const { timeline, storyFacts } = buildScoreTimelineAndStoryFacts(payload);
  const interactions = buildInteractions(payload, salaryLedger);
  return {
    ...payload,
    salaryLedger,
    timeline,
    storyFacts,
    interactions,
  };
}

/** Reduce one raw listed game to a GameSummary, keeping points out. */
function toSummary(leagueId: number, game: {
  id: number;
  week: number;
  status: string;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
}): GameSummary {
  return {
    leagueId,
    id: game.id,
    week: game.week,
    status: game.status,
    date: (game as { date?: string | null }).date ?? null,
    homeTeam: game.homeTeam,
    awayTeam: game.awayTeam,
    homeScore: game.homeScore,
    awayScore: game.awayScore,
  };
}

/** Serial tool context: the data source plus the persistence data directory. */
export type ParityServerOptions = {
  source: DataSource;
  dataDir: string;
};

/** Games of all targeted leagues, flattened into GameSummaries. */
function gamesAcrossLeagues(
  source: DataSource,
  ref: LeagueRef | undefined,
  options: ListGamesOptions,
): Promise<GameSummary[]> {
  return (async () => {
    const leagues = await source.listSupportedLeagues();
    const targets: SupportedLeague[] =
      ref === undefined
        ? leagues
        : leagues.filter((league) => leagueMatches(ref, league));
    const summaries: GameSummary[] = [];
    for (const league of targets) {
      for (const game of await source.listGames(league, options)) {
        summaries.push(toSummary(league.id, game));
      }
    }
    return summaries;
  })();
}

/** True when a LeagueRef identifies exactly this league. */
function leagueMatches(ref: LeagueRef, league: SupportedLeague): boolean {
  return "name" in ref ? ref.name === league.name : ref.id === league.id;
}

/**
 * The single supporting league for one game, by probing supported leagues.
 * Only a not-found in a league is expected during probing and only that ends
 * with the aggregated GAME_NOT_FOUND. Every other failure (a failed request,
 * an unsupported league version, a malformed response) is propagated as-is so
 * callers see the original error class, not a misleading not-found.
 */
async function gameForLeague(
  source: DataSource,
  ref: LeagueRef | undefined,
  gameId: number | string,
): Promise<{ payload: FullGamePayload; league: SupportedLeague }> {
  const leagues = await source.listSupportedLeagues();
  const targets: SupportedLeague[] =
    ref === undefined
      ? leagues
      : leagues.filter((league) => leagueMatches(ref, league));
  const leagueLabel =
    ref === undefined ? "" : ` in league ${"name" in ref ? ref.name : ref.id}`;
  let lastNotFound: SourceError | null = null;
  for (const league of targets) {
    try {
      const payload = await source.getGame(league, gameId);
      if (String(payload.game.id) !== String(gameId)) {
        throw new SourceError(
          "GAME_NOT_FOUND",
          `Game ${gameId} not found in league ${league.id}.`,
          league,
        );
      }
      return { payload: assembleFullGame(payload), league };
    } catch (cause) {
      if (isGameNotFoundError(cause)) {
        lastNotFound =
          cause instanceof SourceError
            ? cause
            : new SourceError("GAME_NOT_FOUND", String(cause instanceof Error ? cause.message : cause), league);
        continue;
      }
      // Unexpected failure probing this league: keep the original error.
      throw cause;
    }
  }
  const detail =
    lastNotFound === null
      ? "no supported league could be probed."
      : `last league probe: ${lastNotFound.message}`;
  throw new SourceError(
    "GAME_NOT_FOUND",
    `Game ${gameId} not found${leagueLabel === "" ? " in any supported league" : ""}: ${detail}`,
  );
}

/** True when a probe failure means the game is absent from that league. */
function isGameNotFoundError(cause: unknown): boolean {
  if (cause instanceof SourceError) {
    return cause.code === "GAME_NOT_FOUND";
  }
  // Sources with no SourceError type report a missing game with a plain
  // message; everything else stays a probe failure.
  return cause instanceof Error && /not found/i.test(cause.message);
}

/** A tool error result carrying the source error code and message. */
function errorResult(cause: unknown): { content: Array<{ type: "text"; text: string }>; isError: true } {
  const code =
    cause instanceof SourceError ? cause.code : "INTERNAL";
  const message = cause instanceof Error ? cause.message : String(cause);
  return {
    content: [{ type: "text", text: JSON.stringify({ error: code, message }) }],
    isError: true,
  };
}

/** JSON text content wrapping one value. */
function textResult(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

/**
 * Create the parity MCP server with exactly the four canonical tools. There
 * is no save tool: `parity_get_game` persists every assembled canonical game
 * automatically into `dataDir` via `persistCanonicalGame`.
 */
export function createParityServer(options: ParityServerOptions): McpServer {
  const { source, dataDir } = options;
  const server = new McpServer({
    name: "parity-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "parity_list_leagues",
    {
      description: "List the supported v2 parity leagues.",
      inputSchema: {},
    },
    async (): Promise<ReturnType<typeof textResult>> => {
      const leagues = await source.listSupportedLeagues();
      return textResult({ leagues: leagues satisfies LeagueSummary[] });
    },
  );

  server.registerTool(
    "parity_list_games",
    {
      description:
        "List games in supported parity leagues, optionally by league, week, and date.",
      inputSchema: {
        league: z.union([z.number().int(), z.string()]).optional(),
        week: z.number().int().optional(),
        date: z.string().optional(),
      },
    },
    async (args): Promise<ReturnType<typeof textResult> | ReturnType<typeof errorResult>> => {
      try {
        const ref = leagueRefFrom(args.league);
        const listOptions: ListGamesOptions = {};
        if (args.date !== undefined) {
          listOptions.date = args.date;
        }
        let games = await gamesAcrossLeagues(source, ref, listOptions);
        if (args.week !== undefined) {
          games = games.filter((game) => game.week === args.week);
        }
        return textResult({ games });
      } catch (cause) {
        return errorResult(cause);
      }
    },
  );

  server.registerTool(
    "parity_get_game",
    {
      description:
        "Get one canonical game payload with salary ledger, score timeline, story facts, interactions, and quality warnings; persists the game automatically.",
      inputSchema: {
        league: z.union([z.number().int(), z.string()]).optional(),
        gameId: z.union([z.number().int(), z.string()]),
      },
    },
    async (args): Promise<ReturnType<typeof textResult> | ReturnType<typeof errorResult>> => {
      try {
        const ref = leagueRefFrom(args.league);
        const { payload } = await gameForLeague(
          source,
          ref,
          args.gameId,
        );
        const { gameDataPath } = await persistCanonicalGame(payload, dataDir);
        return textResult({ gameDataPath, ...payload });
      } catch (cause) {
        return errorResult(cause);
      }
    },
  );

  server.registerTool(
    "parity_get_interactions",
    {
      description:
        "Get teammate and opponent interaction pairs for one canonical game.",
      inputSchema: {
        league: z.union([z.number().int(), z.string()]).optional(),
        gameId: z.union([z.number().int(), z.string()]),
      },
    },
    async (args): Promise<ReturnType<typeof textResult> | ReturnType<typeof errorResult>> => {
      try {
        const ref = leagueRefFrom(args.league);
        const { payload } = await gameForLeague(
          source,
          ref,
          args.gameId,
        );
        return textResult({
          teammatePairs: payload.interactions.teammatePairs,
          opponentPairs: payload.interactions.opponentPairs,
        });
      } catch (cause) {
        return errorResult(cause);
      }
    },
  );

  return server;
}

/** Convert a tool's mixed league argument into a LeagueRef, when present. */
function leagueRefFrom(
  league: number | string | undefined,
): LeagueRef | undefined {
  if (league === undefined) return undefined;
  if (typeof league === "number") return { id: league };
  return { name: league };
}

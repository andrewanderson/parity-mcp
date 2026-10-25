import type { ApiGame, GamePayload, SupportedLeague } from "../domain/types.js";

/**
 * A league as chosen by the caller of a source method: how the source is
 * told which league to resolve. Either a numeric league id or an exact
 * league name from the API registry.
 */
export type LeagueRef = { id: number } | { name: string };

/** Terminal source error codes surfaced to callers. */
export type SourceErrorCode =
  | "UNSUPPORTED_LEAGUE_VERSION"
  | "LEAGUE_NOT_FOUND"
  | "GAME_NOT_FOUND"
  | "REQUEST_FAILED";

/** Error raised by data sources, carrying a machine-readable code. */
export class SourceError extends Error {
  readonly code: SourceErrorCode;
  readonly leagueRef?: LeagueRef;

  constructor(code: SourceErrorCode, message: string, leagueRef?: LeagueRef) {
    super(message);
    this.name = "SourceError";
    this.code = code;
    this.leagueRef = leagueRef;
  }
}

/** Options for listing games from a source. */
export type ListGamesOptions = {
  /** Include point/event payloads with each listed game. */
  includePoints?: boolean;
  /** Restrict listed games to a specific game date. Uses the includePoints endpoint. */
  date?: string;
};

/**
 * The data source contract used by parity tools. Each method tells the
 * source which league to resolve, so unsupported leagues are reported as
 * league errors rather than silent omissions. Only supported `v2` leagues
 * ever appear in `listSupportedLeagues`.
 */
export interface DataSource {
  listSupportedLeagues(): Promise<SupportedLeague[]>;
  listGames(league: LeagueRef, options?: ListGamesOptions): Promise<ApiGame[]>;
  getGame(league: LeagueRef, gameId: number | string): Promise<GamePayload>;
}

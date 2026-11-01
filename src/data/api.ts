import type { ApiGame, GamePayload, SupportedLeague } from "../domain/types.js";
import { buildGenderMap, canonicalizeGame } from "./normalize.js";
import {
  DataSource,
  SourceError,
  type LeagueRef,
  type ListGamesOptions,
} from "./source.js";

/**
 * A league summary exactly as reported by the API's `/api/leagues`
 * endpoint. The full registry (including `v1` entries) is kept only inside
 * the source, so `v1` requests resolve to the unsupported-version error
 * instead of a misleading not-found.
 */
type ApiLeagueSummary = {
  id: number;
  name: string;
  statValues: "v1" | "v2";
  lineSize: number;
  salaryCalc: string;
};

function joinPath(baseUrl: string, suffix: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${suffix}`;
}

export class ParityApiSource implements DataSource {
  private readonly baseUrl: string;
  private readonly fetchLike: typeof fetch;
  private readonly fullLeagueUrl: string;
  private registryPromise: Promise<ApiLeagueSummary[]> | null = null;

  constructor(options: { baseUrl: string; fetchLike?: typeof fetch }) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchLike = options.fetchLike ?? globalThis.fetch.bind(globalThis);
    this.fullLeagueUrl = joinPath(this.baseUrl, "/api/leagues");
  }

  async listSupportedLeagues(): Promise<SupportedLeague[]> {
    const registry = await this.leagueRegistry();
    const supported: SupportedLeague[] = [];
    for (const entry of registry) {
      if (entry.statValues !== "v2") continue;
      supported.push({
        id: entry.id,
        name: entry.name,
        statValues: "v2",
        lineSize: entry.lineSize,
        salaryCalc: entry.salaryCalc,
      });
    }
    return supported;
  }

  async listGames(
    league: LeagueRef,
    options?: ListGamesOptions,
  ): Promise<ApiGame[]> {
    const resolved = await this.resolveLeague(league);
    const wantsPoints = options?.includePoints === true || options?.date !== undefined;
    const suffix = wantsPoints ? "/games?includePoints=true" : "/games";
    const games = await this.fetchJson<ApiGame[]>(
      joinPath(this.baseUrl, `/api/${resolved.id}${suffix}`),
    );

    if (options?.date === undefined) {
      return games;
    }
    // The points-bearing list is the only games listing that can carry a
    // usable date; captured games otherwise have no date field.
    return games.filter(
      (game) => (game as ApiGame & { date?: string | null }).date === options.date,
    );
  }

  async getGame(
    league: LeagueRef,
    gameId: number | string,
  ): Promise<GamePayload> {
    const resolved = await this.resolveLeague(league);
    const gamePromise = this.fetchJson<ApiGame>(
      joinPath(this.baseUrl, `/api/${resolved.id}/games/${gameId}`),
    );
    // Division data is an enhancement, never a failure: a teams-endpoint
    // problem degrades to stat lines without `isOpen` rather than failing
    // the game request.
    const rawTeams = await this.fetchTeamsTolerant(resolved.id);
    const rawGame = await gamePromise;
    if (rawGame.league_id !== resolved.id) {
      throw new SourceError(
        "GAME_NOT_FOUND",
        `Game ${gameId} belongs to league ${rawGame.league_id}, not league ${resolved.id}.`,
        league,
      );
    }
    return canonicalizeGame(rawGame, resolved, buildGenderMap(rawTeams));
  }

  /** Team rosters as reported by the API, raw and unnormalized. */
  async getTeams(league: LeagueRef): Promise<unknown> {
    const resolved = await this.resolveLeague(league);
    return this.fetchJson<unknown>(
      joinPath(this.baseUrl, `/api/${resolved.id}/teams`),
    );
  }

  /** Week metadata as reported by the API, raw and unnormalized. */
  async getWeeks(league: LeagueRef): Promise<unknown> {
    const resolved = await this.resolveLeague(league);
    return this.fetchJson<unknown>(
      joinPath(this.baseUrl, `/api/${resolved.id}/weeks`),
    );
  }

  /**
   * The full league registry, cached per source. Contains every league,
   * including `v1` entries kept only for accurate resolution errors.
   */
  private leagueRegistry(): Promise<ApiLeagueSummary[]> {
    this.registryPromise ??= this.fetchJson<ApiLeagueSummary[]>(this.fullLeagueUrl);
    return this.registryPromise;
  }

  /** Teams payload for a league, or null when the endpoint fails. */
  private async fetchTeamsTolerant(leagueId: number): Promise<unknown> {
    try {
      return await this.fetchJson<unknown>(
        joinPath(this.baseUrl, `/api/${leagueId}/teams`),
      );
    } catch {
      return null;
    }
  }

  /**
   * Resolve a caller's league reference against the full registry. Only a
   * supported `v2` league is ever returned; requesting a `v1` league (by id
   * or by exact name) is a distinct version error, not a not-found.
   */
  private async resolveLeague(league: LeagueRef): Promise<SupportedLeague> {
    const registry = await this.leagueRegistry();

    let matches: ApiLeagueSummary[];
    if ("name" in league && league.name !== undefined) {
      // Name path: exact match against the raw registry name.
      matches = registry.filter((entry) => entry.name === league.name);
    } else {
      matches = registry.filter((entry) => entry.id === (league as { id: number }).id);
    }

    if (matches.length === 0) {
      throw new SourceError(
        "LEAGUE_NOT_FOUND",
        `League ${leagueToString(league)} is not in the API registry.`,
        league,
      );
    }
    if (matches.length > 1) {
      throw new SourceError(
        "LEAGUE_NOT_FOUND",
        `League ${leagueToString(league)} is ambiguous (${matches.map((m) => m.id).join(", ")}); use the league id.`,
        league,
      );
    }
    const match = matches[0];
    if (match.statValues !== "v2") {
      throw new SourceError(
        "UNSUPPORTED_LEAGUE_VERSION",
        `League ${leagueToString(league)} uses unsupported stat values ${match.statValues}; only v2 is supported.`,
        league,
      );
    }
    return {
      id: match.id,
      name: match.name,
      statValues: "v2",
      lineSize: match.lineSize,
      salaryCalc: match.salaryCalc,
    };
  }

  private async fetchJson<T>(url: string): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchLike(url);
    } catch (cause) {
      throw new SourceError("REQUEST_FAILED", `Request to ${url} failed: ${String(cause)}`);
    }
    if (!response.ok) {
      throw new SourceError(
        "REQUEST_FAILED",
        `Request to ${url} failed with HTTP ${response.status}.`,
      );
    }
    return (await response.json()) as T;
  }
}

/** Human-readable label for a league reference in error messages. */
function leagueToString(league: LeagueRef): string {
  if ("name" in league) {
    return `name "${league.name}"`;
  }
  return `id ${(league as { id: number }).id}`;
}

/** Create an HTTP-backed parity data source. */
export function createParityApiSource(options: {
  baseUrl: string;
  fetchLike?: typeof fetch;
}): ParityApiSource {
  return new ParityApiSource(options);
}

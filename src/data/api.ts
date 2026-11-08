import type {
  ApiGame,
  ApiTeamPlayer,
  ApiTeamRoster,
  GamePayload,
  SupportedLeague,
} from "../domain/types.js";
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
  zuluru?: string | null;
};

function joinPath(baseUrl: string, suffix: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${suffix}`;
}

/**
 * Parse the teams payload into typed rosters, skipping anything malformed:
 * a team must have a numeric `id` and a string `name`, and a player must
 * have a string `name` and a boolean `is_open`.
 */
function parseTeamRoster(raw: unknown): ApiTeamRoster[] {
  if (!Array.isArray(raw)) return [];
  const rosters: ApiTeamRoster[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const team = entry as Record<string, unknown>;
    if (typeof team.id !== "number" || !Number.isInteger(team.id)) continue;
    if (typeof team.name !== "string") continue;
    if (!Array.isArray(team.players)) continue;
    const players: ApiTeamPlayer[] = [];
    for (const rawPlayer of team.players) {
      if (typeof rawPlayer !== "object" || rawPlayer === null) continue;
      const player = rawPlayer as Record<string, unknown>;
      if (typeof player.name !== "string") continue;
      if (typeof player.is_open !== "boolean") continue;
      players.push({ name: player.name, isOpen: player.is_open });
    }
    rosters.push({ id: team.id, name: team.name, players });
  }
  return rosters;
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
    const nameCounts = new Map<string, number>();
    for (const entry of registry) {
      nameCounts.set(entry.name, (nameCounts.get(entry.name) ?? 0) + 1);
    }
    const supported: SupportedLeague[] = [];
    for (const entry of registry) {
      if (entry.statValues !== "v2") continue;
      supported.push({
        id: entry.id,
        name: entry.name,
        statValues: "v2",
        lineSize: entry.lineSize,
        salaryCalc: entry.salaryCalc,
        ...(entry.zuluru === undefined ? {} : { zuluru: entry.zuluru }),
        displayName:
          (nameCounts.get(entry.name) ?? 0) > 1
            ? `${entry.name} [${entry.id}]`
            : entry.name,
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

  /**
   * Team rosters for a league, parsed into typed players. `isOpen` is the
   * API's `is_open` field: `true` for the Open division, `false` for Women.
   * A malformed team or player is skipped, never fatal, matching how
   * `buildGenderMap` handles the same payload.
   */
  async getTeamRoster(league: LeagueRef): Promise<ApiTeamRoster[]> {
    const resolved = await this.resolveLeague(league);
    const raw = await this.fetchJson<unknown>(
      joinPath(this.baseUrl, `/api/${resolved.id}/teams`),
    );
    return parseTeamRoster(raw);
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
   * Resolve a caller's league reference against the full registry.
   *
   * The league id is the canonical identifier: the Parity API itself always
   * addresses leagues by id, and two leagues can share an identical name.
   * An id reference therefore resolves directly. A name reference resolves
   * by exact name, and is only ambiguous when the registry really holds
   * several leagues under that name.
   *
   * Only a supported `v2` league is ever returned; requesting a `v1` league
   * (by id or by exact name) is a distinct version error, not a not-found.
   */
  private async resolveLeague(league: LeagueRef): Promise<SupportedLeague> {
    const registry = await this.leagueRegistry();

    let matches: ApiLeagueSummary[];
    const wantedId = leagueIdOf(league);
    if (wantedId !== undefined) {
      // Id path: ids are unique, so there is never more than one match.
      matches = registry.filter((entry) => entry.id === wantedId);
    } else {
      // Name path: a numeric name is really an id in string clothing. The
      // registry's names are never numeric, so this only ever redirects a
      // reference the name path could not have resolved anyway.
      const name = leagueNameOf(league);
      const numericId = numericLeagueId(name);
      matches =
        numericId === undefined
          ? registry.filter((entry) => entry.name === name)
          : registry.filter((entry) => entry.id === numericId);
    }

    if (matches.length === 0) {
      throw new SourceError(
        "LEAGUE_NOT_FOUND",
        `League ${leagueToString(league)} is not in the API registry.`,
        league,
      );
    }
    if (matches.length > 1) {
      const ids = matches.map((m) => m.id).join(", ");
      const detail = matches
        .map((m) => `${m.id}${m.zuluru ? ` (${m.zuluru})` : ""}`)
        .join("; ");
      throw new SourceError(
        "LEAGUE_NOT_FOUND",
        `League ${leagueToString(league)} is ambiguous (${ids}); use the league id. Candidates: ${detail}.`,
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
      ...(match.zuluru === undefined ? {} : { zuluru: match.zuluru }),
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

/** The league id carried by a reference, when it carries one. */
function leagueIdOf(league: LeagueRef): number | undefined {
  return "id" in league ? league.id : undefined;
}

/** The league name carried by a reference, when it carries one. */
function leagueNameOf(league: LeagueRef): string | undefined {
  return "name" in league ? league.name : undefined;
}

/**
 * Parse a league reference string as a league id. Only a plain run of digits
 * counts, so no real league name is ever mistaken for an id.
 */
function numericLeagueId(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  return Number(trimmed);
}

/** Create an HTTP-backed parity data source. */
export function createParityApiSource(options: {
  baseUrl: string;
  fetchLike?: typeof fetch;
}): ParityApiSource {
  return new ParityApiSource(options);
}

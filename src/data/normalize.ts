import type {
  ApiGame,
  Event,
  EventType,
  GamePayload,
  Point,
  PlayerRef,
  PlayerStatLine,
  QualityReport,
  QualityWarning,
  RawPlayerRef,
  SupportedLeague,
  TeamSource,
} from "../domain/types.js";

const SUBSTITUTE_MARKER = /\(S\)$/i;

const UNKNOWN_TEAM = /unknown/i;

const EVENT_TYPES: readonly EventType[] = [
  "PULL",
  "PASS",
  "POINT",
  "DEFENSE",
  "THROWAWAY",
  "DROP",
];

/**
 * Normalize a raw player reference from capture payloads.
 * Strips only the terminal `(S)` substitute marker and trims whitespace.
 * The raw input is preserved untouched; no other Unicode transformations.
 */
export function normalizePlayerRef(raw: RawPlayerRef): PlayerRef {
  const isSubstitute = SUBSTITUTE_MARKER.test(raw);
  const name = raw.replace(SUBSTITUTE_MARKER, "").trim();
  return { raw, name, isSubstitute };
}

/**
 * Parse a fixture timestamp string like "3/15/2026, 6:13:40 PM" as a local
 * naive time. Seconds are optional in the expected format.
 */
export function parseLocalTimestamp(raw: string): {
  timestampLocal: string;
  timestampSec: number | null;
} {
  const match =
    /^(\d{1,2})\/(\d{1,2})\/(\d{4}), (\d{1,2}):(\d{2})(?::(\d{2}))? (AM|PM)$/.exec(
      raw,
    );
  if (match === null) {
    return { timestampLocal: raw, timestampSec: null };
  }

  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  const hourTwelve = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const period = match[7];

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return { timestampLocal: raw, timestampSec: null };
  }
  if (hourTwelve < 1 || hourTwelve > 12) {
    return { timestampLocal: raw, timestampSec: null };
  }

  const hour = period === "PM" ? (hourTwelve % 12) + 12 : hourTwelve % 12;
  const date = new Date(year, month - 1, day, hour, minute, second);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return { timestampLocal: raw, timestampSec: null };
  }
  const timestampSec = date.getTime() / 1000;

  return { timestampLocal: raw, timestampSec };
}

/** Case-insensitive identity key for a player reference. */
function identityKey(raw: RawPlayerRef): string {
  return normalizePlayerRef(raw).name.toLowerCase();
}

/**
 * Build an identity-keyed division map from the raw teams payload
 * (`/api/<id>/teams`): each player entry carries `is_open`, true for the Open
 * division and false for Women. Keys are normalized player names in lower
 * case, so substitute markers and case differences never matter. A single
 * player claimed with conflicting divisions resolves to unknown (dropped),
 * never a guess. Malformed teams and players are ignored.
 */
export function buildGenderMap(
  rawTeams: unknown,
): ReadonlyMap<string, boolean> {
  const map = new Map<string, boolean>();
  const conflicts = new Set<string>();
  if (!Array.isArray(rawTeams)) return map;
  for (const team of rawTeams) {
    const players = (team as { players?: unknown } | null)?.players;
    if (!Array.isArray(players)) continue;
    for (const player of players) {
      const name = (player as { name?: unknown } | null)?.name;
      const isOpen = (player as { is_open?: unknown } | null)?.is_open;
      if (typeof name !== "string" || typeof isOpen !== "boolean") continue;
      const key = normalizePlayerRef(name).name.toLowerCase();
      if (conflicts.has(key)) continue;
      const existing = map.get(key);
      if (existing !== undefined && existing !== isOpen) {
        map.delete(key);
        conflicts.add(key);
        continue;
      }
      map.set(key, isOpen);
    }
  }
  return map;
}

/** The stat line whose identity key matches the given key, if any. */
function statForIdentity(
  key: string,
  stats: readonly PlayerStatLine[],
): PlayerStatLine | undefined {
  return stats.find((s) => identityKey(s.raw) === key);
}

/** The literal "Unknown" stats team is invalid source data, not a team assignment. */
function isValidStatsTeam(team: string | null): team is string {
  return team !== null && team.trim() !== "" && !UNKNOWN_TEAM.test(team);
}

/** Stats-or-roster-only resolution used as the basis for line-majority. */
function resolveBaseTeam(name: RawPlayerRef, game: GamePayload): string | null {
  const key = identityKey(name);
  const stat = statForIdentity(key, game.stats);
  if (stat !== undefined && isValidStatsTeam(stat.team)) {
    return stat.team;
  }
  if (game.game.homeRoster.some((r) => identityKey(r) === key)) {
    return game.game.homeTeam;
  }
  if (game.game.awayRoster.some((r) => identityKey(r) === key)) {
    return game.game.awayTeam;
  }
  return null;
}

/**
 * Resolve one player's team on behalf of one game.
 * Precedence: invalid stats.team values (missing or literally "Unknown") are
 * invalid data, not a terminal assignment. Then roster membership, then
 * unanimous known line-majority among the point rows where the player is
 * recorded, then explicit unknown. Pure: never mutates `game.quality.warnings`.
 */
export function resolvePlayerTeam(
  name: RawPlayerRef,
  game: GamePayload,
): { team: string | null; teamSource: TeamSource } {
  const key = identityKey(name);

  const stat = statForIdentity(key, game.stats);
  if (stat !== undefined && isValidStatsTeam(stat.team)) {
    return { team: stat.team, teamSource: "stats" };
  }

  const isOnHomeRoster = game.game.homeRoster.some((r) => identityKey(r) === key);
  const isOnAwayRoster = game.game.awayRoster.some((r) => identityKey(r) === key);
  if (isOnHomeRoster) {
    return { team: game.game.homeTeam, teamSource: "roster" };
  }
  if (isOnAwayRoster) {
    return { team: game.game.awayTeam, teamSource: "roster" };
  }

  const candidates = lineMajorityCandidates(key, game);
  const distinct = [...new Set(candidates)];
  if (distinct.length === 1) {
    return { team: distinct[0], teamSource: "line-majority" };
  }
  return { team: null, teamSource: "unknown" };
}

/**
 * For each recorded point row containing the player, collect the teams of
 * every other player via stats or roster only. A row yields a candidate only
 * when it has at least one other player and all others resolve unanimously.
 * Multiple divergent unanimities are terminal unknown, not a guess.
 */
function lineMajorityCandidates(key: string, game: GamePayload): string[] {
  const candidates: string[] = [];
  for (const point of game.game.points) {
    for (const row of [point.offensePlayers, point.defensePlayers]) {
      if (!row.some((p) => identityKey(p.name) === key)) continue;
      const others = row.filter((p) => identityKey(p.name) !== key);
      if (others.length === 0) continue;
      let uniform: string | null = null;
      let unanimous = true;
      for (const other of others) {
        const otherTeam = resolveBaseTeam(other.name, game);
        if (otherTeam === null) {
          unanimous = false;
          break;
        }
        if (uniform === null) {
          uniform = otherTeam;
        } else if (otherTeam !== uniform) {
          unanimous = false;
          break;
        }
      }
      if (unanimous && uniform !== null) {
        candidates.push(uniform);
      }
    }
  }
  return candidates;
}

function normalizeEventType(raw: string): EventType {
  return EVENT_TYPES.includes(raw as EventType) ? (raw as EventType) : "PASS";
}

/**
 * Derive point duration as last minus first usable non-PULL event timestamp.
 * Null when too few usable timestamps; never a fabricated zero. A real zero
 * (two same-timestamp events) stays zero.
 */
function deriveDurationSec(events: Event[]): number | null {
  const usable = events
    .filter((event) => event.type !== "PULL")
    .map((event) => event.timestampSec)
    .filter((sec): sec is number => sec !== null);
  if (usable.length < 2) {
    return null;
  }
  return Math.max(...usable) - Math.min(...usable);
}

/**
 * Canonicalize a captured API game into the stable GamePayload shell.
 * Raw values are preserved, lines are recorded exactly as captured, and
 * warnings are derived once at the end via `qualityReport`.
 */
export function canonicalizeGame(
  rawGame: ApiGame,
  league: SupportedLeague,
  genderMap?: ReadonlyMap<string, boolean>,
): GamePayload {
  const points: Point[] = rawGame.points.map((rawPoint, index) => {
    const events: Event[] = rawPoint.events.map((rawEvent) => {
      const parsed = parseLocalTimestamp(rawEvent.timestamp);
      return {
        type: normalizeEventType(rawEvent.type),
        firstActor: rawEvent.firstActor,
        secondActor: rawEvent.secondActor,
        timestamp: rawEvent.timestamp,
        timestampLocal: parsed.timestampLocal,
        timestampSec: parsed.timestampSec,
      };
    });
    return {
      pointNumber: index + 1,
      offensePlayers: rawPoint.offensePlayers.map(normalizePlayerRef),
      defensePlayers: rawPoint.defensePlayers.map(normalizePlayerRef),
      durationSec: deriveDurationSec(events),
      events,
    };
  });

  const stats: PlayerStatLine[] = Object.entries(rawGame.stats).map(
    ([raw, rawStat]) => {
      const line: PlayerStatLine = {
        raw,
        name: normalizePlayerRef(raw).name,
        isSubstitute: SUBSTITUTE_MARKER.test(raw),
        goals: rawStat.goals,
        assists: rawStat.assists,
        secondAssists: rawStat.second_assists,
        dBlocks: rawStat.d_blocks,
        completions: rawStat.completions,
        throwAways: rawStat.throw_aways,
        threwDrops: rawStat.threw_drops,
        catches: rawStat.catches,
        drops: rawStat.drops,
        pulls: rawStat.pulls,
        callahan: rawStat.callahan,
        oPointsFor: rawStat.o_points_for,
        oPointsAgainst: rawStat.o_points_against,
        dPointsFor: rawStat.d_points_for,
        dPointsAgainst: rawStat.d_points_against,
        pointsPlayed: rawStat.points_played,
        pay: rawStat.pay,
        team: rawStat.team,
      };
      if (genderMap !== undefined) {
        const isOpen = genderMap.get(identityKey(raw));
        if (isOpen !== undefined) line.isOpen = isOpen;
      }
      return line;
    },
  );

  const payload: GamePayload = {
    schemaVersion: 1,
    league: {
      id: league.id,
      name: league.name,
      statValues: "v2",
      lineSize: league.lineSize,
      salaryCalc: league.salaryCalc,
    },
    game: {
      id: rawGame.id,
      week: rawGame.week,
      status: rawGame.status,
      date: null,
      homeTeam: rawGame.homeTeam,
      awayTeam: rawGame.awayTeam,
      homeScore: rawGame.homeScore,
      awayScore: rawGame.awayScore,
      homeRoster: [...rawGame.homeRoster],
      awayRoster: [...rawGame.awayRoster],
      points,
    },
    stats,
    quality: { warnings: [] },
  };

  return { ...payload, quality: qualityReport(payload) };
}

/**
 * Pure data-quality report over a canonical payload. The only owner of
 * warnings in this layer: every warning is derived from the payload, never
 * accumulated as a side effect of another function.
 */
export function qualityReport(payload: GamePayload): QualityReport {
  const warnings: QualityWarning[] = [];
  const lineSize = payload.league.lineSize;

  for (const point of payload.game.points) {
    const keyToRaw = new Map<string, string>();
    for (const player of point.offensePlayers) {
      keyToRaw.set(identityKey(player.raw), player.raw);
    }
    for (const player of point.defensePlayers) {
      const onOffense = keyToRaw.has(identityKey(player.raw));
      if (onOffense) {
        warnings.push({
          code: "PLAYER_ON_BOTH_LINES",
          message: `${player.raw} is recorded on both lines of point ${point.pointNumber}.`,
          pointNumber: point.pointNumber,
          player: player.raw,
        });
      }
    }

    for (const [rowName, row] of [
      ["offense", point.offensePlayers],
      ["defense", point.defensePlayers],
    ] as const) {
      if (row.length !== lineSize) {
        warnings.push({
          code: "LINE_SIZE_MISMATCH",
          message: `Point ${point.pointNumber} ${rowName} line has ${row.length} players, league lineSize is ${lineSize}.`,
          pointNumber: point.pointNumber,
        });
      }
      const seenKeys = new Set<string>();
      for (const player of row) {
        const key = identityKey(player.raw);
        if (seenKeys.has(key)) {
          warnings.push({
            code: "DUPLICATE_LINE_PLAYER",
            message: `Point ${point.pointNumber} ${rowName} line records ${player.raw} more than once.`,
            pointNumber: point.pointNumber,
            player: player.raw,
          });
        }
        seenKeys.add(key);
      }
    }

    const lineKeys = new Set([
      ...point.offensePlayers.map((p) => identityKey(p.raw)),
      ...point.defensePlayers.map((p) => identityKey(p.raw)),
    ]);
    const outsideActors = new Set<string>();
    for (const event of point.events) {
      for (const actor of [event.firstActor, event.secondActor]) {
        if (actor === null) continue;
        if (!lineKeys.has(identityKey(actor))) {
          outsideActors.add(actor.toLowerCase());
        }
      }
    }
    for (const lowerActor of outsideActors) {
      warnings.push({
        code: "ACTOR_OUTSIDE_LINES",
        message: `An event actor (${actorLabel(payload, lowerActor)}) in point ${point.pointNumber} is not on either recorded line.`,
        pointNumber: point.pointNumber,
      });
    }
  }

  // Substitute-status conflict: same identity recorded both with and without
  // the (S) marker among game-recorded sources (stats keys and point lines).
  const statuses = collectSubStatuses(payload);
  for (const [key, status] of statuses) {
    if (status.sub && status.notSub) {
      warnings.push({
        code: "SUBSTITUTE_STATUS_CONFLICT",
        message: `${key} appears both with and without the (S) marker in game ${payload.game.id}.`,
        player: key,
      });
    }
  }

  // Normalization collision: one identity recorded with multiple raw
  // spellings differing only by letter case. Accents and spellings are never
  // altered, so only case-level collisions are reported.
  const caseCollider = collectCaseCollisions(payload);
  for (const [key, forms] of caseCollider) {
    warnings.push({
      code: "NORMALIZATION_COLLISION",
      message: `Identity ${key} is recorded with multiple raw spellings (${[...forms].join(", ")}) in game ${payload.game.id}.`,
      player: key,
    });
  }

  // Substitutes absent from every roster: real observed data quirk.
  for (const stat of payload.stats) {
    if (!stat.isSubstitute) continue;
    const key = identityKey(stat.raw);
    const onRoster =
      payload.game.homeRoster.some((r) => identityKey(r) === key) ||
      payload.game.awayRoster.some((r) => identityKey(r) === key);
    if (!onRoster) {
      warnings.push({
        code: "SUBSTITUTE_NOT_ON_ROSTER",
        message: `Substitute ${stat.raw} is absent from both rosters in game ${payload.game.id}.`,
        player: stat.raw,
      });
    }
  }

  // Explicit unknown team, terminal only: invalid stats.team is not a
  // terminal assignment, so falls through roster and line-majority first.
  for (const stat of payload.stats) {
    if (isValidStatsTeam(stat.team)) continue;
    const resolved = resolvePlayerTeam(stat.raw, payload);
    if (resolved.teamSource === "unknown") {
      warnings.push({
        code: "UNRESOLVED_PLAYER_TEAM",
        message: `${stat.raw} has no resolvable team in game ${payload.game.id} (stats team ${stat.team === null ? "missing" : stat.team}, absent from both rosters, no unanimous known line-majority).`,
        player: stat.raw,
      });
    }
  }

  return { warnings };
}

/** Where a normalized identity came from, for warning messages. */
function actorLabel(payload: GamePayload, lowerKey: string): string {
  const stat = statForIdentity(lowerKey, payload.stats);
  return stat !== undefined ? stat.raw : lowerKey;
}

/** Collect (S)-marker statuses per identity across stats keys and lines. */
function collectSubStatuses(
  payload: GamePayload,
): Map<string, { sub: boolean; notSub: boolean }> {
  const map = new Map<string, { sub: boolean; notSub: boolean }>();
  const record = (raw: RawPlayerRef): void => {
    const key = identityKey(raw);
    const entry = map.get(key) ?? { sub: false, notSub: false };
    if (SUBSTITUTE_MARKER.test(raw)) {
      entry.sub = true;
    } else {
      entry.notSub = true;
    }
    map.set(key, entry);
  };
  for (const stat of payload.stats) {
    record(stat.raw);
  }
  for (const point of payload.game.points) {
    for (const player of [...point.offensePlayers, ...point.defensePlayers]) {
      record(player.raw);
    }
  }
  return map;
}

/** Collect raw spellings per case-insensitive identity with >1 casing. */
function collectCaseCollisions(
  payload: GamePayload,
): Map<string, string[]> {
  const map = new Map<string, Map<string, string>>();
  const record = (raw: RawPlayerRef): void => {
    const stripped = normalizePlayerRef(raw).name;
    const key = stripped.toLowerCase();
    const spellings = map.get(key) ?? new Map<string, string>();
    spellings.set(stripped, stripped);
    map.set(key, spellings);
  };
  for (const stat of payload.stats) {
    record(stat.raw);
  }
  for (const point of payload.game.points) {
    for (const player of [...point.offensePlayers, ...point.defensePlayers]) {
      record(player.raw);
    }
  }
  const collisions = new Map<string, string[]>();
  for (const [key, spellings] of map) {
    if (spellings.size > 1) {
      collisions.set(key, [...spellings.keys()]);
    }
  }
  return collisions;
}

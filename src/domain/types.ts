/** A player reference exactly as it appears in capture payloads. */
export type RawPlayerRef = string;

/** A normalized player identity, separating raw input from display name. */
export type PlayerRef = {
  raw: string;
  name: string;
  isSubstitute: boolean;
};

/** Summary of a league as reported by the API. */
export type LeagueSummary = {
  id: number;
  name: string;
  statValues: "v1" | "v2";
  lineSize: number;
  salaryCalc: string;
};

/** A league whose payloads use the current stat-value format. */
export type SupportedLeague = Omit<LeagueSummary, "statValues"> & {
  statValues: "v2";
};

/**
 * Provenance of a player's team assignment for one game. Precedence when
 * resolving: valid `stats.team` (team raw value is missing or literally
 * "Unknown"` is invalid data, not a terminal assignment), then roster
 * membership, then unanimous known line-majority, then explicit unknown.
 */
export type TeamSource = "stats" | "roster" | "line-majority" | "unknown";

/** A player's exposure on a given team. */
export type PlayerExposure = {
  name: string;
  teamIndex: number;
  exposures: number;
  teamSource: TeamSource;
};

/** Play-by-play event types as recorded by the Parity API. */
export type EventType =
  | "PULL"
  | "PASS"
  | "POINT"
  | "DEFENSE"
  | "THROWAWAY"
  | "DROP";

/** A single play-by-play event, preserving raw and parsed timestamps. */
export type Event = {
  type: EventType;
  firstActor: RawPlayerRef | null;
  secondActor: RawPlayerRef | null;
  timestamp: string;
  timestampLocal: string;
  timestampSec: number | null;
};

/**
 * One recorded point. Lines are preserved exactly as recorded, including
 * extra, missing, or duplicated players; they are never silently trimmed.
 */
export type Point = {
  pointNumber: number;
  offensePlayers: PlayerRef[];
  defensePlayers: PlayerRef[];
  durationSec: number | null;
  events: Event[];
};

/** The game-level core, with raw rosters preserved untouched. */
export type GameCore = {
  id: number;
  week: number;
  status: string;
  date: string | null;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  homeRoster: RawPlayerRef[];
  awayRoster: RawPlayerRef[];
  points: Point[];
};

/** One player's canonical stat line, normalized from the raw stats record. */
export type PlayerStatLine = {
  raw: RawPlayerRef;
  name: string;
  isSubstitute: boolean;
  goals: number;
  assists: number;
  secondAssists: number;
  dBlocks: number;
  completions: number;
  throwAways: number;
  threwDrops: number;
  catches: number;
  drops: number;
  pulls: number;
  callahan: number;
  oPointsFor: number;
  oPointsAgainst: number;
  dPointsFor: number;
  dPointsAgainst: number;
  pointsPlayed: number;
  pay: number;
  team: string | null;
  /**
   * Division from the league teams source: `true` is Open, `false` is Women.
   * Absent when the teams source was unavailable or the player is not on any
   * league roster; absence is unknown, never a guess.
   */
  isOpen?: boolean;
};

/**
 * A structured data-quality warning. Warnings are pure derived data owned by
 * `qualityReport`; no other function mutates or emits them on its own.
 */
export type QualityWarning = {
  code: string;
  message: string;
  pointNumber?: number;
  player?: string;
};

/** Data-quality summary attached to a canonical game payload. */
export type QualityReport = {
  warnings: QualityWarning[];
};

/** Raw event as captured from the API. */
export type ApiEvent = {
  type: string;
  firstActor: string | null;
  secondActor: string | null;
  timestamp: string;
};

/** Raw point as captured from the API. */
export type ApiPoint = {
  offensePlayers: RawPlayerRef[];
  defensePlayers: RawPlayerRef[];
  events: ApiEvent[];
};

/** Raw per-player stat line as captured from the API. */
export type ApiStatLine = {
  goals: number;
  assists: number;
  second_assists: number;
  d_blocks: number;
  completions: number;
  throw_aways: number;
  threw_drops: number;
  catches: number;
  drops: number;
  pulls: number;
  callahan: number;
  o_points_for: number;
  o_points_against: number;
  d_points_for: number;
  d_points_against: number;
  points_played: number;
  pay: number;
  team: string | null;
};

/** Raw game payload as captured from the API. */
export type ApiGame = {
  id: number;
  league_id: number;
  status: string;
  week: number;
  homeTeam: string;
  awayTeam: string;
  homeRoster: RawPlayerRef[];
  awayRoster: RawPlayerRef[];
  homeScore: number;
  awayScore: number;
  points: ApiPoint[];
  stats: Record<RawPlayerRef, ApiStatLine>;
};

/**
 * The stable canonical game payload. The salary ledger, timeline, story
 * facts, and interactions are added by later engine stages when the full
 * payload is assembled.
 */
export type GamePayload = {
  schemaVersion: 1;
  league: LeagueSummary;
  game: GameCore;
  stats: PlayerStatLine[];
  quality: QualityReport;
};

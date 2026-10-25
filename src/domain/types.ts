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

/** Provenance of a team's line data. */
export type TeamSource = "stats" | "roster" | "line-majority" | "unknown";

/** A player's exposure on a given team. */
export type PlayerExposure = {
  name: string;
  teamIndex: number;
  exposures: number;
  teamSource: TeamSource;
};

/**
 * A moment where a set of players share the field. Player arrays use the
 * normalized `PlayerRef`; timestamps echo the parse result of
 * `parseLocalTimestamp`. Refined by Task 3.
 */
export type Point = {
  players: PlayerRef[];
  timestampSec: number | null;
  timestampLocal: string;
};

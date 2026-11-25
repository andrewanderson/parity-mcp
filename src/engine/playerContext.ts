import { normalizePlayerRef } from "../data/normalize.js";
import type {
  GamePayload,
  PlayerContextBlock,
  PriorGameRow,
} from "../domain/types.js";

/**
 * The prior-week games a transition derivation may see: either the league's
 * earlier-week listed rows, or the reason they are unavailable. The server
 * supplies one or the other; the engine never fetches.
 */
export type PriorGames =
  | { available: true; rows: PriorGameRow[] }
  | { available: false; reason: string };

/**
 * Derive the recap player-context block for one canonical game: substitutes
 * with resolved teams, and roster transitions within the current league.
 * Pure: the input payload is never mutated and no source is contacted.
 */
export function buildPlayerContext(
  payload: GamePayload,
  prior: PriorGames,
): PlayerContextBlock {
  const substitutes = payload.stats
    .filter((stat) => stat.isSubstitute)
    .map((stat) => ({
      player: normalizePlayerRef(stat.raw).name,
      team: stat.team,
    }));

  if (!prior.available) {
    return {
      substitutes,
      transitions: [],
      priorDataAvailable: false,
      note: `Earlier-week data was unavailable (${prior.reason}); roster transitions were not computed.`,
    };
  }

  if (payload.game.week <= 1) {
    return {
      substitutes,
      transitions: [],
      priorDataAvailable: true,
      note: "First week of the season: no earlier-week games.",
    };
  }

  return {
    substitutes,
    transitions: [],
    priorDataAvailable: true,
    note: null,
  };
}

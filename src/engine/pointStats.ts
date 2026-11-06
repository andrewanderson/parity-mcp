import type {
  GamePayload,
  QualityWarning,
  RawPlayerRef,
} from "../domain/types.js";
import { normalizePlayerRef } from "../data/normalize.js";

/**
 * One player's derived counts over the ten API stat dimensions. Field names
 * match the API's snake_case stat fields exactly.
 */
export type PointStatCounts = {
  goals: number;
  assists: number;
  second_assists: number;
  d_blocks: number;
  completions: number;
  catches: number;
  drops: number;
  throw_aways: number;
  threw_drops: number;
  pulls: number;
};

/** One player's event-derived stats within one recorded point. */
export type PointStats = {
  pointNumber: number;
  players: Array<{
    name: string;
    isSubstitute: boolean;
    counts: PointStatCounts;
    touches: number;
  }>;
};

/**
 * The canonical per-point stat derivation of a game. Warnings are explicit:
 * an event that should attribute a stat but has no actor, or a drop that
 * pairs with no preceding pass, is surfaced, never repaired silently.
 */
export type PointStatsPayload = {
  points: PointStats[];
  /** Game-wide totals per player, the sum of their per-point counts. */
  totals: Array<{ name: string; isSubstitute: boolean; counts: PointStatCounts }>;
  warnings: QualityWarning[];
};

/** Case-insensitive identity key over a raw ref, matching the normalize layer. */
function identityKey(raw: RawPlayerRef): string {
  return normalizePlayerRef(raw).name.toLowerCase();
}

/** An all-zero count set for a fresh bucket. */
function emptyCounts(): PointStatCounts {
  return {
    goals: 0,
    assists: 0,
    second_assists: 0,
    d_blocks: 0,
    completions: 0,
    catches: 0,
    drops: 0,
    throw_aways: 0,
    threw_drops: 0,
    pulls: 0,
  };
}

/** Fold one point's counts into a totals bucket, dimension by dimension. */
function addCounts(target: PointStatCounts, source: PointStatCounts): void {
  target.goals += source.goals;
  target.assists += source.assists;
  target.second_assists += source.second_assists;
  target.d_blocks += source.d_blocks;
  target.completions += source.completions;
  target.catches += source.catches;
  target.drops += source.drops;
  target.throw_aways += source.throw_aways;
  target.threw_drops += source.threw_drops;
  target.pulls += source.pulls;
}

/** Per-point accumulating bucket for one player identity. */
type PointBucket = {
  name: string;
  isSubstitute: boolean;
  counts: PointStatCounts;
  touches: number;
};

/**
 * Derive per-point stat counts for a canonical game payload by replaying each
 * point's event stream: PULL awards pulls, PASS awards completions and catches
 * (and assists when the receiver scores next, nothing when the receiver drops
 * next), POINT awards goals and second assists, DEFENSE awards d_blocks,
 * THROWAWAY awards throw_aways, and DROP pairs with the preceding pass to
 * award threw_drops and drops (an unpaired drop is an explicit warning).
 * Identity is case-insensitive with terminal `(S)` stripping, so casing
 * variants such as `Nadine Cann` vs `Nadine cann` merge into one player.
 * Every recorded line player and event actor receives a per-point entry, with
 * all-zero counts when they had no events; a player on both lines of one
 * point receives exactly one entry, taking the offense recording. `touches`
 * counts every event the player acted in, both actors per event, PULL
 * included. The input payload is never mutated.
 */
export function buildPointStats(payload: GamePayload): PointStatsPayload {
  const warnings: QualityWarning[] = [];

  // Game-wide totals keyed by case-insensitive identity, first recorded wins.
  const totalsByKey = new Map<string, PointStatsPayload["totals"][number]>();

  const points: PointStats[] = payload.game.points.map((point) => {
    const buckets = new Map<string, PointBucket>();

    const bucketFor = (raw: RawPlayerRef): PointBucket => {
      const key = identityKey(raw);
      let bucket = buckets.get(key);
      if (bucket === undefined) {
        const ref = normalizePlayerRef(raw);
        bucket = {
          name: ref.name,
          isSubstitute: ref.isSubstitute,
          counts: emptyCounts(),
          touches: 0,
        };
        buckets.set(key, bucket);
      }
      return bucket;
    };

    // Every recorded line player gets an entry, even with no events. The
    // offense row registers first, so a player on both rows takes the
    // offense recording, matching the salary engine's lineOf precedence.
    for (const player of [...point.offensePlayers, ...point.defensePlayers]) {
      bucketFor(player.raw);
    }

    const events = point.events;
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      const next = events[i + 1];

      // Touches count actor appearances regardless of stat attribution; an
      // event with two actors touches both, and PULL counts as a touch.
      if (event.firstActor !== null) bucketFor(event.firstActor).touches += 1;
      if (event.secondActor !== null) bucketFor(event.secondActor).touches += 1;

      switch (event.type) {
        case "PULL":
          if (event.firstActor === null) {
            warnings.push({
              code: "POINT_STATS_MISSING_EVENT_ACTOR",
              message: `Point ${point.pointNumber} has a PULL at event ${i} with no actor; no pull stats applied.`,
              pointNumber: point.pointNumber,
            });
            break;
          }
          bucketFor(event.firstActor).counts.pulls += 1;
          break;
        case "PASS": {
          const thrower = event.firstActor;
          const receiver = event.secondActor;
          if (thrower === null || receiver === null) {
            warnings.push({
              code: "POINT_STATS_MISSING_EVENT_ACTOR",
              message: `Point ${point.pointNumber} has a PASS at event ${i} with a missing thrower or receiver; no pass stats applied.`,
              pointNumber: point.pointNumber,
            });
            break;
          }
          // Dropped pass: the next DROP by the recorded receiver. The DROP
          // event itself awards the threw-drop and drop counts.
          if (
            next !== undefined &&
            next.type === "DROP" &&
            next.firstActor !== null &&
            identityKey(next.firstActor) === identityKey(receiver)
          ) {
            break;
          }
          // Assist pass: the PASS immediately before a POINT scored by its
          // receiver also awards the assist; otherwise only the completion.
          if (
            next !== undefined &&
            next.type === "POINT" &&
            next.firstActor !== null &&
            identityKey(next.firstActor) === identityKey(receiver)
          ) {
            bucketFor(thrower).counts.assists += 1;
          }
          bucketFor(thrower).counts.completions += 1;
          bucketFor(receiver).counts.catches += 1;
          break;
        }
        case "POINT": {
          const scorer = event.firstActor;
          if (scorer === null) {
            warnings.push({
              code: "POINT_STATS_MISSING_EVENT_ACTOR",
              message: `Point ${point.pointNumber} has a POINT at event ${i} with no scorer; no goal stats applied.`,
              pointNumber: point.pointNumber,
            });
            break;
          }
          // Second assist: the thrower two events back, only when both the
          // previous and the pre-previous events are passes with a recorded
          // thrower.
          const priorThrower = i >= 2 ? events[i - 2].firstActor : null;
          if (
            i >= 2 &&
            events[i - 1].type === "PASS" &&
            events[i - 2].type === "PASS" &&
            priorThrower !== null
          ) {
            bucketFor(priorThrower).counts.second_assists += 1;
          }
          bucketFor(scorer).counts.goals += 1;
          break;
        }
        case "DEFENSE":
          if (event.firstActor === null) {
            warnings.push({
              code: "POINT_STATS_MISSING_EVENT_ACTOR",
              message: `Point ${point.pointNumber} has a DEFENSE at event ${i} with no actor; no defense stats applied.`,
              pointNumber: point.pointNumber,
            });
            break;
          }
          bucketFor(event.firstActor).counts.d_blocks += 1;
          break;
        case "THROWAWAY":
          if (event.firstActor === null) {
            warnings.push({
              code: "POINT_STATS_MISSING_EVENT_ACTOR",
              message: `Point ${point.pointNumber} has a THROWAWAY at event ${i} with no actor; no throwaway stats applied.`,
              pointNumber: point.pointNumber,
            });
            break;
          }
          bucketFor(event.firstActor).counts.throw_aways += 1;
          break;
        case "DROP": {
          // A drop pairs with the preceding PASS when that PASS's receiver is
          // the dropper; anything else is an unmatched drop.
          const dropper = event.firstActor;
          const prev = i > 0 ? events[i - 1] : null;
          if (
            dropper !== null &&
            prev !== null &&
            prev.type === "PASS" &&
            prev.firstActor !== null &&
            prev.secondActor !== null &&
            identityKey(prev.secondActor) === identityKey(dropper)
          ) {
            bucketFor(prev.firstActor).counts.threw_drops += 1;
            bucketFor(dropper).counts.drops += 1;
          } else {
            warnings.push({
              code: "UNMATCHED_DROP",
              message: `Point ${point.pointNumber} has a DROP at event ${i} not paired with the receiver of the preceding PASS.`,
              pointNumber: point.pointNumber,
              player: dropper ?? undefined,
            });
          }
          break;
        }
        default:
          break;
      }
    }

    // Fold this point's counts into the game-wide totals by identity.
    for (const bucket of buckets.values()) {
      const key = bucket.name.toLowerCase();
      let entry = totalsByKey.get(key);
      if (entry === undefined) {
        entry = {
          name: bucket.name,
          isSubstitute: bucket.isSubstitute,
          counts: emptyCounts(),
        };
        totalsByKey.set(key, entry);
      }
      addCounts(entry.counts, bucket.counts);
    }

    return {
      pointNumber: point.pointNumber,
      players: [...buckets.values()].map((bucket) => ({
        name: bucket.name,
        isSubstitute: bucket.isSubstitute,
        counts: bucket.counts,
        touches: bucket.touches,
      })),
    };
  });

  return {
    points,
    totals: [...totalsByKey.values()],
    warnings,
  };
}

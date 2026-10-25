import type {
  GamePayload,
  QualityWarning,
  RawPlayerRef,
  TeamSource,
} from "../domain/types.js";
import { normalizePlayerRef, resolvePlayerTeam } from "../data/normalize.js";

/** Amounts are canonical project rules for supported v2 leagues. */
const RULE_AMOUNTS = {
  GOAL: 10000,
  ASSIST: 10000,
  SECOND_ASSIST: 8000,
  DEFENSE: 8000,
  COMPLETION: 500,
  CATCH: 500,
  HOLD: 1000,
  BREAK: 2000,
  THROWAWAY: -5000,
  THREW_DROP: -1000,
  DROP: -4000,
} as const;

export type SalaryRuleName = keyof typeof RULE_AMOUNTS;

/** One salary component produced by one salary rule application. */
export type SalaryComponent = {
  type: "SALARY_RULE";
  ruleName: SalaryRuleName;
  amount: number;
  eventIndex: number | null;
  actor: RawPlayerRef | null;
};

/** One player's event-derived salary within one recorded point. */
export type PlayerPointSalary = {
  name: string;
  isSubstitute: boolean;
  teamSource: TeamSource;
  total: number;
  components: SalaryComponent[];
};

/** The salary ledger of one recorded point, lines preserved as recorded. */
export type PointSalary = {
  pointNumber: number;
  offensePlayers: RawPlayerRef[];
  defensePlayers: RawPlayerRef[];
  playerSalaries: PlayerPointSalary[];
};

/** One player's game-wide derived salary total. */
export type PlayerSalaryTotal = {
  name: string;
  isSubstitute: boolean;
  teamSource: TeamSource;
  total: number;
};

/**
 * The canonical salary ledger of a game. Warnings are explicit: any
 * reconciliation failure or unreconcilable event is surfaced, never repaired
 * silently.
 */
export type SalaryLedger = {
  rulesName: string;
  rulesVersion: number;
  points: PointSalary[];
  totals: PlayerSalaryTotal[];
  warnings: QualityWarning[];
};

/** Case-insensitive identity key over a raw ref, matching the normalize layer. */
function identityKey(raw: RawPlayerRef): string {
  return normalizePlayerRef(raw).name.toLowerCase();
}

/** Per-point accumulating bucket for one player identity. */
type PointBucket = {
  name: string;
  isSubstitute: boolean;
  components: SalaryComponent[];
};

/**
 * Derive the salary ledger for a canonical game payload.
 * Applies the project's canonical v2 salary rules event by event, per recorded
 * point. Identity is case-insensitive with terminal `(S)` stripping, so casing
 * variants such as `Nadine Cann` vs `Nadine cann` merge into one player.
 * Every stats player receives a total, and every recorded line player and
 * event actor receives a per-point entry. Event actors outside the recorded
 * lines earn event-specific salary only, never line-specific salary.
 * The input payload is never mutated.
 */
export function buildSalaryLedger(payload: GamePayload): SalaryLedger {
  const warnings: QualityWarning[] = [];

  // Identity registry across the whole game: lowercased stripped name.
  const nameByKey = new Map<string, string>();
  const isSubByKey = new Map<string, boolean>();
  const register = (raw: RawPlayerRef | null): void => {
    if (raw === null) return;
    const ref = normalizePlayerRef(raw);
    const key = ref.name.toLowerCase();
    if (!nameByKey.has(key)) {
      nameByKey.set(key, ref.name);
      // Stat rows own substitute status for an identity when present.
      isSubByKey.set(key, ref.isSubstitute);
    }
  };
  for (const stat of payload.stats) register(stat.raw);
  for (const point of payload.game.points) {
    for (const player of [...point.offensePlayers, ...point.defensePlayers]) {
      register(player.raw);
    }
    for (const event of point.events) {
      register(event.firstActor);
      register(event.secondActor);
    }
  }

  const bucketFor = (
    buckets: Map<string, PointBucket>,
    raw: RawPlayerRef,
  ): PointBucket => {
    const key = identityKey(raw);
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = {
        name: nameByKey.get(key) ?? normalizePlayerRef(raw).name,
        isSubstitute: isSubByKey.get(key) ?? normalizePlayerRef(raw).isSubstitute,
        components: [],
      };
      buckets.set(key, bucket);
    }
    return bucket;
  };

  const points: PointSalary[] = payload.game.points.map((point) => {
    const buckets = new Map<string, PointBucket>();
    // Every recorded line player gets a per-point entry, even with zero salary.
    for (const player of [...point.offensePlayers, ...point.defensePlayers]) {
      bucketFor(buckets, player.raw);
    }

    const add = (
      raw: RawPlayerRef,
      ruleName: SalaryRuleName,
      eventIndex: number | null,
    ): void => {
      bucketFor(buckets, raw).components.push({
        type: "SALARY_RULE",
        ruleName,
        amount: RULE_AMOUNTS[ruleName],
        eventIndex,
        actor: raw,
      });
    };

    const lineOf = (raw: RawPlayerRef): "offense" | "defense" | null => {
      const key = identityKey(raw);
      if (point.offensePlayers.some((p) => identityKey(p.raw) === key)) return "offense";
      if (point.defensePlayers.some((p) => identityKey(p.raw) === key)) return "defense";
      return null;
    };

    const events = point.events;
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      const next = events[i + 1];
      switch (event.type) {
        case "PULL":
          // PULL contributes no salary.
          break;
        case "PASS": {
          const thrower = event.firstActor;
          const receiver = event.secondActor;
          if (thrower === null || receiver === null) {
            warnings.push({
              code: "SALARY_MISSING_EVENT_ACTOR",
              message: `Point ${point.pointNumber} has a PASS at event ${i} with a missing thrower or receiver; no pass salary applied.`,
              pointNumber: point.pointNumber,
            });
            break;
          }
          // Dropped pass: the next DROP by the recorded receiver. The DROP
          // event itself awards the drop and throw-drop components.
          if (
            next !== undefined &&
            next.type === "DROP" &&
            next.firstActor !== null &&
            identityKey(next.firstActor) === identityKey(receiver)
          ) {
            break;
          }
          // Assist pass: the PASS immediately before a POINT scored by its receiver.
          if (
            next !== undefined &&
            next.type === "POINT" &&
            next.firstActor !== null &&
            identityKey(next.firstActor) === identityKey(receiver)
          ) {
            add(thrower, "COMPLETION", i);
            add(thrower, "ASSIST", i);
            add(receiver, "CATCH", i);
            break;
          }
          add(thrower, "COMPLETION", i);
          add(receiver, "CATCH", i);
          break;
        }
        case "POINT": {
          const scorer = event.firstActor;
          if (scorer === null) {
            warnings.push({
              code: "SALARY_MISSING_EVENT_ACTOR",
              message: `Point ${point.pointNumber} has a POINT at event ${i} with no scorer; no goal salary applied.`,
              pointNumber: point.pointNumber,
            });
            break;
          }
          // Second assist: the PASS before the assist PASS, when that previous
          // event is also a PASS. It precedes the goal in component order.
          if (i >= 2 && events[i - 1].type === "PASS" && events[i - 2].type === "PASS" && events[i - 2].firstActor !== null) {
            add(events[i - 2].firstActor as RawPlayerRef, "SECOND_ASSIST", i - 2);
          }
          add(scorer, "GOAL", i);
          const line = lineOf(scorer);
          if (line === "offense") {
            for (const player of point.offensePlayers) {
              add(player.raw, "HOLD", i);
            }
          } else if (line === "defense") {
            for (const player of point.defensePlayers) {
              add(player.raw, "BREAK", i);
            }
          }
          // No line-specific salary when the scorer is on neither recorded line.
          break;
        }
        case "DEFENSE":
          if (event.firstActor === null) {
            warnings.push({
              code: "SALARY_MISSING_EVENT_ACTOR",
              message: `Point ${point.pointNumber} has a DEFENSE at event ${i} with no actor; no defense salary applied.`,
              pointNumber: point.pointNumber,
            });
          } else {
            add(event.firstActor, "DEFENSE", i);
          }
          break;
        case "THROWAWAY":
          if (event.firstActor === null) {
            warnings.push({
              code: "SALARY_MISSING_EVENT_ACTOR",
              message: `Point ${point.pointNumber} has a THROWAWAY at event ${i} with no actor; no throwaway salary applied.`,
              pointNumber: point.pointNumber,
            });
          } else {
            add(event.firstActor, "THROWAWAY", i);
          }
          break;
        case "DROP": {
          // Drop is paired with the preceding PASS when that PASS's receiver is the dropper.
          const dropper = event.firstActor;
          const prev = i > 0 && events[i - 1].type === "PASS" ? events[i - 1] : null;
          if (
            dropper !== null &&
            prev !== null &&
            prev.firstActor !== null &&
            prev.secondActor !== null &&
            identityKey(prev.secondActor) === identityKey(dropper)
          ) {
            add(prev.firstActor, "THREW_DROP", i - 1);
            add(dropper, "DROP", i);
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

    const playerSalaries = [...buckets.values()].map((bucket): PlayerPointSalary => ({
      ...bucket,
      teamSource: "unknown",
      total: bucket.components.reduce((sum, component) => sum + component.amount, 0),
    }));

    return {
      pointNumber: point.pointNumber,
      offensePlayers: point.offensePlayers.map((p) => p.raw),
      defensePlayers: point.defensePlayers.map((p) => p.raw),
      playerSalaries,
    };
  });

  // Per-point teamSource resolution (cached per identity across the ledger).
  const teamSourceCache = new Map<string, TeamSource>();
  const teamSourceFor = (name: string): TeamSource => {
    const key = name.toLowerCase();
    let cached = teamSourceCache.get(key);
    if (cached === undefined) {
      cached = resolvePlayerTeam(name, payload).teamSource;
      teamSourceCache.set(key, cached);
    }
    return cached;
  };
  for (const point of points) {
    for (const salary of point.playerSalaries) {
      salary.teamSource = teamSourceFor(salary.name);
    }
  }

  // Game-wide totals keyed by case-insensitive identity.
  const totalsByKey = new Map<string, { name: string; isSubstitute: boolean; total: number }>();
  for (const point of points) {
    for (const salary of point.playerSalaries) {
      const key = salary.name.toLowerCase();
      const entry = totalsByKey.get(key) ?? { name: salary.name, isSubstitute: salary.isSubstitute, total: 0 };
      entry.total += salary.total;
      totalsByKey.set(key, entry);
    }
  }

  // Every stats player appears in totals, reconciled against the API `pay`.
  const totals: PlayerSalaryTotal[] = payload.stats.map((stat) => {
    const key = stat.name.toLowerCase();
    const derived = totalsByKey.get(key);
    const total = derived !== undefined ? derived.total : 0;
    if (stat.pay !== total) {
      warnings.push({
        code: "SALARY_RECONCILIATION_MISMATCH",
        message: `${stat.raw}: derived salary ${total} does not match API pay ${stat.pay}.`,
        player: stat.raw,
      });
    }
    return {
      name: stat.name,
      isSubstitute: stat.isSubstitute,
      teamSource: teamSourceFor(stat.raw),
      total,
    };
  });

  // Identities earning salary with no stats row are explicit unknowns.
  for (const [key, entry] of totalsByKey) {
    const hasStatsRow = payload.stats.some((s) => s.name.toLowerCase() === key);
    if (!hasStatsRow) {
      warnings.push({
        code: "SALARY_UNKNOWN_PLAYER",
        message: `${entry.name}: earned derived salary ${entry.total} but has no stats row in this game.`,
        player: entry.name,
      });
    }
  }

  return {
    rulesName: "parity-v2",
    rulesVersion: 1,
    points,
    totals,
    warnings,
  };
}

/**
 * Salary association between the two players of one interaction pair: what
 * each player earned while the pair was on the field together. This is the
 * summary reused by interactions later; the full components stay in the
 * ledger. Player salaries are matched by case-insensitive identity.
 */
export function pairSalary(
  ledger: SalaryLedger,
  pointsTogether: ReadonlySet<number>,
  playerA: string,
  playerB: string,
): { a: number; b: number } {
  const keyA = normalizePlayerRef(playerA).name.toLowerCase();
  const keyB = normalizePlayerRef(playerB).name.toLowerCase();
  let a = 0;
  let b = 0;
  for (const point of ledger.points) {
    if (!pointsTogether.has(point.pointNumber)) continue;
    for (const salary of point.playerSalaries) {
      const key = salary.name.toLowerCase();
      if (key === keyA) a += salary.total;
      if (key === keyB) b += salary.total;
    }
  }
  return { a, b };
}

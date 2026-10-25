import type {
  GamePayload,
  PlayerExposure,
  QualityWarning,
  RawPlayerRef,
} from "../domain/types.js";
import type { SalaryLedger } from "./salary.js";
import { normalizePlayerRef, resolvePlayerTeam } from "../data/normalize.js";

export type { PlayerExposure };

/**
 * The role a player held on one recorded point: which raw line row they were
 * recorded on. `null` when the player is not on either line, which only
 * happens for event actors, and event actors never receive pair salary
 * points.
 */
export type LineRole = "offense" | "defense" | null;

/**
 * One shared point of an interaction pair: the raw recorded line row, the
 * role of each pair member when known, and the per-player salary summary for
 * that point as recorded in the salary ledger. The raw line is preserved
 * exactly as recorded, including extra or duplicate players; it is never
 * trimmed to the league lineSize.
 */
export type PairSalaryPoint = {
  pointNumber: number;
  /** The raw recorded line rows for this point, exactly as captured. */
  line: { offense: RawPlayerRef[]; defense: RawPlayerRef[] };
  /** Which raw line row each pair member was recorded on, when known. */
  roleA: LineRole;
  roleB: LineRole;
  /** The point's derived duration in seconds, when available. */
  durationSec: number | null;
  /** Each pair member's salary summary for this point from the ledger. */
  salaryA: number;
  salaryB: number;
};

/**
 * One interaction pair between two players across the whole game. The pair
 * kind is implied by which list contains it: `teammatePairs` for players
 * recorded on the same raw line row of a point, `opponentPairs` for players
 * recorded on opposite raw line rows of the same point.
 */
export type InteractionPair = {
  /** Normalized display name of the first member (canonical casing). */
  playerA: string;
  /** Normalized display name of the second member (canonical casing). */
  playerB: string;
  /** Identity of the pair: one per unordered member pair per kind. */
  kind: "teammate" | "opponent";
  /** Point numbers where the pair co-occurred, ascending and unique. */
  pointsTogether: number[];
  /** Per-point salary summaries in the same order as `pointsTogether`. */
  salaryPoints: PairSalaryPoint[];
};

/** The canonical interactions payload derived from a game and salary ledger. */
export type InteractionsPayload = {
  teammatePairs: InteractionPair[];
  opponentPairs: InteractionPair[];
  exposures: PlayerExposure[];
  warnings: QualityWarning[];
};

/** Case-insensitive identity key over a raw ref, matching the normalize layer. */
function identityKey(raw: RawPlayerRef): string {
  return normalizePlayerRef(raw).name.toLowerCase();
}

/** Unordered pair key over two identity keys. */
function pairKey(keyA: string, keyB: string): string {
  return keyA < keyB ? `${keyA}\u0000${keyB}` : `${keyB}\u0000${keyA}`;
}

/**
 * One accumulating pair record for a single kind. The identity key that sorts
 * first is member A; the other is member B. Salary summaries are stored so
 * that salaryA always belongs to playerA's identity.
 */
type PairRecord = {
  playerA: string;
  playerB: string;
  points: number[];
  salaryPoints: PairSalaryPoint[];
};

/**
 * Derive teammate and opponent interaction pairs and per-player team
 * exposures for a canonical game payload, associating per-point salary
 * summaries from the canonical salary ledger.
 *
 * Raw recorded lines are the sole source of pairings and exposure counts:
 * every recorded line player counts exactly once per point per row, event
 * actors outside the lines create no pair and no exposure, and lines are never
 * trimmed to the league lineSize. Malformed line data (size mismatch or a
 * duplicate within one row) is preserved and warned explicitly. The input
 * payload and ledger are never mutated.
 */
export function buildInteractions(
  payload: GamePayload,
  salaryLedger: SalaryLedger,
): InteractionsPayload {
  const warnings: QualityWarning[] = [];
  const lineSize = payload.league.lineSize;

  const ledgerPointByNumber = new Map(
    salaryLedger.points.map((point) => [point.pointNumber, point]),
  );

  // Canonical display name per identity, first recorded wins.
  const nameByKey = new Map<string, string>();
  const register = (raw: RawPlayerRef): void => {
    const key = identityKey(raw);
    if (!nameByKey.has(key)) {
      nameByKey.set(key, normalizePlayerRef(raw).name);
    }
  };

  const teammatePairs = new Map<string, PairRecord>();
  const opponentPairs = new Map<string, PairRecord>();
  // Identity key -> pointNumber, for exposure counts.
  const playerPointKeys = new Map<string, number[]>();

  for (const point of payload.game.points) {
    const pointNumber = point.pointNumber;

    // Dedup within a row by identity: a duplicate recording warns but pairs once.
    const seen = new Map<string, LineRole>();

    const dedupeRow = (
      row: RawPlayerRef[],
      role: Exclude<LineRole, null>,
    ): string[] => {
      const keys: string[] = [];
      const rowSeen = new Set<string>();
      for (const raw of row) {
        const key = identityKey(raw);
        if (rowSeen.has(key)) {
          warnings.push({
            code: "INTERACTION_DUPLICATE_LINE_PLAYER",
            message: `Point ${pointNumber} ${role} line records ${raw} more than once; the duplicate is not paired separately.`,
            pointNumber,
            player: raw,
          });
          continue;
        }
        rowSeen.add(key);
        keys.push(key);
        register(raw);
        if (!seen.has(key)) seen.set(key, role);
      }
      return keys;
    };

    const offenseKeys = dedupeRow(
      point.offensePlayers.map((player) => player.raw),
      "offense",
    );
    const defenseKeys = dedupeRow(
      point.defensePlayers.map((player) => player.raw),
      "defense",
    );

    if (point.offensePlayers.length !== lineSize) {
      warnings.push({
        code: "INTERACTION_LINE_SIZE_MISMATCH",
        message: `Point ${pointNumber} offense line has ${point.offensePlayers.length} players, league lineSize is ${lineSize}; the recorded line is preserved untrimmed.`,
        pointNumber,
      });
    }
    if (point.defensePlayers.length !== lineSize) {
      warnings.push({
        code: "INTERACTION_LINE_SIZE_MISMATCH",
        message: `Point ${pointNumber} defense line has ${point.defensePlayers.length} players, league lineSize is ${lineSize}; the recorded line is preserved untrimmed.`,
        pointNumber,
      });
    }

    const salaryTotals = new Map<string, number>();
    const ledgerPoint = ledgerPointByNumber.get(pointNumber);
    if (ledgerPoint !== undefined) {
      for (const salary of ledgerPoint.playerSalaries) {
        salaryTotals.set(salary.name.toLowerCase(), salary.total);
      }
    }
    const salaryFor = (keyA: string, keyB: string): PairSalaryPoint => {
      return {
        pointNumber,
        line: {
          offense: point.offensePlayers.map((player) => player.raw),
          defense: point.defensePlayers.map((player) => player.raw),
        },
        roleA: seen.get(keyA) ?? null,
        roleB: seen.get(keyB) ?? null,
        durationSec: point.durationSec,
        salaryA: salaryTotals.get(keyA) ?? 0,
        salaryB: salaryTotals.get(keyB) ?? 0,
      };
    };

    const record = (
      players: Map<string, PairRecord>,
      keyA: string,
      keyB: string,
    ): void => {
      const key = pairKey(keyA, keyB);
      let record = players.get(key);
      const firstKey = keyA < keyB ? keyA : keyB;
      const secondKey = keyA < keyB ? keyB : keyA;
      if (record === undefined) {
        record = {
          playerA: nameByKey.get(firstKey) ?? firstKey,
          playerB: nameByKey.get(secondKey) ?? secondKey,
          points: [],
          salaryPoints: [],
        };
        players.set(key, record);
      }
      record.points.push(pointNumber);
      const summary = salaryFor(firstKey, secondKey);
      record.salaryPoints.push(summary);
    };

    // Teammates: unordered pairs within each recorded row.
    const recordRowPairs = (row: string[], players: Map<string, PairRecord>): void => {
      for (let i = 0; i < row.length; i++) {
        for (let j = i + 1; j < row.length; j++) {
          record(players, row[i] as string, row[j] as string);
        }
      }
    };
    recordRowPairs(offenseKeys, teammatePairs);
    recordRowPairs(defenseKeys, teammatePairs);

    // Opponents: unordered cross-row pairs of the same point.
    for (const offenseKey of offenseKeys) {
      for (const defenseKey of defenseKeys) {
        record(opponentPairs, offenseKey, defenseKey);
      }
    }

    // Exposure: one count per recorded player identity per point. A player
    // recorded on both rows of one point still counts once.
    const allRowKeys = [...offenseKeys, ...defenseKeys];
    for (const key of new Set(allRowKeys)) {
      const points = playerPointKeys.get(key) ?? [];
      points.push(pointNumber);
      playerPointKeys.set(key, points);
    }
  }

  const toInteractionPair = (record: PairRecord, kind: "teammate" | "opponent"): InteractionPair => ({
    playerA: record.playerA,
    playerB: record.playerB,
    kind,
    pointsTogether: [...record.points],
    salaryPoints: [...record.salaryPoints],
  });

  const exposures: PlayerExposure[] = [];
  for (const [key, points] of playerPointKeys) {
    const name = nameByKey.get(key) ?? key;
    const resolved = resolvePlayerTeam(name, payload);
    if (resolved.teamSource === "unknown" || resolved.team === null) {
      warnings.push({
        code: "INTERACTION_UNRESOLVED_EXPOSURE_TEAM",
        message: `${name} has no resolvable team for exposure in game ${payload.game.id}; no exposure counted.`,
        player: name,
      });
      continue;
    }
    const teamIndex =
      resolved.team === payload.game.homeTeam
        ? 0
        : resolved.team === payload.game.awayTeam
          ? 1
          : null;
    if (teamIndex === null) {
      warnings.push({
        code: "INTERACTION_UNRESOLVED_EXPOSURE_TEAM",
        message: `${name} resolves to team ${resolved.team}, which is neither home (${payload.game.homeTeam}) nor away (${payload.game.awayTeam}); no exposure counted.`,
        player: name,
      });
      continue;
    }
    exposures.push({
      name,
      teamIndex,
      exposures: points.length,
      teamSource: resolved.teamSource,
    });
  }

  return {
    teammatePairs: [...teammatePairs.values()].map((record) =>
      toInteractionPair(record, "teammate"),
    ),
    opponentPairs: [...opponentPairs.values()].map((record) =>
      toInteractionPair(record, "opponent"),
    ),
    exposures,
    warnings,
  };
}

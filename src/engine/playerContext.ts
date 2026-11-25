import { normalizePlayerRef } from "../data/normalize.js";
import type {
  GamePayload,
  PlayerContextBlock,
  PlayerContextFormerTeam,
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
 * A roster name's franchise label: the trailing parenthesised captain label
 * ("Team Des (Des)" is "Des"), or the whole trimmed name when no label is
 * present. Labels are the franchise identity and do not change in a season.
 */
function franchiseLabel(teamName: string): string {
  const trimmed = teamName.trim();
  const match = /\(([^)]*)\)\s*$/.exec(trimmed);
  return match !== null ? match[1] : trimmed;
}

/** One registered (non-substitute) roster appearance in an earlier week. */
type RegisteredAppearance = {
  week: number;
  label: string;
  team: string;
};

/** True when a listed row can be used as transition evidence. */
function usableRow(row: PriorGameRow): boolean {
  return (
    row.status === "final" &&
    row.homeRoster.length > 0 &&
    row.awayRoster.length > 0
  );
}

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

  const week = payload.game.week;
  const usable = prior.rows.filter(usableRow);
  const unaccounted: number[] = [];
  for (let w = 1; w < week; w++) {
    if (!usable.some((row) => row.week === w)) {
      unaccounted.push(w);
    }
  }
  const gapNote =
    unaccounted.length > 0
      ? `Earlier weeks without usable data: weeks ${unaccounted.join(", ")}.`
      : null;

  // Registered appearances per identity key, from roster membership only.
  // A roster entry carrying the (S) marker is a substitute stint and is
  // never team membership.
  const apps = new Map<string, RegisteredAppearance[]>();
  const names = new Map<string, string>();
  for (const row of usable) {
    for (const [teamName, roster] of [
      [row.homeTeam, row.homeRoster],
      [row.awayTeam, row.awayRoster],
    ] as const) {
      for (const raw of roster) {
        const ref = normalizePlayerRef(raw);
        if (ref.isSubstitute) continue;
        const key = ref.name.toLowerCase();
        names.set(key, ref.name);
        const list = apps.get(key) ?? [];
        list.push({
          week: row.week,
          label: franchiseLabel(teamName),
          team: teamName,
        });
        apps.set(key, list);
      }
    }
  }

  const homeLabel = franchiseLabel(payload.game.homeTeam);
  const awayLabel = franchiseLabel(payload.game.awayTeam);
  const transitions: PlayerContextBlock["transitions"] = [];

  const todayPlayers = new Map<string, string>();
  for (const raw of [
    ...payload.game.homeRoster,
    ...payload.game.awayRoster,
  ]) {
    const ref = normalizePlayerRef(raw);
    if (ref.isSubstitute) continue;
    todayPlayers.set(ref.name.toLowerCase(), ref.name);
  }

  for (const [key, todayName] of todayPlayers) {
    const isHome = payload.game.homeRoster.some(
      (r) => normalizePlayerRef(r).name.toLowerCase() === key,
    );
    const team = isHome ? payload.game.homeTeam : payload.game.awayTeam;
    const label = isHome ? homeLabel : awayLabel;
    const opponentLabel = isHome ? awayLabel : homeLabel;

    const priorApps = apps.get(key) ?? [];

    // Two distinct franchises in one earlier week is ambiguous data: never
    // choose between them, drop the player's transition rows entirely.
    const byWeek = new Map<number, Set<string>>();
    for (const app of priorApps) {
      const labels = byWeek.get(app.week) ?? new Set<string>();
      labels.add(app.label);
      byWeek.set(app.week, labels);
    }
    if ([...byWeek.values()].some((labels) => labels.size > 1)) continue;

    const priorWeeks = priorApps.map((app) => app.week);
    const latest = priorApps.find(
      (app) => app.week === Math.max(...priorWeeks),
    );
    const priorLabels = new Set(priorApps.map((app) => app.label));
    const tradeDebut = latest !== undefined && latest.label !== label;
    // A return means they were traded away from today's franchise and traded
    // back: the franchise is in their history AND they most recently played
    // elsewhere. Continuity (same franchise last week) is not a return.
    const returnToFranchise = tradeDebut && priorLabels.has(label);
    const teamNumberSet = new Set([label, ...priorLabels]);
    const teamNumber = teamNumberSet.size > 1 ? teamNumberSet.size : null;
    // A first appearance needs a registered appearance today, no registered
    // appearance in any earlier week, and every earlier week accounted for
    // by a usable row: absence of evidence is never the claim.
    const firstAppearance =
      priorApps.length === 0 && unaccounted.length === 0;

    const byLabel = new Map<string, RegisteredAppearance[]>();
    for (const app of priorApps) {
      if (app.label === label) continue;
      const list = byLabel.get(app.label) ?? [];
      list.push(app);
      byLabel.set(app.label, list);
    }
    const formerTeams: PlayerContextFormerTeam[] = [...byLabel.entries()]
      .map(([formerLabel, list]) => {
        const latestForLabel = list.reduce((a, b) => (b.week > a.week ? b : a));
        return {
          team: latestForLabel.team,
          franchiseLabel: formerLabel,
          weeks: list.map((app) => app.week).sort((a, b) => a - b),
        };
      })
      .sort((a, b) => a.franchiseLabel.localeCompare(b.franchiseLabel));
    const opponentFormerTeams = formerTeams.filter(
      (former) => former.franchiseLabel === opponentLabel,
    );

    if (
      tradeDebut ||
      returnToFranchise ||
      firstAppearance ||
      (teamNumber !== null && teamNumber >= 3) ||
      opponentFormerTeams.length > 0
    ) {
      transitions.push({
        player: names.get(key) ?? todayName,
        team,
        franchiseLabel: label,
        priorTeam: latest?.team ?? null,
        priorWeek: latest?.week ?? null,
        tradeDebut,
        returnToFranchise,
        teamNumber,
        firstAppearance,
        formerTeams,
        opponentFormerTeams,
      });
    }
  }

  transitions.sort((a, b) => a.player.localeCompare(b.player));

  return {
    substitutes,
    transitions,
    priorDataAvailable: true,
    note: gapNote,
  };
}

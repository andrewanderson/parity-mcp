import { normalizePlayerRef, resolvePlayerTeam } from "../data/normalize.js";
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
      // Resolve through the existing team-resolution rules: a raw stats team
      // of "Unknown" is invalid data, not an assignment.
      team: resolvePlayerTeam(stat.raw, payload).team,
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
  // Only strictly earlier weeks may contribute a prior appearance: today's
  // own final row and any later week are never transition evidence.
  const usable = prior.rows.filter(
    (row) => row.week >= 1 && row.week < week && usableRow(row),
  );
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
  const subPrior = new Set<string>();
  for (const row of usable) {
    for (const [teamName, roster] of [
      [row.homeTeam, row.homeRoster],
      [row.awayTeam, row.awayRoster],
    ] as const) {
      for (const raw of roster) {
        const ref = normalizePlayerRef(raw);
        const key = ref.name.toLowerCase();
        if (ref.isSubstitute) {
          // Recorded substitute play still means the player has appeared
          // this season: it suppresses first-appearance claims.
          subPrior.add(key);
          continue;
        }
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

  // Today's registered players and the side they are registered on. A
  // player registered on both rosters is ambiguous data: skip their
  // transitions. An (S) entry is a substitute stint for that side and never
  // decides a registered player's team.
  const todaySides = new Map<string, { side: "home" | "away" | "both"; name: string }>();
  for (const [side, roster] of [
    ["home", payload.game.homeRoster],
    ["away", payload.game.awayRoster],
  ] as const) {
    for (const raw of roster) {
      const ref = normalizePlayerRef(raw);
      if (ref.isSubstitute) continue;
      const key = ref.name.toLowerCase();
      const existing = todaySides.get(key);
      todaySides.set(
        key,
        existing === undefined
          ? { side, name: ref.name }
          : { side: "both", name: existing.name },
      );
    }
  }

  for (const [key, { side, name: todayName }] of todaySides) {
    if (side === "both") continue;
    const isHome = side === "home";
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
    // appearance in any earlier week, no recorded substitute appearance in
    // an earlier week (they have already played this season), and every
    // earlier week accounted for by a usable row: absence of evidence is
    // never the claim.
    const firstAppearance =
      priorApps.length === 0 &&
      unaccounted.length === 0 &&
      !subPrior.has(key);
    const priorWeeksOnTeam = priorApps
      .filter((app) => app.label === label)
      .map((app) => app.week)
      .sort((a, b) => a - b);

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
        player: todayName,
        team,
        franchiseLabel: label,
        priorTeam: latest?.team ?? null,
        priorWeek: latest?.week ?? null,
        tradeDebut,
        returnToFranchise,
        teamNumber,
        firstAppearance,
        priorWeeksOnTeam,
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

# Recap Player Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compute recap context (substitutes with resolved teams; roster
transitions: trade debuts, returns, Nth-franchise counts, first appearances,
former-team opponents) server-side, attach it to the canonical game payload,
and teach the parity-breakdown skill's fact sheet and prose rules to use it
editorially.

**Architecture:** A pure engine module (`buildPlayerContext`) derives the
`playerContext` block from the canonical payload plus prior-week list rows;
`gameForLeague` in server.ts fetches those rows with the existing
`source.listGames` (no points), attaches the block to the `FullGamePayload`
tolerantly, and it flows into `parity_get_game` output and the persisted
payload. SKILL.md gains fact-sheet item 10 and editorial prose rules.

**Tech Stack:** TypeScript, ESM, vitest, @modelcontextprotocol/sdk.

**Spec:** `D:\Code\Parity\parity-mcp\docs\superpowers\specs\2026-11-24-recap-player-context-design.md`

## Global Constraints

- League is the season: transitions derive only from earlier weeks of the
  current league. Never another league, never a later or current week.
- An `(S)` substitute stint is never team membership for transitions: it never
  grounds a debut, return, former-team, or first-appearance claim.
- Franchises are identified by the parenthesised captain label
  (`Team Des (Des)` label is `Des`); labels never change during a season. A
  rename reports no transition. A team name without a trailing
  parenthesised label is its own label.
- Absence is never a claim: `firstAppearance` only when every earlier week has
  at least one usable row (usable: `status` is `"final"` and both rosters
  present and non-empty) and the player has no registered appearance in any.
- Degradation over guessing: fetch failure degrades the block with
  `priorDataAvailable: false`; partial gaps keep `true` and name the
  unaccounted weeks in `note`. Exact note copy is fixed in the tasks.
- The block never mutates the input payload; the engine module stays pure
  (no source access). All async fetching lives in server.ts.
- Team/player identity: `normalizePlayerRef` (trim, case-insensitive, terminal
  `(S)` stripped). Never re-derive salaries or stats.
- Existing uncommitted changes in the repo (`src/index.ts`, `docs/`) belong to
  other work: commit steps add only the files each task names. Never
  `git add -A`.

## Review Focus

1. A renamed franchise (`Team Des (Des)` → `Swing Break (Des)`) must produce
   zero debut rows for its roster in the first week under the new name:
   `buildPlayerContext` matches by label, so no player of that franchise
   appears in `transitions` for the rename alone. (Task 2 test)
2. A substitute-only player, and a registered player whose only prior-week
   action was a borrowed `(S)` stint, must appear only in `substitutes`, never
   in `transitions`. (Task 2 test)
3. An unaccounted earlier week (no usable row) must suppress
   `firstAppearance` rows for every player whose only absence runs through
   it, with the weeks named in `note`; it must not silently claim
   "first game of the season". (Task 3 test)
4. A player with two registered appearances in one earlier week must get no
   transition rows (ambiguous, never chosen between). (Task 3 test)
5. A failing `listGames` must still return the full game payload with
   `priorDataAvailable: false` and a note, never throw and never fabricate an
   empty-but-checked block. (Task 4 test)

---

### Task 1: Domain types and the context skeleton (substitutes, week 1)

**Files:**
- Modify: `src/domain/types.ts` (append after `QualityReport`, near line 153)
- Create: `src/engine/playerContext.ts`
- Test: `test/playerContext.test.ts`

**Interfaces:**
- Consumes: `GamePayload`, `RawPlayerRef` from `../domain/types.js`;
  `normalizePlayerRef` from `../data/normalize.js`.
- Produces (later tasks rely on these exact names):

```ts
// src/domain/types.ts
export type PlayerContextFormerTeam = {
  team: string;            // recorded name, most recent for the franchise
  franchiseLabel: string;
  weeks: number[];
};
export type PlayerContextTransition = {
  player: string;
  team: string;
  franchiseLabel: string;
  priorTeam: string | null;
  priorWeek: number | null;
  tradeDebut: boolean;
  returnToFranchise: boolean;
  teamNumber: number | null;   // distinct franchises incl. today's; null when 1
  firstAppearance: boolean;
  formerTeams: PlayerContextFormerTeam[];
  opponentFormerTeams: PlayerContextFormerTeam[];
};
export type PlayerContextBlock = {
  substitutes: Array<{ player: string; team: string | null }>;
  transitions: PlayerContextTransition[];
  priorDataAvailable: boolean;
  /** Null, or one plain sentence: why prior data is unavailable, or which
   *  earlier weeks are unaccounted, or that the season's first week has no
   *  prior games. */
  note: string | null;
};
export type PriorGameRow = {
  id: number | string;
  week: number;
  status: string;
  homeTeam: string;
  awayTeam: string;
  homeRoster: RawPlayerRef[];
  awayRoster: RawPlayerRef[];
};

// src/engine/playerContext.ts
export type PriorGames =
  | { available: true; rows: PriorGameRow[] }
  | { available: false; reason: string };
export function buildPlayerContext(
  payload: GamePayload,
  prior: PriorGames,
): PlayerContextBlock;
```

- [ ] **Step 1: Write the failing tests**

In `test/playerContext.test.ts`, follow the existing engine-test style
(`pointStats.test.ts` helpers). Provide a `makePayload(overrides)` helper
building a minimal canonical `GamePayload`:

```ts
const league = { id: 24, name: "24", statValues: "v2" as const, lineSize: 6, salaryCalc: "parity" };
function makePayload(week: number, home: string[], away: string[], stats: PlayerStatLine[] = [],
  homeTeam = "Swing Break (Des)", awayTeam = "Canada Geese (Jer)"): GamePayload {
  return {
    schemaVersion: 1, league,
    game: { id: 2001, week, status: "final", date: null,
      homeTeam, awayTeam,
      homeScore: 5, awayScore: 3,
      homeRoster: home, awayRoster: away, points: [] },
    stats, quality: { warnings: [] },
  };
}
```

Tests (names are exact):

- `lists substitutes with resolved teams`: payload week 2 with
  `stats: [statLine("Nadine Cann(S)", { team: "Swing Break (Des)" }), statLine("Justin Ye", { team: "Canada Geese (Jer)" })]`
  and empty prior rows; expect
  `context.substitutes` to equal
  `[{ player: "Nadine Cann", team: "Swing Break (Des)" }]` (stripped name,
  sub only) and `context.transitions` to be `[]`.
- `reports a substitute with an unresolved team as null`: stat line
  `"Sam Lanesmith(S)"` with `team: null`; expect `substitutes` to equal
  `[{ player: "Sam Lanesmith", team: null }]`.
- `returns a first-week note and no transitions on week 1`: payload week 1,
  prior `{ available: true, rows: [] }`; expect `priorDataAvailable: true`,
  `transitions: []`, `note` to be
  `"First week of the season: no earlier-week games."`.
- `returns a degraded block when prior data is unavailable`: prior
  `{ available: false, reason: "list failed" }`, week 2; expect
  `priorDataAvailable: false`, `transitions: []`, `note` to be
  `"Earlier-week data was unavailable (list failed); roster transitions were not computed."`.

`statLine(name, overrides)` builds a minimal `PlayerStatLine` (zeros, `raw`
the unstripped name, `isSubstitute` by the `(S)` suffix, spread overrides).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/playerContext.test.ts`
Expected: FAIL, `buildPlayerContext` not exported / module missing.

- [ ] **Step 3: Implement the types and the skeleton**

In `src/domain/types.ts` add the three exported types exactly as in
Interfaces. Create `src/engine/playerContext.ts` exporting `PriorGames` and
`buildPlayerContext`: for this task the function returns the substitutes
(listed in `stats` order, `player` = `normalizePlayerRef(raw).name`, `team` =
the stat line's `team` as-is, `null` included) and resolves the week-1 /
degraded cases; `transitions` is `[]`. The fetch-failure note interpolates
the reason verbatim; week-1 means `prior.available` is true and
`payload.game.week` is 1. If `prior.available` is true with rows on week 1,
the week-1 note still applies (rows for week 1 or later cannot exist; ignore
them defensively).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/playerContext.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit the docs and this slice**

```bash
git -C D:\Code\Parity\parity-mcp add docs/superpowers/specs/2026-11-24-recap-player-context-design.md docs/superpowers/plans/2026-11-24-recap-player-context.md
git -C D:\Code\Parity\parity-mcp commit -m "docs: recap player context design and plan"
git -C D:\Code\Parity\parity-mcp add src/domain/types.ts src/engine/playerContext.ts test/playerContext.test.ts
git -C D:\Code\Parity\parity-mcp commit -m "feat: player context block types and substitutes skeleton"
```

### Task 2: Franchise matching and transition derivation

**Files:**
- Modify: `src/engine/playerContext.ts`
- Test: `test/playerContext.test.ts` (extend)

**Interfaces:**
- Consumes: `buildPlayerContext`, `PriorGameRow`, `PriorGames` (Task 1);
  `franchiseLabel(teamName: string): string` is internal to this module.
- Produces: the full transition derivation; Tasks 3 and 4 only extend or
  consume it.

- [ ] **Step 1: Write the failing tests**

Extend `test/playerContext.test.ts` (each with `prior.available: true` and
rows built by a `row(id, week, home, homeRoster, away, awayRoster)` helper,
`status: "final"`):

- `reports a trade debut with prior team and week`: payload week 4, today's
  roster `["Nick Theriault"]` (registered); prior rows: week 2
  `Team Des (Des)` roster `["Nick Theriault"]`, week 3 `Canada Geese (Jer)`
  roster `["Justin Ye"]`. Expect one transition: `player: "Nick Theriault"`,
  `team: "Swing Break (Des)"`, `priorTeam: "Canada Geese (Jer)"` (the latest
  registered prior week is 3, not 2), `priorWeek: 3`, `tradeDebut: true`,
  `teamNumber: 2`, `formerTeams` to contain
  `{ team: "Canada Geese (Jer)", franchiseLabel: "Jer", weeks: [3] }`.
- `does not count a substitute stint as team membership`: payload with
  `homeTeam: "Mayflowers (Noah)"` and roster `["Alisha Zhao"]`; prior rows:
  week 2 `Team Des (Des)` roster `["Alisha Zhao"]` (registered), week 3
  `Canada Geese (Jer)` roster `["Alisha Zhao(S)"]` (stint). Expect a single
  transition with `priorTeam: "Team Des (Des)"`, `priorWeek: 2`,
  `tradeDebut: true`, `teamNumber: 2`, and `formerTeams` to contain only the
  `Team Des (Des)` entry (`franchiseLabel: "Des"`): the stint is invisible to
  transitions (no Geese entry, and the latest registered week is 2, not 3).
- `treats a renamed franchise as one franchise via captain label`: payload
  week 3, today's team `Swing Break (Des)` with roster `["Nick Theriault"]`;
  prior rows: weeks 1-2 `Team Des (Des)` roster `["Nick Theriault"]`. Expect
  `transitions: []` (no debut: same label `Des`).
- `reports a return to a former franchise`: payload week 6, today's team
  `Mayflowers (Noah)` roster `["Alisha Zhao"]`; prior rows: week 1
  `Mayflowers (Noah)` roster `["Alisha Zhao"]`, weeks 4-5
  `Canada Geese (Jer)` roster `["Alisha Zhao"]`. Expect the transition to
  have `tradeDebut: true`, `priorTeam: "Canada Geese (Jer)"`,
  `returnToFranchise: true`, `teamNumber: 2`, and `formerTeams` to contain
  `Canada Geese (Jer)` with `weeks: [4, 5]` only (week 1 is today's
  franchise, excluded).
- `counts distinct franchises as teamNumber, null when 1`: payload week 6,
  today's team `Mayflowers (Noah)`, roster `["Alisha Zhao"]`; prior weeks 1
  (Mayflowers), 3 (Geese), 5 (`Team Des (Des)`) all `["Alisha Zhao"]`
  registered: expect `teamNumber: 3`, `returnToFranchise: true`. A second
  test: registered prior only for today's franchise → the player is omitted
  from `transitions` entirely.
- `omits transition rows when a player has two registered games in one
  earlier week`: prior rows week 2: two distinct games (different ids, same
  week), rosters `["Nick Theriault"]` on `Team Des (Des)` and on
  `Canada Geese (Jer)`; payload week 4 roster `["Nick Theriault"]`. Expect
  Theriault absent from `transitions` (ambiguous: never chosen between).
- `builds former-opponent subsets from the opponent label`: payload week 6,
  today's teams `Mayflowers (Noah)` v `Canada Geese (Jer)`, roster
  `["Alisha Zhao"]`; prior rows: weeks 2-3 `Team Des (Des)` and weeks 4-5
  `Canada Geese (Jer)`, both `["Alisha Zhao"]` registered. Expect
  `opponentFormerTeams` to contain only the Geese entry
  (`franchiseLabel: "Jer"`, `weeks: [4, 5]`) and `formerTeams` to hold both
  entries.
- `omits players whose only prior franchise is today's`: prior row week 2
  `Swing Break (Des)` roster `["Nick Theriault"]`, payload week 4 same team:
  expect `transitions: []`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/playerContext.test.ts`
Expected: FAIL (transitions are always `[]`).

- [ ] **Step 3: Implement the derivation**

In `buildPlayerContext`, after the Task 1 cases: usable rows are
`status === "final"` with non-empty `homeRoster` and `awayRoster`. For each
registered player on today's rosters (roster entry without terminal `(S)`):
collect `(week, franchiseLabel, recordedTeam)` from usable prior rows where
the player appears on a roster without `(S)`. If one week holds two distinct
registered labels for the player, drop all their transition rows. Otherwise:
latest registered week decides `priorTeam`/`priorWeek`;
`tradeDebut` = prior label ≠ today's label;
`returnToFranchise` = today's label among prior labels; `teamNumber` =
distinct prior labels + 1, mapped to `null` when the player has no prior
registered appearance (left for Task 3 to expose as `firstAppearance`).
Group `formerTeams` by label (≠ today's) with sorted week lists and each
group's most recent recorded name; `opponentFormerTeams` = subset whose label
equals the opponent's. `franchiseLabel` extracts the trailing
`/\(([^)]*)\)\s*$/` group, else returns the trimmed name. Inclusion filter
per spec (debut, return, teamNumber ≥ 3, former-opponent; Task 3 adds
first-appearance).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/playerContext.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C D:\Code\Parity\parity-mcp add src/engine/playerContext.ts test/playerContext.test.ts
git -C D:\Code\Parity\parity-mcp commit -m "feat: derive roster transitions with franchise-label matching"
```

### Task 3: First appearances and unaccounted weeks

**Files:**
- Modify: `src/engine/playerContext.ts`
- Test: `test/playerContext.test.ts` (extend)

**Interfaces:**
- Consumes: everything from Tasks 1-2. Produces: the final engine behaviour.

- [ ] **Step 1: Write the failing tests**

- `reports a first appearance when every earlier week is accounted`: payload
  week 3, roster `["Tiger Ye"]`; prior rows weeks 1-2, both `"final"` with
  full rosters, neither containing Tiger Ye. Expect the transition:
  `player: "Tiger Ye"`, `firstAppearance: true`, `priorTeam: null`,
  `priorWeek: null`, `tradeDebut: false`, `teamNumber: null`,
  `returnToFranchise: false`, `formerTeams: []`.
- `suppresses first-appearance rows when an earlier week is unaccounted and
  notes it`: same payload, prior rows only for week 1 (week 2 missing
  entirely). Expect `transitions: []` for Tiger Ye, `priorDataAvailable:
  true`, `note` to be `"Earlier weeks without usable data: weeks 2."`.
- `suppresses first-appearance rows when an earlier week has no usable row`:
  same, but week 2's row has `status: "scheduled"` (or an empty roster):
  same expectations as above with `note` `"Earlier weeks without usable data:
  weeks 2."`.
- `keeps debut and return rows when a week is unaccounted`: Alisha Zhao with
  prior rows existing only for weeks 1 (Mayflowers) and 4 (Geese), both
  usable and registered `["Alisha Zhao"]`; today week 6 Mayflowers: expect
  the return row still derived; `note`
  `"Earlier weeks without usable data: weeks 2, 3, 5."` (every unaccounted
  week below 6 is named).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/playerContext.test.ts`
Expected: FAIL (no first-appearance or gap logic yet).

- [ ] **Step 3: Implement**

Compute `unaccounted` = weeks `1..payload.game.week - 1` with no usable row.
A player with no registered prior appearance gets
`firstAppearance: true` only when `unaccounted` is empty and week > 1;
otherwise no row. When `unaccounted` is non-empty, `note` is
`"Earlier weeks without usable data: weeks <n, n, n>."` (ascending, comma
separated) and `priorDataAvailable` stays `true`. The week-1 and degraded
notes from Task 1 take precedence and never combine with a gap note.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/playerContext.test.ts`
Expected: PASS, and `npm test` green overall.

- [ ] **Step 5: Commit**

```bash
git -C D:\Code\Parity\parity-mcp add src/engine/playerContext.ts test/playerContext.test.ts
git -C D:\Code\Parity\parity-mcp commit -m "feat: first-appearance rule and unaccounted-week notes"
```

### Task 4: Server plumbing, tool description, persistence

**Files:**
- Modify: `src/server.ts` (FullGamePayload near line 45; gameForLeague near
  line 140; parity_get_game description near line 268)
- Test: `test/server.playerContext.test.ts` (create)

**Interfaces:**
- Consumes: `buildPlayerContext`, `PriorGames`, `PriorGameRow` (Tasks 1-3).
- Produces: `FullGamePayload.playerContext: PlayerContextBlock`;
  `gameForLeague` exported for tests.

- [ ] **Step 1: Write the failing tests**

In `test/server.playerContext.test.ts`, build a stub `DataSource` whose
`getGame` resolves a minimal canonical payload (week 3 game, today's team
`Swing Break (Des)`, roster `["Nick Theriault"]`, empty points) and whose
`listGames` resolves prior rows (weeks 1-2, `Team Des (Des)` roster
`["Nick Theriault"]`, status final). Tests:

- `attaches the player context to the full payload`: call the now-exported
  `gameForLeague(source, { id: 24 }, 2001)`; expect
  `payload.playerContext.priorDataAvailable` to be `true` and
  `payload.playerContext.transitions` to be `[]` (rename: same label).
- `degrades the block when listGames fails`: same stub with `listGames`
  rejecting (`new SourceError("REQUEST_FAILED", "boom")`); expect the call
  to resolve (never throw), `playerContext.priorDataAvailable` to be `false`,
  and `note` to start `"Earlier-week data was unavailable"`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/server.playerContext.test.ts`
Expected: FAIL (`gameForLeague` not exported; no `playerContext`).

- [ ] **Step 3: Implement**

In `src/server.ts`: export `gameForLeague`; add `playerContext:
PlayerContextBlock` to `FullGamePayload`; after `assembleFullGame`, fetch
prior rows tolerantly:

```ts
let prior: PriorGames = { available: true, rows: [] };
if (payload.game.week > 1) {
  try {
    prior = { available: true, rows: await source.listGames(league) };
  } catch (cause) {
    prior = { available: false, reason: cause instanceof Error ? cause.message : String(cause) };
  }
}
full.playerContext = buildPlayerContext(payload, prior);
```

(`listGames` without options returns rows without points; the engine reads
only `PriorGameRow` fields. `PlayerContextBlock` imports from
`./domain/types.js`; `buildPlayerContext` from `./engine/playerContext.js`.)
Update the `parity_get_game` description to: `"Get one canonical game payload
with salary ledger, score timeline, story facts, narrative shape,
interactions, and player context (substitutes, trade debuts, returns,
first appearances, former-team opponents); persists the game
automatically."` The block persists automatically: it is on the payload when
`persistCanonicalGame` runs.

- [ ] **Step 4: Run tests and type-check**

Run: `npx vitest run test/server.playerContext.test.ts` then `npm run type-check` then `npm test`
Expected: PASS; type-check clean; full suite green.

- [ ] **Step 5: Commit**

```bash
git -C D:\Code\Parity\parity-mcp add src/server.ts test/server.playerContext.test.ts
git -C D:\Code\Parity\parity-mcp commit -m "feat: attach player context to canonical game payloads"
```

### Task 5: Skill edits: fact sheet, prose rules, common mistakes

**Files:**
- Modify: `D:\Code\Parity\.opencode\skills\parity-breakdown\SKILL.md`
  (flow step 4 line ~22; fact sheet after item 9 line ~51; the
  substitute-markers rule line ~116; Common Mistakes after line ~158)

**Interfaces:**
- Consumes: the shipped `playerContext` block (Tasks 1-4). Produces: the
  recapper-facing contract. No code changes; `analyst.system.md` is
  untouched (it defers to the skill's sheet).

- [ ] **Step 1: Add `playerContext` to flow step 4**

In flow step 4, extend the payload field list to
"(game, salaryLedger, timeline, storyFacts, interactions, quality, narrative,
playerContext)".

- [ ] **Step 2: Insert fact sheet item 10 "Player context"; renumber History to 11**

New item, between Quality warnings and History, in the sheet's contract
voice, carrying: substitutes per team (name and resolved team, "team
unknown" when null); trade-debut rows as "player, today's team, prior team
and week"; return rows with the earlier weeks and the away weeks between;
Nth-franchise rows as "player, today's team, Nth franchise of the season";
first-appearance rows as "player, today's team, first game of the season";
former-opponent rows as "player, today's team, the former team and the weeks
they appeared for it"; and the availability line: the block's `note` verbatim
when present, "prior-week data available" otherwise. State that the sheet
carries no editorial hints and a degraded block is never presented as
empty-but-checked. Renumber the History item to 11.

- [ ] **Step 3: Replace the substitute-markers rule; add the context prose rules**

Replace the rule at line ~116 ("- Substitute markers: story and trend prose
use plain names with no "(S)"; star turns keep the marker. Data notes may
use either.") with the amended rule plus the new ones, in the spec's
section 3 wording: substitutes amended (inline mention allowed when it
changes how a performance reads; only what the sheet carries; never the role
or position filled, because no position is recorded anywhere in the data);
trade debuts (one clause riding on a performance already told; prior game
cited by week; never a standalone beat; at most a clause each, may spend
none); returns (one clause, same restraint); Nth franchise (`teamNumber` 3
or more, occasional by the commissioner's explicit wish, spent less freely
than a debut, never standalone); first appearances (plainer words, same
restraint); former-team opponents (never a standalone headline, at most one
mention per recap folded into that player's clause, default through the
season's middle and back stretch is omission); nothing beyond the sheet (no
context claim without a Player context row). Also state: a context clause
earns its place as a new fact but is not a stat fact unless it carries a
number, and a number inside it counts against the two-stat-fact budget.

- [ ] **Step 4: Add the Common Mistakes bullets**

Three bullets, in the spec's wording: claiming the role a substitute filled
(a sub mention says for whom they played and what they did; positions are
not recorded); calling a trade debut, return, Nth-franchise count, first
appearance, or former-team matchup without a context row; treating "no prior
record" as "first game of the season" when the sheet says prior data was
unavailable.

- [ ] **Step 5: Verify by read-back**

Run: `grep -n "playerContext\|Player context\|Nth franchise\|Substitute markers" D:\Code\Parity\.opencode\skills\parity-breakdown\SKILL.md`
Expected: hits in flow step 4, item 10, the prose rules, and (no hit for
"Substitute markers" as a rule title, since it was replaced: verify the new
substitute rule text is present instead). Read the edited sections once and
check the item numbering runs 1-11 with no gaps.

- [ ] **Step 6: No commit**

`D:\Code\Parity` is not a git repository; the skill edit is complete when the
read-back passes. (The parity-mcp repo holds all code commits.)

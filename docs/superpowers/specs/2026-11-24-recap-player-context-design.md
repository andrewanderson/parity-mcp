# Design: Recap player context (substitutes, trade debuts, former-team matchups)

Date: 2026-11-24
Status: draft, builder check complete, pending approval

**Resolved decision: team identity across a rename.** The season-24 fixture
shows `Team Des (Des)` (weeks 1-2) becoming `Swing Break (Des)` (weeks 3-6).
Franchises are matched by the parenthesised captain label, confirmed by the
commissioner (2026-11-24): captains do not change during a season, and one GM
runs one franchise. Exact team-name comparison would have manufactured false
debut rows for the renamed roster in week 3. The block reports recorded names
with their weeks; when a franchise's recorded name changed mid-season, the
writer uses the name the reader would know and may mention the change once,
briefly, under the editorial rules.

## Intent and why

Parity recaps sometimes read as if every player were a fixture of their team,
because the recap flow has no verified answer to three natural questions:

1. **Was this player a substitute?** The payloads carry the fact (the `(S)`
   marker, preserved as `isSubstitute` on stat lines, point stats, and salary
   entries), and the prose rules already manage the marker. But the fact is
   never offered to the writer as context worth weaving into a sentence, so a
   standout game by a fill-in reads like a routine one.
2. **Is this a player's first game with a new team?** The league forces trades
   every two games. Nothing records trades, but roster membership per game does:
   a player whose most recent earlier-week appearance was for a different team
   is debuting after a trade. That fact is derivable and currently derived
   nowhere in the recap flow.
3. **Is this player facing a former team?** Same source. The commissioner's
   brief: use very sparingly. Trades every two games mean this becomes common
   through the season, so it must never become a standalone headline.

On 2026-11-24 the commissioner extended the transition family: because the
block builds each player's franchise history anyway, it also reports a return
to a franchise the player appeared for earlier this season, and a
third-franchise-or-later season (Nth team, N > 2), both editorial in use and
both free once the history exists.

The fix has three parts, each owned by the layer that already owns that job:
the parity MCP computes and exposes the facts on the canonical game payload;
the analyst's fact sheet carries them as verified data; the parity-breakdown
skill's prose rules decide, editorially, when they earn words.

All mention decisions are **editorial** (commissioner's call, 2026-11-24): no
hard thresholds, no quota script, no automatic phrasing. The server says what
is true; the writer decides what it is worth.

## Goals

- A `playerContext` block on the full game payload, computed server-side from
  data the MCP already serves, covering substitutes with resolved teams and
  roster transitions (trade debuts, returns to a franchise, Nth-franchise
  counts, first appearances, former-team opponents) within the current league.
- A fact-sheet section ("Player context") carrying those verified fields, in
  the sheet's order, under the existing contract.
- Prose rules in the parity-breakdown skill: substitute mentions inline when
  they change how a performance reads; debut clauses that ride on a
  performance already being told; former-team mentions rare and folded in.

## Non-goals

- No career or prior-season context. The league id is the season; that boundary
  is deliberate and recorded elsewhere (career-stats design note,
  `D:\Code\opencode-config\docs\superpowers\specs\2026-11-04-career-stats-and-prior-season-context.md`).
- No dependency on the parity-synergy store. Its database only knows games
  that were ingested there; the MCP's API source covers the season's list, and
  recapper sessions would need a second MCP registered to reach it. One source
  of truth: the parity MCP.
- No trade feed ingestion or trade dates. Roster membership is the evidence.
- No quotas, check scripts, or self-check additions for context mentions.
- No changes to `analyst.system.md`: it defers to the fact sheet the skill
  defines, so the new section flows through without edits.
- No changes to the substitution quality warnings; they keep their meaning.

## Anti-goals (a failure even if everything works)

- A recap claiming the role or position a substitute filled ("filling in at
  handler"). The data records no positions. A sub mention may say they were
  subbing, for which team, and what they did. Nothing more.
- A former-team mention standing alone as its own story beat every week.
- A debut claim inferred from absence of data: "first game with the new team"
  must come from a prior-week record showing a different team, not from a
  missing record. The same trap wears a subtler disguise: a substitute stint.
  A one-week `(S)` fill-in is not team membership and never grounds a debut,
  return, or former-team claim (commissioner's caution, 2026-11-24).

## Constraints

- **League is the season.** Transitions derive only from earlier weeks of the
  current league. Never another league, never a later week (the reader has not
  seen it). This matches the skill's history rules exactly.
- **The server owns every number.** The skill never re-derives a transition;
  if the sheet does not carry it, the recap does not say it.
- **History visibility.** A prior team or prior game may be cited by week only,
  per the existing citation rules ("the week 2 comeback" form).
- **Word budget neutrality.** A context clause earns its place as a new fact,
  but it is not a "stat fact" unless it carries a number; a number inside it
  counts against the story's two-stat-fact budget like any other.
- **Degradation over guessing.** When earlier-week data is unavailable, the
  block says so. Empty is never ambiguous with "checked and nothing there".

## Design

### 1. Payload: the `playerContext` block

Computed in `assembleFullGame` (src/server.ts) by a new engine module (for
example `src/engine/playerContext.ts`), alongside the narrative and
interactions builders, so it appears on every `parity_get_game` payload.

```ts
playerContext: {
  substitutes: Array<{
    player: string;        // stripped name (normalizePlayerRef)
    team: string | null;   // resolved team; null when unresolved
  }>;
  transitions: Array<{
    player: string;
    team: string;                  // today's team, recorded name
    franchiseLabel: string;        // today's captain label
    // The latest registered earlier-week appearance; null for a first
    // appearance of the season.
    priorTeam: string | null;
    priorWeek: number | null;
    tradeDebut: boolean;           // prior franchise exists and differs
    returnToFranchise: boolean;    // today's franchise also in earlier weeks
    teamNumber: number | null;     // distinct franchises incl. today's; null when 1
    firstAppearance: boolean;      // no registered appearance in any earlier week
    priorWeeksOnTeam: number[];    // registered earlier weeks for today's franchise
    // All earlier-week franchises except today's, each with the weeks the
    // player appeared for it (recorded names). Weeks are required: the sheet
    // cites a prior game by week, per the citation rules.
    formerTeams: Array<{ team: string; franchiseLabel: string; weeks: number[] }>;
    opponentFormerTeams: Array<{ team: string; franchiseLabel: string; weeks: number[] }>; // subset
  }>;
  priorDataAvailable: boolean;
  note: string | null;   // set when priorDataAvailable is false: why
}
```

Semantics:

- **Roster membership is team membership, substitutes excepted.** Every listed
  game row carries `homeRoster` / `awayRoster` (raw rows do today; the
  `GameSummary` strips them). A player on a game's roster played for that team
  that week, with one design ruling (from the builder check, confirmed against
  the season-24 fixture): **an `(S)` substitute stint never counts as team
  membership for transitions.** Subs fill in for a shorthanded team as a
  favour; treating a one-week stint as a trade would fabricate debuts the data
  cannot back (observed case: Alisha Zhao, a Mayflowers regular, subbing once
  for Meltness in week 5 would read as "first game since the trade that sent
  her from the Meltness"). Substitute stints therefore never contribute a
  prior team or a former team; the trade rule needs a registered roster spot.
  Identity resolution uses the existing `normalizePlayerRef` rule: trim,
  case-insensitive, terminal `(S)` stripped.
- **Franchises are identified by captain label.** Team names carry a
  parenthesised captain label ("Team Des (Des)"); the label is the franchise
  identity for transition matching, and it does not change during a season
  (commissioner-confirmed). Two recorded names sharing a label are one
  franchise: no debut is reported when only the name changed. The block
  reports recorded names with their weeks; the writer uses the name the reader
  would know and may mention a mid-season rename once, briefly.
- **Prior game.** For a player with a registered appearance today, the latest
  earlier-week game of this league in which they appear on a roster *without*
  the `(S)` marker, chosen by week (game ids do not run in week order). The
  fixture shows a player sometimes appears twice in one week, a registered
  game plus a borrowed `(S)` stint for another side; the registered appearance
  wins. Transition rows describe registered play only: a substitute stint
  today puts the player in `substitutes`, never in `transitions`, and a player
  with no registered appearance in any earlier week gets none unless the
  first-appearance rule below fires. Registered play is the only trade
  evidence, and absence is never converted into a claim.
- **Trade debut.** `tradeDebut` is true when a registered prior appearance
  exists and its franchise differs from today's. `priorTeam` and `priorWeek`
  carry that appearance's recorded name and week.
- **Return to a franchise.** `returnToFranchise` is true when today's
  franchise also appears in the player's registered earlier-week history: they
  were traded away from it and traded back. It can coexist with `tradeDebut`
  (returning via a stopover elsewhere). `formerTeams` records the away weeks.
- **Nth franchise of the season.** `teamNumber` counts the distinct
  franchises the player has appeared for this season, registered appearances
  only, including today's. Null when 1. A value of 3 or more means two or
  more trades have already happened; the prose may colour a performance with
  it (commissioner's request, editorial in use).
- **First appearance.** No registered appearance in any earlier week, a
  registered appearance today, and every earlier week accounted for by at
  least one usable listed row (usable: `status` final and both rosters
  present). If any earlier week lacks a usable row, that week is unaccounted:
  players whose only absence runs through it get no row, and the block's
  `note` names the unaccounted weeks. Absence of evidence is never a
  first-appearance claim, and a substitute stint is never the registered
  appearance that grounds one.
- **Former teams / former-team opponent.** Every earlier-week team from
  registered appearances, deduped, excluding today's team, each with the weeks
  it covers; the opponent subset is today's opponent in that set.
- **Inclusion.** `transitions` lists only players with `tradeDebut`,
  `returnToFranchise`, `firstAppearance`, `teamNumber` of 3 or more, or a
  non-empty `opponentFormerTeams`. A player whose prior franchise is today's
  (and none of the above) is omitted: that is not news. Substitutes appear in
  `substitutes` regardless of history, and a season-long substitute produces
  no transition rows at all.
- **Substitute team.** Resolved by the existing team-resolution rules; a
  substitute absent from both rosters (`SUBSTITUTE_NOT_ON_ROSTER`) gets
  `team: null`.
- **Week 1.** No earlier weeks exist: `priorDataAvailable` is true, transitions
  is empty, and the note says the season's first week has no prior games.
- **Degradation.** If earlier-week list data cannot be fetched at all,
  `priorDataAvailable` is false, transitions is empty, and `note` says so in
  one plain sentence. A partially unusable list keeps `priorDataAvailable`
  true and computes what it can, with `note` naming the unaccounted weeks
  (which in turn suppresses first-appearance rows, per above). The block never
  guesses from absence.

### 2. Fact sheet: new section "Player context"

Inserted after **9. Quality warnings** as new item **10**; **History** becomes
item 11. (Placement is a design call: context sits with the other verified
end-matter, before the history section the writer reads for trends.)

The section carries, per the contract:

- **Substitutes**: per team, each substitute's name and resolved team
  ("team unknown" when unresolved). The `(S)` marker is sheet bookkeeping; the
  prose rules govern how it appears.
- **Transitions**: trade-debut rows as "player, today's team, prior team and
  week"; return rows as "player, today's team, the weeks they appeared for it
  earlier and the away weeks between"; Nth-franchise rows as "player,
  today's team, Nth franchise of the season"; first-appearance rows as
  "player, today's team, first game of the season"; former-opponent rows as
  "player, today's team, the former team and the weeks they appeared for it".
- **Availability**: the `priorDataAvailable` statement, or the note verbatim
  when false. The sheet never presents a degraded block as empty-but-checked.
- No editorial hints. Selection is the writer's, by design.

### 3. Prose rules (parity-breakdown skill)

Amend the existing substitute-marker rule and add three:

- **Substitutes (amended).** Story and trend prose use plain names with no
  "(S)"; star turns keep the marker; data notes may use either. In addition,
  the writer may mention substitute status inline when it changes how a
  performance reads ("a substitute on the night, [name] ..."). The mention may
  carry only what the sheet does: that they were subbing, for which team, and
  their numbers. It never names the role or position they filled, because no
  position is recorded anywhere in the data.
- **Trade debuts.** When a player with a debut row appears in the story or star
  turns, the writer may add one clause of context ("her first game since the
  trade that sent her from the Geese"). The clause rides on a performance
  already being told; it is never a standalone beat, and the prior game is
  cited by week per the citation rules. A game may carry several debuts; the
  story spends at most a clause each, and may spend none.
- **Returns.** When the sheet shows a return row (back with a franchise they
  appeared for earlier this season), the writer may note it once ("back in
  Mayflowers colours after two weeks with the Geese"), riding on a performance
  already being told, with the same restraint as a debut.
- **Nth franchise of the season.** When the sheet shows `teamNumber` of 3 or
  more, the writer may colour a performance with it ("his third franchise of
  the season"). Occasional by the commissioner's explicit wish: it is the
  rarest and loudest of the context facts, so it earns words less often than
  a debut, and never as a standalone beat.
- **First appearances.** Same treatment as trade debuts, with plainer words
  ("his first game of the season"), and the same restraint.
- **Former-team opponents.** Never a standalone headline. At most one mention
  per recap, folded into that player's own clause ("facing the team that
  traded him away, ..."). The default through the season's middle and back
  stretch is omission: as trades accumulate most players face a former team,
  and the fact earns words only when the performance makes it sharp.
- **Nothing beyond the sheet.** No substitute, debut, first-appearance, or
  former-team claim without a Player context row behind it.

Additions to Common Mistakes:

- Claiming the role a substitute filled. A sub mention says for whom they
  played and what they did; positions are not recorded.
- Calling a trade debut, return, Nth-franchise count, first appearance, or
  former-team matchup without a context row.
- Treating "no prior record" as "first game of the season" when the sheet says
  prior data was unavailable.

### 4. What stays untouched

- The `(S)` stripping and identity rules, substitution quality warnings, and
  mid-point substitution data notes keep their current behaviour.
- The star-turn quota and check scripts are unaffected.
- The parity-synergy store and its MCP are unaffected.

## Left to the builder

- How the source layer exposes roster membership for listed games (extend
  `listGames`'s row type internally, add a source method, or retain raw rows
  before `toSummary` strips them). Requirement: no whole-league sequence of
  per-game payload fetches; roster membership comes from list-row data.
- Engine module structure and exact types, following existing engine
  conventions and their test placement.
- Test coverage of the edges: week 1, a traded debut, a first appearance, a
  sub with an unresolvable team, the Team Des to Swing Break rename (no false
  debuts in week 3's game 1007), and the degraded no-prior-data path. Existing
  fixtures (game 1000-1002 with `(S)` players) are the starting point.
- The `parity_get_game` tool description's one-line mention of the new block.

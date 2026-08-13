# DnD Immerse

A self-hosted D&D 5e virtual tabletop for one friend group. Architecture is drawn
from **Foundry VTT** (self-hosted Node app), not Roll20.

**Read [docs/PLAN.md](docs/PLAN.md) first.** It holds the data model, the
wall-vision design, the 7-phase build sequence, and the reasoning behind the
choices below. Keep it updated in the same commit as the work it describes.

## Status

**All seven phases are done.** Accounts, campaigns, 5e sheets, the SRD
compendium, a live table with chat and server-rolled dice, a battle map with
sized tokens, wall-based dynamic vision with three-state fog, initiative and
rules automation, a journal and AoE templates.

**Audio is deliberately absent.** Playlists, positional emitters and the
soundboard were built in phase 7 and removed afterwards: this group plays over
Discord, which already carries the music, so the whole subsystem was code that
had to compile and pass tests for nobody's benefit. Do not rebuild it without
being asked — the loss of positional ambience was a known cost, not an
oversight.

Current work is the punch list in **[docs/BACKLOG.md](docs/BACKLOG.md)** — fixes
and features raised after playing the finished build. Read it before starting
anything; it carries root causes already traced and is how work moves between
the desktop and the laptop.

## Commands

```bash
npm start            # Production: one process, everything on :3001
npm run dev          # Development: API :3001 + client :5173, hot reload
npm test             # Vitest: rules5e + grid math
npm run db:generate  # New migration after editing schema.ts
npm run srd:import   # Seed the compendium (downloads once, then cached)
npm run seed         # Example campaign: DM + 3 players, gear, NPCs
```

`npm run seed` creates `dm@example.com` and three players, all with password
`demo-password`. It only ever touches `@example.com` accounts, so it will not
disturb real data.

The SRD import is idempotent — re-running replaces the compendium in place.

## Invariants

These are load-bearing. Violating them produces bugs that look like features
until a session is ruined.

**Token geometry is in grid units, not pixels.** Fractional, `real()` columns.
Pixel position is derived at render time from the scene's grid size and offset,
so recalibrating a map never scrambles the board.

**Use `tokenDistance()`, never `gridDistance()`, for any reach/range/AoE check.**
5e measures to a creature's nearest occupied square. Center-to-center reports a
Medium creature against a 4×4 Gargantuan dragon's flank as 25 ft and refuses
legal melee attacks. See `packages/shared/src/grid.ts`.

**Derived values are computed, never stored.** Ability modifiers, save DCs,
passive scores, and (later) active-effect results come from pure functions in
`packages/shared/`. Storing them guarantees drift.

**Hidden things are filtered server-side, never hidden client-side.** Hidden and
out-of-sight tokens must not appear in a player's payload at all. Wall geometry
is never sent to players — it is a map of the dungeon. A client-side black
overlay is a devtools inspection away from spoiling an ambush. This is the one
place we deliberately diverge from Foundry, which computes vision client-side.

**Dice are rolled on the server.** Half the value of a shared table is that
nobody can fudge. The client sends an expression string; `lib/dice.ts` produces
the numbers. Expressions are length- and size-capped so `99999d99999` cannot
hang the process.

**Private messages are routed, not flagged.** Whispers and secret rolls go to
the participants' personal socket rooms - never to the campaign room carrying a
"private" flag, which a modified client could ignore. Secrecy is also persisted
(a secret roll is stored as a whisper to the DM) so it survives a history
reload.

**Cull walls to the vision radius before the sweep.** The sweep casts three
rays per wall corner and tests each against every wall, so cost grows with the
*square* of the wall count — 300 walls measured at 13.8 ms per token before
culling, which blows a 30 Hz drag budget several times over once every player
is recomputed. Culling makes it flat: 0.07 ms at 300 walls, 0.13 ms at 2000.

**Vision is computed on the server, never the client.** `realtime/vision.ts`
produces each player's polygon and sends them the polygon plus the tokens inside
it. Wall geometry is never in a player payload — doors are, because a door is a
thing you can see and open. This is a deliberate divergence from Foundry, which
computes vision in the browser and therefore ships every wall to every client.

**Derived actor data is a pure function.** `effects.ts` folds active effects
over base numbers and is never stored — the same rule as ability modifiers.
Modes apply multiply before add, so a +2 bonus is not itself doubled, and
`applied` names every effect that contributed so a total is explainable.

**AoE outlines and target lists come from the same geometry.** `templateCovers`
decides both what is drawn and who is caught, so they cannot disagree.

**Uploaded files are deleted with the record that owns them**, except where
another row still points at the same file — a token stamped from an actor
reuses its portrait, and one piece of art can be the map for two scenes. Rows
cascade; files do not, so deletion paths call `deleteOrphanedUploads`, which
re-checks every table that can hold a URL before removing anything. Deleting a
shared file turns a disk-space bug into a broken-image bug, which is worse.

**A linked token is the same creature as its sheet, in both directions.**
Damage writes to token and actor; rests and sheet edits write only to the
actor, so those call `syncLinkedTokens` — otherwise a player who long-rested
still shows 12/47 on the board. Unlinked tokens are deliberately untouched:
five goblins from one stat block keep five independent HP pools.

**No dead code.** Two audits found helpers that were written, tested, and never
called — `movementBlocked` let players walk through walls, `deriveActor` made
conditions decorative. Before adding a feature, check that the last one is
actually reachable: `grep` the export and see whether anything outside its own
module and tests uses it.

**Compendium categories are curated, not taken from the data.** The SRD's own
`category` strings are inconsistent by source — "Weapon" and "Weapons", "Ring"
and "Rings" — so `categoryFilter` maps seven browsable shelves onto them, and
matches at word starts. A bare `%ring%` files every piece of *adventuring* gear
in the magic ring drawer.

**A hand-entered item fills the same `system` blob an imported one does.** The
manual form's fields are the ones the attack table and target panel read, not a
name and a description; anything left blank falls back to the Zod schema's
default on the server. An item you cannot swing is decorative.

**Enemy hit points are redacted from players in the tracker.** Knowing the boss
is on 7 HP changes how a table plays; that is the DM's to reveal.

**Visibility is stored, not inferred from grants.** Journal sharedness is a
column on the entry. Deriving it from "does an ownership row exist" meant a
campaign with no players yet wrote no rows, reported every entry unshared, and
the show button appeared dead — a state you only hit while prepping alone,
which is exactly when nobody is around to notice it is broken.

**A client names its actor; the server decides what that means.** Ping colour
comes from the sender's character, but the `actorId` on the wire is a claim:
`pointerColor` checks the sender actually controls it before deriving anything.
Colours are computed from the id via `actorColor()`, never stored, so client and
server agree without a round trip.

**`loading` means "nothing to show yet", never "a request is in flight".** A
refetch that flips it true swaps the page for a spinner, and unmounting a page
throws away its scroll position — which is why every rest bounced the user to
the top of the sheet. Keep the last good data rendered while refreshing.

**A dragging Konva stage swallows mousemoves.** Any gesture built from a stroke
has to cancel the stage pan in `onDragStart`, or it collects two points near
where the mouse was released. Stroke handlers also use functional state updates:
mouse moves arrive faster than React re-renders, so reading the closed-over
array loses most of the line.

**Walls block sight and movement independently.** `blocksSight` and
`blocksMovement` are separate flags, so a railing can be seen over but not
crossed and a curtain the reverse. Collision is enforced on `token:commit` for
players; the DM can place anything anywhere.

**Fog is a bitmap, not accumulated polygons.** One bit per grid square per
player, base64 in `fog_exploration`. Unioning polygons grows without bound; a
100×100 scene is 1.25 KB and merges with a bitwise OR.

**Token drag never touches the database.** `token:move` streams position at
~30Hz and is rebroadcast without a write; `token:commit` persists once on drop
and applies the authoritative snap. A rejected move rebroadcasts the real
position so the client corrects rather than sitting desynced.

**NPCs are absent from a player's roster, not redacted.** A row reading
"Ancient Red Dragon — sheet not shared" spoils the encounter just as thoroughly
as the stat block would. The name is the leak.

**Socket authorization is re-checked in every handler.** Room membership
authenticates; it does not authorize. DM-only data travels on the separate
`campaign:{id}:dm` room so secrecy is structural rather than a forgettable
`if (isDM)` branch.

**Hooks go above the early returns.** `CampaignTable` returns early while
loading, and binding `useHotkeys` after that produced React error #310 — more
hooks on the second render than the first. Shortcut handlers read
`useTable.getState()` when a key fires rather than closing over render values,
which also means they cannot act on a stale selection.

**Grid detection is signal processing, not AI.** `gridDetect.ts` autocorrelates
the per-row and per-column edge profile to find the pitch a map already has
printed on it. Three failure modes it has to handle, each of which had a test
written before the fix: harmonics (the peak is often 2× the true period, so
take the earliest lag within 90% of it), prominence measured as a z-score
rather than a ratio (the mean correlation on a clean grid is negative), and
flat profiles (a gradient has no signal, and float residue in it otherwise
produces a confident answer about nothing). The guess is always confirmed by
the DM, never applied silently.

**The board takes the map's aspect ratio.** A long thin bridge gets a long thin
box rather than 350px of black above and below. `w-full max-w-full` on that
container is load-bearing: with an aspect ratio and a min-height, CSS satisfies
the height first and then demands the width the ratio implies, which for a 5:1
map overflowed the column and covered the sidebar entirely.

**Refits wait for the ResizeObserver, never a timer.** Focus mode nearly
doubles the board width; refitting on a timeout raced the observer and refitted
against the old size, leaving the map drawn at its former scale. Arm a flag on
the toggle, fire it when the new size arrives.

## Conventions

`packages/shared` is the contract between client and server — Zod schemas, the
socket event types, 5e rules, grid math. Define a payload once there so a
protocol change is a compile error rather than a runtime mystery.

Actors own Items (weapons, spells, features, gear) as real rows, not JSON arrays.
Hot scalars (abilities, HP, AC, level) stay indexed columns because the party
panel and token HUD read them constantly; type-specific detail goes in a
Zod-validated `system` JSON column.

**Atmosphere never changes what anyone can see.** Coloured light and weather
are drawn after vision has already decided visibility. A torch tinting the
floor orange must not move a token in or out of view, or two players would
disagree about what is on the board.

## Gotchas

**The 2024 SRD dataset is partial.** Equipment (with weapon mastery) and
features are published; spells and all but three monsters are not. A 2024
campaign therefore draws spells and monsters from the 2014 list. Check
`src/2024/en/` upstream before assuming a file exists — the importer marks the
missing ones optional so a 404 is an empty list, not a failed import.

**`packages/shared` ships built JavaScript, and everything resolves to
`dist/`.** Its `main` used to point at `src/index.ts`, which meant the compiled
server imported TypeScript and `npm start` could never have worked. `npm run
dev` runs a watch build so edits still appear immediately — conditional exports
pointing at source resolve inconsistently across vite, tsx and vitest, which is
worse than one path plus a watcher.

**The driver is `@libsql/client`, not `better-sqlite3`.** The latter has no
prebuilt binary for Node 24 and needs a node-gyp toolchain. Do not "fix" this
back.

**`ensureDataDirs()` must run before the libsql client is constructed.**
`data/` is gitignored, and opening a SQLite file does not create its parent
directory — a fresh clone crashes with `SQLITE_CANTOPEN` otherwise.

**UI changes can be verified for real.** `playwright` is a dev dependency and
drives installed Chrome via `channel: 'chrome'` — no browser download needed.
Screenshot the page and look at it; a sheet that renders is not the same as a
sheet whose numbers are right.

**`npm run backup` exists and should be run before sessions.** This machine
holds the only copy of a campaign. The snapshot uses `VACUUM INTO` rather than
a file copy, because copying a live SQLite file can capture a torn write — the
result looks fine until the day you need it.

**`data/` does not sync between machines.** The desktop is the server of record
and holds the real campaign database; other machines keep throwaway local data.
Never sync a live SQLite file between two running servers.

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
rules automation, and ambient audio with a journal and AoE templates.

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

**Sound occlusion is computed server-side, like vision.** Volume falloff is
client-side from the listener's own tokens, but a wall between the source and
the ear can only be judged where the walls are — so the server sends a per-
listener `occlusion` multiplier. Muffled, not silenced: sound popping in and
out as people move reads as a bug.

**Audio is synced by timestamp, never streamed.** The server records which
track started and when; each client seeks its own copy. Positional volume is
computed client-side from the listener's own tokens, so the server never sends
a different mix per player. Only the DM's client advances the playlist — every
browser firing `ended` would skip several tracks at once.

**AoE outlines and target lists come from the same geometry.** `templateCovers`
decides both what is drawn and who is caught, so they cannot disagree.

**Uploaded files are deleted with the record that owns them**, except where
another row still points at the same file — placing an ambient sound copies a
track's URL, so deleting the track must not break the emitter.

**No dead code.** Two audits found helpers that were written, tested, and never
called — `movementBlocked` let players walk through walls, `deriveActor` made
conditions decorative. Before adding a feature, check that the last one is
actually reachable: `grep` the export and see whether anything outside its own
module and tests uses it.

**Enemy hit points are redacted from players in the tracker.** Knowing the boss
is on 7 HP changes how a table plays; that is the DM's to reveal.

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

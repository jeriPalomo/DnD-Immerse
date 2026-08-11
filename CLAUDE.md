# DnD Immerse

A self-hosted D&D 5e virtual tabletop for one friend group. Architecture is drawn
from **Foundry VTT** (self-hosted Node app), not Roll20.

**Read [docs/PLAN.md](docs/PLAN.md) first.** It holds the data model, the
wall-vision design, the 7-phase build sequence, and the reasoning behind the
choices below. Keep it updated in the same commit as the work it describes.

## Status

Phases 0–6 done. Combat runs: initiative rolled server-side, turn and round
tracking, damage with resistances read off the sheet, and automatic
concentration saves.

**Next: Phase 7** — playlists and positional ambient sounds, journal with map
pins, AoE templates. Also still open: avatar and campaign banner upload have
server routes but no UI.

## Commands

```bash
npm run dev          # API :3001 + client :5173
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

**Vision is computed on the server, never the client.** `realtime/vision.ts`
produces each player's polygon and sends them the polygon plus the tokens inside
it. Wall geometry is never in a player payload — doors are, because a door is a
thing you can see and open. This is a deliberate divergence from Foundry, which
computes vision in the browser and therefore ships every wall to every client.

**Derived actor data is a pure function.** `effects.ts` folds active effects
over base numbers and is never stored — the same rule as ability modifiers.
Modes apply multiply before add, so a +2 bonus is not itself doubled, and
`applied` names every effect that contributed so a total is explainable.

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

## Gotchas

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

**`data/` does not sync between machines.** The desktop is the server of record
and holds the real campaign database; other machines keep throwaway local data.
Never sync a live SQLite file between two running servers.

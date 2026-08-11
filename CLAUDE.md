# DnD Immerse

A self-hosted D&D 5e virtual tabletop for one friend group. Architecture is drawn
from **Foundry VTT** (self-hosted Node app), not Roll20.

**Read [docs/PLAN.md](docs/PLAN.md) first.** It holds the data model, the
wall-vision design, the 7-phase build sequence, and the reasoning behind the
choices below. Keep it updated in the same commit as the work it describes.

## Status

Phases 0–2 done: workspace, shared rules/grid math, full DB schema, Argon2
session auth, campaigns with invite codes, the Actor/Item document model, the
5e character sheet, and the SRD 5.1 compendium.

**Next: Phase 3** — Socket.IO infrastructure, presence, chat, the
server-authoritative dice engine, and chat cards with action buttons. That
phase ends at a fully playable game night.

## Commands

```bash
npm run dev          # API :3001 + client :5173
npm test             # Vitest: rules5e + grid math
npm run db:generate  # New migration after editing schema.ts
npm run srd:import   # Seed the compendium (downloads once, then cached)
```

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
nobody can fudge.

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

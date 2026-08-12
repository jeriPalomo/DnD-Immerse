# DnD Immerse

A self-hosted virtual tabletop for D&D 5e, built for one friend group. Draws its
architecture from Foundry VTT: a long-running Node process you own, rather than a
hosted service you rent.

## Running it

```bash
npm install
npm run dev
```

That starts the API on `:3001` and the client on `:5173`. Open http://localhost:5173.

The database, uploads and SRD data all live under `data/`, which is gitignored.
Migrations run automatically on boot; the SQLite file is created on first start.

Useful scripts:

| Command | Does |
|---|---|
| `npm run dev` | API + client together |
| `npm run dev:server` / `dev:web` | One at a time |
| `npm test` | Unit + realtime integration tests |
| `npm run srd:import` | Seed the SRD compendium |
| `npm run seed` | Example campaign with a full party |
| `npm run db:generate` | New migration after a schema change |
| `npm run build` | Production build |
| `npm run backup` | Snapshot the database and uploads into `data/backups/` |

## Letting your friends in

Serve over Tailscale rather than forwarding a port — your home IP is never
exposed and there is nothing to harden at the router.

```bash
tailscale serve --bg 5173
```

That publishes the app on your `*.ts.net` hostname with a real HTTPS
certificate. Invite your friends to your tailnet and send them the URL.

Set `SECURE_COOKIES=true` once you are serving over HTTPS.

## Rules editions

Campaigns pick 2014 (SRD 5.1) or 2024 (SRD 5.2) on the campaign page. The 2024
option adds the published equipment list and **weapon mastery** — Sap, Vex,
Topple and the rest, shown on the sheet beside each weapon.

Spells and monsters come from the 2014 list either way: the 2024 SRD dataset
does not publish them yet. `npm run srd:import` pulls both editions and says so.

## Backups

```bash
npm run backup
```

This machine holds the only copy of a campaign — sheets, maps, the journal, and
every player's fog exploration. The script snapshots the database with SQLite's
`VACUUM INTO` (a plain file copy of a live database can catch a half-written
page) alongside every upload, keeps the ten most recent, and prints what it
wrote. Worth running before each session, or on a scheduled task.

Restoring is a file copy: stop the server, put `app.db` and `uploads/` back
under `data/`, and start it again.

## How your friends join

One-time, per person:

1. Invite them to your tailnet from the Tailscale admin console
   (Settings → Invite external users). They get an email link.
2. They install Tailscale and click the link. No further configuration.

Then, any session:

3. You run `npm run dev` and `tailscale serve --bg 5173`
4. They open your `https://…ts.net` URL and register — any email and password,
   since the accounts live only on your machine
5. You send them the 8-character invite code from the campaign page; they press
   **Join with code**

Your machine has to be awake and running `npm run dev` for anyone to connect.

## Working across two machines

The **desktop is the server of record**: it holds the real campaign database and
hosts game nights. The laptop is a development machine with its own throwaway
local data.

Picking the project up anywhere:

```bash
git clone https://github.com/jeriPalomo/DnD-Immerse.git
cd DnD-Immerse
npm install     # native builds are pre-approved via allowScripts in package.json
npm run dev
```

Requires Node 20 or newer. Nothing else needs to move by hand — no build state,
no generated files, no credentials. Just `git pull` before you start and
`git push` when you stop.

**`data/` deliberately does not sync.** The SQLite file and uploaded maps are
gitignored and belong to whichever machine is hosting. Never sync a live SQLite
file between two running servers — concurrent writers will corrupt it. If data
genuinely needs to move, stop both servers and copy the folder explicitly.

That also makes `data/` the one thing here that cannot be rebuilt from git, so
once you have a real campaign in it, back it up.

## Credits

Compendium content is the **System Reference Document 5.1** by Wizards of the
Coast, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/),
sourced via [5e-bits/5e-database](https://github.com/5e-bits/5e-database).

## Layout

```
apps/
  web/      Vite + React + react-konva client
  server/   Fastify + Socket.IO + Drizzle
packages/
  shared/   Zod schemas, socket contract, 5e rules, grid math
data/       SQLite, uploads, SRD import  (gitignored)
```

`packages/shared` is the contract between client and server. Socket payloads,
the 5e rules math and the grid geometry are defined once there, so the two sides
cannot drift apart without a compile error.

## Design rules worth keeping

**Token coordinates are grid units, not pixels.** Pixel position is derived at
render time from the scene's grid size and offset. Recalibrating a map's grid
after upload — which always happens — then does not scramble the board.

**Distance is measured footprint to footprint.** `tokenDistance()` in
`packages/shared/src/grid.ts`, never `gridDistance()`. Center-to-center reports
a Medium creature against the flank of a 4×4 Gargantuan dragon as 25 feet and
refuses legal melee attacks.

**Derived values are computed, never stored.** Ability modifiers, save DCs and
passive scores come from pure functions in `rules5e.ts`. Storing them guarantees
they drift.

**Hidden things are filtered server-side, never hidden client-side.** Hidden
tokens must not appear in a player's payload at all, and wall geometry is never
sent to players — it is a map of the dungeon. Rendering a black overlay over
data the client already holds is a screenshot away from spoiling an ambush.

**Dice are rolled on the server.** Half the value of a shared table is that
nobody can fudge.

## Status

Phases 0 through 2 are done: workspace, shared rules and grid math, the full
database schema, Argon2 session auth, campaigns with invite codes, the
Actor/Item document model, the 5e character sheet, and the SRD 5.1 compendium
(319 spells, 334 monsters, 599 items).

Run `npm run srd:import` once to seed the compendium. It downloads on first
run and caches under `data/srd/`, so later imports work offline.

Next up is Phase 3 — realtime chat, presence, and the server-authoritative dice
engine, which is the point the site becomes playable for a real session. See
[docs/PLAN.md](docs/PLAN.md) for the full architecture and phase sequence;
Phase 4 brings the battle map, with walls and vision after that.

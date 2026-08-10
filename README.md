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
| `npm test` | Unit tests (rules + grid math) |
| `npm run db:generate` | New migration after a schema change |
| `npm run build` | Production build |

## Letting your friends in

Serve over Tailscale rather than forwarding a port — your home IP is never
exposed and there is nothing to harden at the router.

```bash
tailscale serve --bg 5173
```

That publishes the app on your `*.ts.net` hostname with a real HTTPS
certificate. Invite your friends to your tailnet and send them the URL.

Set `SECURE_COOKIES=true` once you are serving over HTTPS.

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

Phases 0 and 1 are done: workspace, shared rules and grid math, the full
database schema, Argon2 session auth, and campaigns with invite codes.

Next up is Phase 2 — the Actor/Item document model on screen, the 5e character
sheet, and the SRD 5.1 compendium import. See the plan for the full sequence;
the short version is that Phase 3 gets you a playable game night and Phase 4 a
working battle map, with walls and vision after that.

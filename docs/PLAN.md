# DnD Immerse — Architecture & Build Plan

> The living plan for this project. Update it in the same commit as the work it
> describes, so it never drifts from the code.

## Context

A private VTT for one friend group: accounts, player-owned D&D 5e character
sheets, and DM-created campaigns ("stories") players join. Initial inspiration
was Roll20; the design then shifted to draw from **Foundry VTT**, which is the
better model — Foundry is a self-hosted Node application, exactly the architecture
already chosen here, so its design decisions transfer directly rather than needing
translation.

Four decisions set the scope:

1. **Foundry's Actor/Item document model** — everything a character owns is a
   first-class Item document, not a JSON blob.
2. **Wall-based dynamic vision** — real line-of-sight with automatic fog
   exploration, not DM-painted fog.
3. **Playlists plus positional ambient sounds** — audio emitters placed on the
   map, audible by proximity.
4. **Heavy rules automation** — active effects, automatic saves, concentration,
   resistance math.

**Scope reality:** items 2 and 4 are the two hardest features in Foundry, and this
is a months-long project rather than a weekend one. The phasing is therefore
strict: **a fully playable game night at the end of Phase 3**, and a working
battle map at the end of Phase 4. The expensive work is deliberately last, so a
stall never leaves you with nothing to play on.

---

## Architecture

### Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | Vite + React + TypeScript | Fast HMR, no server-component complexity |
| Canvas | **react-konva** (Konva.js) | Drag, transformers, layers, hit detection built in |
| Client state | Zustand | Minimal boilerplate for a socket-driven store |
| Styling | Tailwind CSS v4 | |
| Backend | Fastify + Socket.IO | One process serves REST, WebSockets, and the built client |
| Database | SQLite via Drizzle + **`@libsql/client`** | Single file, zero ops |
| Validation | Zod, shared both sides | One definition per payload |
| Auth | Session cookies + Argon2 (`@node-rs/argon2`) | No OAuth providers needed |
| Images | `sharp` | Re-encode + thumbnail on upload |
| Dice | `@dice-roller/rpg-dice-roller`, **server-side only** | Handles `4d6dl1`, `2d20kh1`, exploding |

`better-sqlite3` has no prebuilt binary for Node 24 and would require a node-gyp
toolchain, hence libsql — SQLite-compatible with prebuilt Windows binaries.

### Repo layout

```
apps/
  web/      Vite + React client
  server/   Fastify + Socket.IO + Drizzle
packages/
  shared/   Zod schemas, socket contract, 5e rules, grid + vision math
data/       gitignored: app.db, srd/, uploads/{maps,tokens,avatars,audio}/
```

`packages/shared` is load-bearing. Every socket payload, the 5e rules math, and
the vision geometry live there so client and server cannot disagree.

### Access model

Serve over Tailscale, not an open port. `tailscale serve` provides a real HTTPS
certificate on the `*.ts.net` hostname, which matters because `Secure` cookies
require HTTPS. Friends install the client once and join the tailnet; the home IP
is never exposed.

---

## Data model

Foundry's document model, adapted.

**Hot scalars stay real columns; the long tail goes to JSON.** Foundry puts
everything in a `system` blob, which makes "show me the party's HP" unqueryable.
Ability scores, HP, AC and level are read constantly by the party panel and token
HUD, so they stay indexed columns. Type-specific detail (spell components, weapon
properties) goes in a Zod-validated `system` JSON column.

```
users, sessions
campaigns, campaign_members(role: dm|player)

actors            id, ownerUserId?, campaignId?, type(character|npc), name, portraitUrl,
                  level, str..cha, ac, hp, hpMax, speed, ...,
                  prototypeToken (json: image, size, vision, darkvision, disposition, linked)
items             id, ownerActorId?, campaignId?, type(weapon|spell|feature|equipment|
                  consumable|class|background|race), name, imageUrl, system (json), sortOrder
ownership         documentType, documentId, userId, level(0 none|1 limited|2 observer|3 owner)

scenes            id, campaignId, mapImageUrl, mapWidth/Height, gridSize, gridOffsetX/Y,
                  feetPerSquare, globalIllumination, darkness
tokens            id, sceneId, actorId?, actorLinked, x, y, w, h (GRID UNITS, real),
                  hp, maxHp, conditions, visionRange, darkvisionRange, lightBright, lightDim,
                  disposition, hidden, locked
walls             id, sceneId, x1,y1,x2,y2, move, sense, sound, door, doorState
lights            id, sceneId, x, y, brightRadius, dimRadius, color, hidden
fog_exploration   sceneId, userId, exploredBitmap (base64)
templates         id, sceneId, shape(circle|cone|ray|rect), x, y, direction, distance, angle

chat_messages     id, campaignId, userId, actorId?, kind(text|roll|card|system), body,
                  rollData (json), cardData (json), whisperToUserId?
encounters, initiative_entries
active_effects    id, ownerActorId?, ownerItemId?, name, icon, changes (json),
                  duration (json), disabled, transfer

playlists, playlist_tracks, ambient_sounds(sceneId, x, y, radius, trackUrl, walls, hidden)
journal_entries, journal_pages, map_notes(sceneId, x, y, journalPageId, icon, hidden)
srd_spells, srd_monsters, srd_items
```

### Design decisions that matter

**Linked vs unlinked tokens.** A PC's token is *linked* to its actor — HP edits
sync both ways, one source of truth. A monster token is *unlinked*: dropping a
Goblin copies the actor data onto the token, so five goblins have five independent
HP pools. Roll20 handles this poorly and it bites every combat; Foundry's approach
is cheap to implement and correct.

**Ownership is a table, not a boolean.** `none | limited | observer | owner` per
user per document. Filtering happens server-side on every read. A DM sharing one
NPC's sheet with one player is then a row, not a special case.

**Token coordinates are grid units, not pixels.** Pixel position is derived at
render time. You *will* recalibrate a map's grid after uploading it, and this is
what stops that from scrambling the board.

---

## Creature size and targeting

### Sizes larger than one square

Tokens carry `w`/`h` as fractional grid units, so any footprint works. 5e sizes
map directly:

| Size | Space | Token |
|---|---|---|
| Tiny | 2½ ft | 0.5 × 0.5 |
| Small / Medium | 5 ft | 1 × 1 |
| Large (ogre, horse) | 10 ft | 2 × 2 |
| Huge (adult dragon, treant) | 15 ft | 3 × 3 |
| Gargantuan (ancient dragon, kraken) | 20 ft+ | 4 × 4 or larger |

Size drives three behaviours that are wrong by default:

**Distance is measured rectangle-to-rectangle.** 5e measures to a creature's
*nearest occupied square*. `gridDistance()` takes two points, which would report an
ancient dragon as 4 squares further away than it is — telling you a melee attack is
out of reach while you stand against its flank. Use `tokenDistance()` in
`packages/shared/src/grid.ts` for every reach, range and AoE check, never raw
`gridDistance`.

**Snapping.** Because position is stored as the top-left corner rather than the
center, a single integer snap is already correct for every whole-square size: a
1×1 lands centered in a square, a 2×2 lands centered on an intersection. That is
the same result as Foundry's odd/even center-parity rule without the special case.
Sub-square tokens (Tiny, 0.5) snap to their own size so four can share one square.
See `snapTokenPosition()`.

**Vision originates from the token's center**, via `tokenCenter()` — not its
top-left corner. For a Gargantuan token that is a 2-square error, enough to see
around corners it shouldn't.

### The target action panel

Select your own token, then click an enemy to target it. A panel lists everything
you could do to that target — attacks and spells — with illegal options **greyed
out and labelled with the reason**, rather than hidden:

- *"Out of range — 30 ft away, spell range 5 ft"*
- *"No 3rd-level slots remaining"*
- *"No line of sight"*

Showing the reason is the point. Hiding invalid options makes the app feel
arbitrary; explaining them teaches the rules mid-session and lets a player argue
the ruling with the DM.

Requires `tokenDistance()` for range, SRD range-string parsing (`parseRange()` in
`packages/shared/src/documents.ts`), slot availability from the actor, and a
line-of-sight check reusing the Phase 5 vision code. A basic version (range +
slots) lands in Phase 4; line-of-sight and slot expenditure enrich it in Phases 5
and 6.

---

## Wall-based vision (Phase 5) — the hard part

### Where it runs: the server, not the client

Foundry computes vision client-side, which means every client holds all walls and
all tokens and merely declines to draw them. A curious player with devtools can
read the entire dungeon and every hidden monster. Foundry accepts this; we should
not, because it silently defeats the point of fog.

So: **the server computes each player's visibility polygon and sends only (a) the
polygon and (b) the tokens inside it.** Raw wall geometry is never sent to players
— only to the DM, who needs it to edit. The client renders fog from a polygon it
is handed. This is both more secure than Foundry and *simpler* on the client.

### Algorithm

Standard angular sweep, in `packages/shared/src/vision.ts` as a pure function:

1. From origin O, collect every wall endpoint. Cast three rays per endpoint
   (θ, θ−ε, θ+ε) — the ε pair is what lets rays slip past corners and hit the wall
   behind.
2. For each ray, take the nearest intersection across all wall segments, capped at
   the vision radius.
3. Sort hits by angle and connect into a polygon.

Cost is O(rays × walls). At 300 walls that's ~1800 rays × 300 segments ≈ 500k
intersection tests, low single-digit milliseconds in JS. Recompute on token move
(throttled to ~10Hz during drag, full compute on commit), on door toggle, and on
light change.

A token's visible region is `visionPolygon ∩ (illuminated area ∪ darkvisionRadius)`,
where illumination is the union of light polygons plus scene global illumination.
A player's total view is the union over all tokens they own.

### Fog exploration: bitmap, not polygons

Accumulated polygon unions grow without bound. Instead store a **coarse bitmap —
one bit per grid square** — per (scene, user). Union is a bitwise OR; a 100×100
scene is 10,000 bits ≈ 1.25 KB. Bounded, fast, trivially serializable.

This yields Foundry's three-state fog for free, which is most of why it looks so
good: **black** where never explored, **dimmed** where explored but not currently
visible (you remember the room's shape but not who's in it now), **clear** where
currently visible. Tokens are sent only for the *clear* region.

**Doors** toggle `doorState` and trigger recompute for everyone. Opening a door and
watching the room bloom into view is the single best moment in the app — worth
getting right.

---

## Rules automation (Phase 6)

**Active Effects** are the engine. An effect carries
`changes: [{ key, mode, value }]` where mode is
`add | multiply | override | upgrade | downgrade`, applied in a deterministic
order.

Derived actor data is a **pure function** in `packages/shared/src/effects.ts`:

```
deriveActor(baseActor, items, activeEffects) -> DerivedActor
```

Never stored, always computed — the same rule as ability modifiers. Bless becomes
an effect granting `+1d4` to attack rolls; equipping plate armor becomes an effect
overriding AC; a condition like `prone` becomes an effect flagging disadvantage.
Because it is one pure function, it is also directly unit-testable, which matters
enormously once the rules interactions multiply.

Built on that: damage application from chat cards with
resistance/vulnerability/immunity math, automatic concentration saves (DC 10 or
half damage, whichever is higher) when a concentrating actor takes damage,
targeted saving throws from spell cards, and automatic spell slot expenditure.

**Automation assists, it never overrides.** Every automatic result posts to chat as
a card the DM can undo. A rules engine that silently makes a wrong call is worse
than no rules engine.

---

## Build phases

| Phase | Contents | Ends at |
|---|---|---|
| 0 ✅ | Workspace, shared math, socket contract, DB schema | — |
| 1 ✅ | Session auth (Argon2), campaigns, invite codes, ownership layer | Friends can join your story |
| 2 ✅ | Actor/Item UI, 5e sheet, SRD 5.1 import, compendium picker | Sheets exist and are live |
| 3 | Socket infra, presence, chat, server-authoritative dice, chat cards with action buttons | **Fully playable game night** |
| 4 | Scenes, map upload, grid calibration, token CRUD, sized tokens, linked/unlinked, token HUD, targeting + action panel, realtime drag | **Working battle map** |
| 5 | Walls, doors, lights, server-side vision, bitmap fog exploration | Real line-of-sight |
| 6 | Initiative tracker, active effects, damage application, concentration, saves | Full automation |
| 7 | Playlists, positional ambient sounds, journal with pages, map pins, AoE templates | Immersion layer |

---

## Realtime protocol

Socket.IO rooms per campaign, plus a **separate DM room**
(`campaign:{id}:dm`). The room split is what makes secrecy structural: DM-only
data travels on a channel players are never joined to, so there is no per-message
`if (isDM)` branch to forget. See `campaignRoom()` / `campaignDmRoom()` in
`packages/shared/src/socket.ts`.

Dragging is the one performance-sensitive path. The dragging client emits
`token:move` at ~30Hz carrying only `{tokenId, x, y}`; the server validates
permission, recomputes vision, and rebroadcasts **without touching the database**.
`token:commit` persists once on drag end. Writing every frame to SQLite would be
thousands of pointless writes per combat.

Conflict resolution is last-write-wins. At six players that is correct and free.

---

## Security invariants

These are structural. Getting them wrong is not a bug you notice — it is a
campaign quietly spoiled.

1. **Hidden and out-of-sight tokens are filtered from payloads, never hidden in
   the client.**
2. **Wall geometry is never sent to players.** It is a map of the dungeon.
3. **Every socket handler re-checks authorization.** Room membership
   authenticates; it does not authorize.
4. **Dice are generated server-side.** Half the value of a shared table is that
   nobody can fudge.
5. Uploads re-encoded through `sharp` (strips EXIF, blocks polyglot files),
   size-capped, stored under generated filenames.
6. Argon2id passwords; cookies `httpOnly`, `sameSite: 'lax'`, `secure` under
   `tailscale serve`.

---

## Verification

**Every phase, manually:** `npm run dev`, then two browsers — one normal, one
incognito — as DM and player. The two-client check is the only way to catch
realtime bugs; make it reflexive.

**Unit tests (Vitest) where they pay for themselves.** These are pure functions
with exact expected values:

- `rules5e.ts` — modifiers, proficiency scaling, save DCs
- `grid.ts` — pixel↔grid round-tripping, snapping, 5e diagonal distance under both
  rules, and `tokenDistance` between footprints: a Medium token adjacent to a 4×4
  Gargantuan reads **5 ft, not 25 ft**
- `vision.ts` — a token in a sealed room sees only that room; opening a door
  extends the polygon through the gap; a wall corner does not leak
- `effects.ts` — effect mode ordering, stacking, resistance/vulnerability math

**Three invariant tests that must exist**, because these are the regressions that
cost you a session:

- A player's `scene:state` payload contains **no hidden tokens**
- A player's `scene:state` payload contains **no tokens outside their visibility
  polygon**
- A player's payload contains **no wall geometry**

**End-to-end before a session:** DM builds a scene, uploads a map, calibrates grid,
draws walls, drops linked PC tokens, unlinked goblins, and a 4×4 Gargantuan dragon.
A player joins over Tailscale from another machine, moves their token, watches fog
reveal as they walk, fails to drag a token they don't own, opens a door and sees
the room appear, steps adjacent to the dragon and confirms the action panel offers
melee attacks (proving footprint distance works), targets it, and casts a spell
that applies damage with resistances accounted for.

---

## Deferred

Colored/animated lighting, weather effects, a module system, in-browser voice
(Discord does it better), and 2024 rules — the sheet targets SRD 5.1 / 2014, and
2024 changes are additive later.

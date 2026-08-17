# Backlog — post-phase-7 fixes

Raised 2026-08-13 after playing with the finished build. Grouped as they were
given, with the root cause where one has already been found. Tick items off in
the same commit as the work.

Phases 1-7 are done; this is the punch list from actually using the thing.

> **Cross-machine note.** The desktop is the server of record and holds the real
> campaign database. This file is the handoff — `data/` does not sync, but this
> does. Pull before picking anything up.

## Where this stands

**Done** (2026-08-13): everything below. Table 1 was resolved by deleting the
audio system rather than extending it.

> **Run `npm run db:migrate` after pulling.** Migration `0010` moves every
> token's conditions into `active_effects` and drops `tokens.conditions`, so a
> server on the old schema will not start against the new code. It was written
> and verified on the laptop, which has no `data/` at all — **it has not yet run
> against the real campaign database.** Take a `npm run backup` first, as usual.

**Still open:** the Online/Local split at the bottom, deferred by choice.

---

## Status effects, whispers and four defects — 2026-08-17

The through-line: **conditions were half-built, and the two halves disagreed on
screen.** `tokens.conditions` was folded into real mechanics only by
`apps/web/src/lib/derive.ts`, in the browser. The server — the authority for
vision, movement and every roll — read raw actor columns. So a paralyzed token's
HUD said Speed 0 while the server highlighted its full 30 ft of movement range,
at the same time, three inches apart. Meanwhile `active_effects`, with durations,
an expiry hook and unit tests, had **never held a row**: no insert path existed
anywhere.

**One store.** Migration `0010` carries every token's conditions into
`active_effects` and drops the column; `duration` becomes nullable, and the
never-read `turns`/`startTurn` pair is gone. `deriveToken` moved into
`packages/shared`, so the HUD, `speedOf`, the vision sweep and the attack roll
all fold the same function. A condition row keeps an empty `changes` and names
itself in `statusId` — its mechanics are looked up when read, so fixing what
"prone" does fixes every prone token. The cross-campaign delete in
`expireEffectsFor` is closed by joining through the scene, which was a tripwire
the moment an insert path existed.

**Timers, editable.** `effect:apply` / `effect:update` / `effect:remove`, gated
by the same `isFairGame` rule as damage: a player may condition a monster, never
another character, and may clear one from their own token. The HUD lists each
effect with its countdown, a stepper and an ×. Rounds only advance in a fight,
so **nothing ticks outside combat** — stated in the log line rather than
silently dropping the timer.

**Automatic application.** `SPELL_CONDITIONS` in `rules5e.ts` is a curated,
unit-tested map of the SRD spells that inflict conditions; hand-entered items
carry their own `appliesConditions`, with fields in the manual form. Spells with
no save (Sleep, Color Spray), a non-condition effect (Slow, Confusion) or staged
saves (Flesh to Stone) are deliberately absent — an omission is the old
behaviour, a wrong entry is the app being confidently wrong.

Found on the way: **`chat:cardAction` rolled the caster's own save, with the
caster's proficiency, against the caster's own DC.** The wrong creature and the
wrong number, on every spell ever cast from a card. The target now rolls.

**Blindness.** `flags.blinded` collapses `sightRadiusFeet` to 0.
`combinedVisibility` already dropped zero-radius sources and `visibleTokens`
already fell back to your own tokens, so the server side was five lines. What
was missing was the render: fog sits above tokens, so a blinded player got an
unbroken black rectangle. `FogLayer` now punches the viewer's own squares clear.

**Whispers are validated, then gated on adjacency.** The hole first:
`whisperToUserId` was never checked, and every socket joins its own personal
room regardless of campaign — so a member could whisper **any user id on the
server**, including someone in another game. Now: membership required, the DM
exempt both ways, otherwise `tokenDistance <= 1` on the active scene. The
dropdown greys unreachable names. Refusals are vague on purpose.

**Two more defects.** `initiative:update` had a complete handler and no client
caller, so a mistyped initiative could not be corrected — wiring it up meant
first scoping `encounterId` to the campaign, which it took on trust.
`scene:list` and `scene:updated` were declared and never emitted, `scene:changed`
emitted and never handled; all three deleted.

Also fixed while there: `token:update` re-emitted only the changed token, so
blinding somebody — or editing their `visionRange` — never recomputed their
polygon.

Verified in the running app with two browsers over a throwaway `DATA_DIR`: a
timer counting 3 → 2 → expiring with `Round 3: Restrained expires.` in the
battle log; a grappled token's red movement range collapsing to nothing while
the HUD reads `Speed 0 ft (was 30)`; a blinded player's payload containing his
own token alone, zero polygons and zero fog; and the whisper dropdown flipping
`Elaria` to `Elaria — too far` as she walks away.

**Not done, by decision:** the `triggers` table and pressure-plate firing from
the hidden-passages work below. Walls get drawn and deleted by hand instead.

---

## Hidden passages — 2026-08-15

Stage 1 of interactive map objects (switches, keys, puzzles). This stage is the
prerequisite and stands on its own; the trigger table comes next.

**`door: 2` meant "secret door" and nothing read it.** Verified across the whole
repo: `blocksSight`/`blocksMovement` test `door > 0`, `DoorLayer` branched on
`doorState` alone, and the wall tool could only produce 0 or 1. So a secret door
was drawn, **sent to players**, and clickable exactly like an ordinary one — the
bookcase announced the passage behind it.

Fixed: secret doors are filtered out of the player payload the same way walls
are, `door:toggle` refuses one for a non-DM (silently — a player was never sent
it, so confirming it exists is itself the leak), and the DM gets a **Secret**
wall tool plus alt-click on a dotted purple seam to reveal it. Revealing sets
`door: 1`, at which point the existing `DoorLayer` draws it and the party can
open it with no new rendering.

The bare integers became named constants (`PLAIN_WALL`, `DOOR`, `SECRET_DOOR`,
`DOOR_CLOSED/OPEN/LOCKED`) — being a magic number described only in a comment is
most of why this went unnoticed. `blocksSight: 2` was documented as "terrain"
and is equally unread; the comment now says so rather than implying it works.

Along the way this finally gave `wall:update` a caller. It had existed since
walls did with none, so **a DM could not lock a door through the UI** — alt-click
does that now too. Two holes in it closed: it accepted `sceneId`, while `wallIn`
validated the scene the wall was in *before* the move, so a wall could be pushed
into another campaign's scene; and a payload of just an id reached
`db.update().set({})`, which Drizzle throws on.

Verified end to end over real sockets: DM sees `door, SECRET`, player sees only
`door`, the player poking the secret id does nothing, and after the reveal they
both see it and can open it.

**Still to build:** the `triggers` table, click and pressure-plate firing, item
and trigger gating. Note for that work — `postSystemMessage` is private to
`combat.ts` and hard-codes `combat: true`, so a trigger cannot announce itself in
the conversation tab without extracting it.

---

## Movement ranges — 2026-08-15

Fire Emblem style: select a unit and see where it can go, toggle the reach of
everything hostile, pick one enemy out of that union.

**The blocker was telling friend from foe.** `disposition` was the right field
and was effectively unreachable — no UI set it anywhere, bestiary monsters were
forced hostile at *two* independent points, and `'friendly'` was written in one
place in the whole repo. There was no path that produced a friendly or neutral
NPC at all, so a friendly ogre had to be built as a player character.

Fixed first, and worth having on its own: a three-way control in the token HUD,
disposition added to the DM-only field list (it decides who the threat overlay
paints, so a player able to re-flag their own token could opt out of being one),
the unconditional overwrite at placement made `??`-guarded like its neighbours,
a **New NPC** button, and NPC actors now defaulting to neutral rather than
hostile — the hostile default belongs to the bestiary, where it is set
explicitly. The disposition ring was also last in precedence behind
down/targeted/selected, so it vanished exactly when you were working with a
token; there is a pip now.

**The reachability core** is `packages/shared/src/movement.ts` — a BFS gated by
speed, walls and occupancy, with footprints respected so a Gargantuan dragon
cannot squeeze through a doorway. 14 unit tests carry it.

Two things surfaced while building it. `movementBlocked` is a **single
centre-to-centre segment** as `token:commit` uses it, which both under-blocks
and over-blocks; the fill steps one square at a time, which is the honest use.
And the DMG's optional diagonal rule is **path-dependent** — one diagonal costs
the same under both rules and the difference only lands on the next — so a
per-step cost cannot express it. Rather than ship a `rule` parameter that
quietly behaved as `standard`, there isn't one.

**It runs on the server** because players never receive walls, answered to the
asking socket alone. A player's threat range is clipped to explored fog, with a
test asserting no square outside it ever arrives.

Colours: blue for your unit, green for neutral, red for hostile — hostile is
the only thing the threat union covers. Drawn under the tokens and under the
fog, so a player's overlay is covered wherever their sight is. The union uses
`FogLayer`'s single-path fill; one token's range uses per-square `Rect`s.

---

## Bug sweep — 2026-08-14

A three-way audit of the server, the client and the stated invariants. Nine
defects fixed; the interesting thing is how many were a guard that existed but
asked the wrong question.

**A malformed socket payload killed the server.** Handlers open with
`schema.parse`, socket.io does not await a listener's promise, and Node's
default for an unhandled rejection is to exit — so one stray field dropped
everyone at the table. `guardHandlers` now wraps `socket.on` once per
connection; there is an `unhandledRejection` net under it that logs loudly
rather than exiting. Verified by sending four malformed payloads: three Zod
failures came back as clean client errors, the server stayed up.

**Authorization asked about the wrong campaign.** `context()` returns the
*first* joined room, and handlers took ids on trust — so a DM of their own game
who was also a player in yours could delete your tokens, toggle your doors or
apply damage in your campaign, because the only question asked was "is this
socket a DM somewhere". Every id now resolves through `tokenIn` / `wallIn` /
`tokensIn`, which join to `scenes.campaignId`.

**Two vision leaks, same root cause.** `filterTokensFor` had no sight
component — the doc comment promised a second filter that actually lived in
`broadcastSceneState`. So `token:created` shipped an ambusher's full stat line
to every player, and `token:move` streamed coordinates at 30Hz checking only
`hidden`. The create path now goes through `broadcastToken`, which already did
this correctly; the drag path takes the DM-room fast path when vision is on and
re-emits per socket to players who can actually see it.

**Enemy HP was redacted in exactly one place out of four.** `toWireToken` sent
raw `hp`/`maxHp` to players, so the tracker's careful redaction was undone by
the board tooltip, the token HUD and the target panel. Redacted at the wire
now. All four render sites already guarded on null, so they degrade to showing
nothing — note this means players no longer see a monster's health bar at all,
which is stricter than a coarse bloodied/healthy indicator would be.

**`token:update` was a way around the rules.** `x`/`y` were not in the DM-only
field list, so writing position through that event skipped the clamp and the
wall check that `token:commit` performs. `visionRange` was writable too, and it
is what the vision sweep measures from — a player could grant themselves the
whole map, permanently, since the fog exploration it produces is persisted.

**Shared files were deleted out from under live rows.** `tokens.actorId` is
`set null`, so tokens outlive their actor while holding the portrait they
inherited; deleting an actor unlinked a file its own tokens still drew. Same on
portrait replacement, and on token art (which was prefix-checked rather than
reference-checked). All now go through `deleteOrphanedUploads`, which also
gained the `items.imageUrl` column it was missing. Map and banner replacement
leaked the old file entirely and now clean up.

**Two regressions from the previous pass, both mine.** The spell picker gated
on `maxSpellLevel`, which returns -1 for a class it does not recognise — and
cantrips are level 0, so a homebrew or multiclass name blocked *every* spell.
Only a recognised caster is gated now. And `CampaignSettings` shared one
debounce timer across name, description and ruleset, so typing a name and
tabbing to the description cancelled the name's save and then wrote the
server's older name back over the box; edits accumulate now and flush on close.

**Left alone deliberately:** `expireEffectsFor` has no campaign filter and
takes a `campaignId` it never uses — real, but `activeEffects` has zero insert
paths, so it deletes from an always-empty table. Fix it when timed effects get
built. Also noted and not acted on: `wall:update` has a working server handler
and no client caller, so a DM cannot lock a door through the UI.

*Both since done:* `wall:update` was wired by the hidden-passages work, and
`expireEffectsFor` was campaign-scoped when timed effects were built on
2026-08-17.

---

## Third pass — 2026-08-14

Twenty items. The through-line was that the 5e layer knew almost nothing:
`CLASSES` held a hit die and a casting ability and that was all.

**Rules layer.** `rules5e.ts` gained saving throws per class, caster progression
(`full` / `half` / `pact`) driving `maxSpellLevel`, `SPECIES_BONUSES`, and hit
point helpers — all unit tested against the handbook, 32 tests in that file now.
Picking a class fills its two saving throws; the Abilities block shows species
increases as green chips and marks class-granted saves. The spell picker opens
on the character's own class and lists every spell on it, refusing Add above
their slot level with the reason on the row. Level up offers rolling the class
die or taking the average, server-rolled and posted to the table.

Found while looking: `chat.ts` rolled saves from item cards with `proficient`
hardcoded `false`, so a save rolled off a card was short by the whole
proficiency bonus.

**The board.** Dragging a token moved the map — Konva bubbles `dragend` to the
Stage, whose handler wrote the token's pixel position into the pan origin.
Guarded, and the token's own handlers now stop the bubble; a non-draggable token
also stops its mousedown, which was starting a real pan. Pings pulse instead of
sitting there. Scenes can be deleted (the route existed and had never had a
caller, and did not broadcast). The shortcut hint collapses to a corner toggle,
remembered via a new `lib/prefs.ts` — the first persisted preference in the app.

**Chat and combat.** A `combat` flag on `chat_messages` splits one log into Chat
and Battle tabs. Turn changes are logged for the first time. The DM can clear
the log. A player can apply their own damage roll to a targeted monster —
`isFairGame` refuses characters and healing — and `damage:applied` now reaches
the room rather than only the person who pressed the button.

**Elsewhere.** Profile settings behind your name in the header (`PATCH
/api/auth/me` had existed with no caller since accounts were built), with a new
password-change route. Campaign header reworked, Last session shows the map
large with the scene named beneath it, Rest moved into the hit point card, token
art and an eye toggle in the HUD, and the requested text removals.

---

## Second pass — 2026-08-14

### Campaign properties, and settings behind a gear — DONE

Creating a campaign now navigates straight into `CampaignSettings` (a modal over
the campaign page) rather than dropping you back on the grid. The gear at the
top right of a campaign reopens it. It holds name, description, rules edition,
banner, invite-code rotation, the player list with remove, and delete — every
campaign-level control in one DM-only place.

**Name and description were previously unreachable after creation** — there was
no rename anywhere in the app. `PATCH /api/campaigns/:id` already accepted both;
nothing called it.

The campaign page is now a read-only overview: invite code (click to copy) and
gear at the top right, an **On the Journey…** roster, and the last-session card.
The old ruleset / banner / invite cards are gone, and with them four lines of
helper text. `InviteCard` went with them; its Copy moved onto the header chip.

Server changes:
- `GET /api/campaigns/:id/members` now carries `characters: { id, name,
  portraitUrl }[]` per member, joined through `actorCampaigns` and filtered to
  `type === 'character'`. **NPCs are excluded** — the name is the leak. This
  replaces correlating two requests by owner id on the client.
- `POST /api/campaigns` re-reads the inserted row instead of echoing a literal
  that omitted `ruleset` and `recap`, so the settings panel opens on real values.
- `GET /api/actors/:id` includes each campaign's `ruleset`, so the sheet's
  compendium picker offers the edition actually being played — it browsed the
  2014 equipment list in a 2024 campaign regardless.

Roster rows deliberately have no Remove/Leave. The DM removes from settings; a
player gets a "Leave this campaign" link at the foot of the page.

### The bestiary showed nothing — ENVIRONMENTAL, plus two real bugs

**The cause was that `npm run srd:import` had never run on this machine.** All
three SRD tables were empty and `data/srd/` held no cached downloads, so every
compendium surface correctly rendered zero rows. Imported: 319 spells, 337
monsters, 1042 items.

Two genuine defects were hiding behind it, and both would still bite:

1. **The bestiary silently truncated at 60 of 337.** `MonsterBrowser` sent no
   `limit` and had no paging; the monsters route took no `offset` and returned
   no `more`, so the client could not know it was truncated. Commit `e11dadc`
   added exactly this to spells and items and skipped monsters. Both ends fixed,
   with a regression test.
2. **"Nothing matches that search." was shown for an empty search.** Both
   browsers now distinguish a failed search from an unimported compendium and
   name `npm run srd:import`. This is what made an environment problem look like
   a broken feature.

Also dropped: a `ruleset` parameter the monsters route parsed and never used.

### Permissions audit — NO CHANGES NEEDED

Every campaign-level write is already `requireDM`: the campaign patch, all five
scene routes, every journal write, `token:create`/`token:delete`, all three wall
events, `scene:activate`, and every combat event including `damage:apply`. What
a player may mutate is scene-scoped and deliberate — their own token's position
and image, door toggles, drawings and pings (both gated on the DM's
`scene.playerDrawing`), and AoE templates.

One defensive tidy: `BattleMap`'s stage click called `placeNote` and
`createWall` with no role check. Unreachable for a player today only because the
tool buttons live in a DM-only panel and the server rejects both — but
`wallTool` is in the shared store, so "no button" was not a permission check.

"The party" is now "Party".

### Not fixed, on purpose

~~The whisper dropdown in `ChatPanel` lists **presence**, not membership, so an
offline co-player cannot be selected.~~ **Wrong on the facts, and now
superseded.** The `presence` event carries every campaign member with an
`online` flag, so offline players were always selectable — the event is merely
*named* presence. The dropdown is now gated on token adjacency instead; see the
2026-08-17 entry.

---

## Table

### 1. Ambient audio from YouTube links — CLOSED, feature removed instead
The ask was to paste a YouTube link rather than upload a file. The answer was
that Discord already carries the music at this table, so on 2026-08-13 the
audio system came out entirely: playlists, uploaded tracks, the soundboard,
combat auto-switching, positional emitters and wall sound-occlusion, four
tables and the `walls.blocks_sound` column (migration `0008`).

What was knowingly given up: positional ambience — a waterfall that gets louder
as you walk toward it, and muffles behind a door — which Discord cannot do.
That was the call, not an oversight. See the Status note in `CLAUDE.md` before
rebuilding any of it.

### 2. Journal "show" button does not work — DONE
Two separate faults, both real:

1. **Solo campaigns silently no-op.** The share route looped over campaign
   members and `continue`d past the DM, so with no players joined it wrote zero
   `ownership` rows — and the GET derived `shared` from "does a grant row
   exist", reported false straight back, and the pill snapped from "shown" to
   "show". It was a genuine no-op, not a display bug.
2. **No live push.** Sharing emitted nothing, and the panel only loaded on
   mount, so a player already at the table saw nothing until they reloaded.

*Shipped:* sharedness is a `shared` column on the entry (migration `0005`), the
player filter reads it directly, and the route emits `journal:changed` to the
campaign room. The panel refetches on it rather than receiving entries over the
socket, so the server stays the only thing deciding what a player may hold. The
journal grants in `ownership` were doing nothing else and are gone; the
migration carries existing sharedness across. Regression test:
"shares in a campaign the DM has not filled yet".

### 3. Dice: a count + type picker, not seven buttons — DONE
`DiceBuilder` in `ChatPanel`: a count input, a die-type select (`DIE_TYPES`
replaces `QUICK_DICE`), and a modifier. Bounds come from `DICE_LIMITS` rather
than a second hand-written limit. The expression is still only a string the
server rolls.

A literal `+` sits between the die type and the modifier — without it the last
box reads as a second die count and nobody finds the bonus. It stays a `+` when
the modifier is negative, which looks odd for a beat, but the roll button spells
out the real expression (`Roll 2d6-2`) so nothing is ambiguous. The button is on
its own centred line below the fields, since it is the thing being aimed at.

### 4. "Coming next" card → last session recap — DONE
The stale Phase-3 placeholder is now a **Last session** card:

- The live scene, its thumbnail, and whether combat is still open (with the
  round number) — derived server-side on every load from `activeSceneId` and the
  active encounter, so it cannot go stale.
- A DM-written recap (`campaigns.recap`, migration `0006`), debounced like the
  sheet. Players read it; only the DM edits it.

An auto-summary of chat was considered and rejected: it reads back the dice, not
the story.

### 5. Back button from a character sheet — DONE
Whoever links to a sheet now says where "here" was, via router state
(`{ path, label }`); the sheet reads it and falls back to `/characters` when
opened cold in a new tab or from a bookmark. The party panel at the table passes
"Back to the table".

### 6. Rename scenes — DONE
`SceneName`: an inline field in the scene list, committed on blur or Enter,
Escape reverts. The server already accepted `name` on `PATCH /api/scenes/:id`,
so this was UI only. Optimistic, then reconciled by the list reload.

### 7. Actions must not move the screen — DONE
Root cause was `sheet.load()` flipping `loading` true on every refetch, which
swapped the whole page for a `<Spinner />` — unmounting it throws the scroll
position away. `loading` now means "there is nothing to show yet", so a refresh
after a rest leaves the page in place.

Separately, `Button` now defaults to `type="button"`. A bare button inside a
form submits it, which reloads the page; submitting has to be asked for. Every
existing submit button was already explicit, so nothing changed behaviourally.

### 8. Pings draw a line in the character's colour — DONE
Alt-**drag** now leaves a stroke that fades on its own; alt-click still leaves
the ring. Never persisted — a ping is a gesture, not an annotation — and it
lives 5s as a stroke against 2.5s as a dot, because a line is meant to be read
rather than just noticed.

Colour comes from `actorColor()` in `packages/shared/src/colors.ts`, derived
from the character id rather than stored, so every character has one and client
and server agree without a round trip. The client sends its `actorId` as a
*claim*; the server checks the sender actually controls that character before
deriving the colour, so nobody can point in someone else's name. The DM gets one
fixed colour, since they speak as the table. This replaced `colorForUser`, which
keyed on the person rather than the character.

**DM toggle:** `scenes.playerDrawing` (migration `0007`), on by default,
switchable from the Vision panel. It gates both player pings and player
drawings, and is **enforced on the server** — the client also hides the gesture,
but only to avoid a dead click.

One trap worth remembering: the Konva stage is draggable, and a dragging stage
swallows the mousemoves a stroke is made of. Without cancelling the pan in
`onDragStart`, an alt-drag produced a stub near the release point instead of the
line that was drawn. The same fix pass moved both stroke handlers to functional
state updates, since mouse moves outrun React's re-renders.

### 9. Roll cards show the dice, then the values — DONE
`2d6` now reads as the expression, then `6 + 4`, then `10`. The library's own
`output` line is kept underneath because it is the only thing that explains a
dropped or exploded die — `4d6dl1` shows all four dice above and
`[4, 5, 6, 1d] = 15` below, where the `d` marks the one that was dropped.

---

## Character sheet

> Numbered 4-7 as given; items 1-3 were not in this list.

### 4. "What is the number between class and background?" — ANSWERED, DONE
It was the **character level** — an `<input type="number">` with only an
`aria-label`, so it rendered as a naked box with nothing saying what it was. It
now carries a visible "Level" prefix. The same row still hides a "Level up to N"
button that appears once XP has earned it.

### 5. "Roll ability scores (4d6dl1)" — DONE
- Renamed to **Roll Ability Scores**; `4d6dl1` (4d6, drop the lowest) moved to
  the tooltip where it belongs.
- **Why it did nothing:** it called `useTable.getState().roll(...)`, which emits
  on the table socket. The sheet page never connects one, so the emit went
  nowhere and failed silently — it would have worked at the table and nowhere
  else.

*Shipped:* `POST /api/actors/:id/roll-abilities`. The server still rolls, still
posts each result to the chat of every campaign the character belongs to — the
point was always that the table can see the scores were genuinely rolled — and
*also* returns them, so a character with no campaign yet still sees its numbers.
The sheet shows the six results with an "Apply to sheet" button rather than
making anyone retype them.

### 6. Dropdowns for spells / inventory / attacks — DONE
`CompendiumPicker` already listed the first 60 rows on open, so the missing
half was narrowing, not browsing: no class, school or category filter, and a
hard 60-row cap with 204 wizard spells behind it.

*Shipped:*

- **Filters.** Spells gain class and school alongside level; equipment gains a
  category. The seven categories are curated rather than taken from the SRD's
  own strings, which are inconsistent by source — the same shelf is "Weapon"
  and "Weapons", "Ring" and "Rings". `categoryFilter` in `routes/items.ts` maps
  each one, matching at word starts: a bare `%ring%` files every piece of
  *adventuring* gear in the magic ring drawer, which a test caught.
- **Load more**, via `offset`; the server reports `more` so the button
  disappears at the end rather than fetching an empty page.
- **Per-panel entry points.** Attacks opens on weapons, Spells on spells,
  Inventory on everything.
- **"Not in the list — add your own"**, a form per item type built from the Zod
  `system` schemas. A hand-made Longsword +1 renders `+4 | 1d8+1 slashing` in
  the attack table, which is the check that the blob is real rather than a name
  in a box.

*Also fixed on the way past,* because a class dropdown makes them reachable:
`hitDiceTotal` and `spellcastingAbility` had no UI at all, so every character
short-rested on the schema default of `1d8` and no caster ever saw a spell save
DC. Picking a known class now fills both, and `alignment` — on the actor since
phase 1, never once editable — got a control.

### 7. Short/long rest scrolls to the top — DONE
Same root cause and same fix as Table item 7.

---

## Later: Online mode and Local mode

A direction, not a task yet.

- **Online** — what exists today: accounts, join codes, per-player sockets,
  server-side vision and redaction.
- **Local** — one machine, DM-driven, for playing in the same room. Players get
  a reduced surface. Worth deciding early *what a player is* in local mode: a
  second browser on the same LAN, a phone, or nothing at all (DM drives
  everything on a shared screen). That answer decides how much of the auth and
  socket layer local mode can skip.

The server-side secrecy invariants get *easier* in local mode, not harder — but
only if "local" never means "trust the client". If local mode ends up sending
walls to a player device on the LAN, it has given up the one thing the
architecture was built around.

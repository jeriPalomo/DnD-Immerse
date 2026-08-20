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

**A whisper recipient is validated, and players must be adjacent.**
`whisperToUserId` was never checked at all: it went straight to
`io.to(userRoom(id))`, and every socket joins its own personal room on connect
regardless of campaign, so a member could whisper any user id on the server —
including someone in a different game. `mayWhisper` now requires campaign
membership, exempts the DM in both directions, and otherwise requires
`tokenDistance(mine, theirs) <= 1` on the active scene. The refusal is
deliberately vague, because "they are four squares away" is itself a position
leak. The dropdown greys unreachable names rather than dropping them, and reads
the tokens the client was sent — so someone out of sight reads as out of range,
which is the safe direction to be wrong in.

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

**`active_effects` is the only store for conditions, and both sides fold it
with the same function.** Conditions used to be a JSON array on the token that
only the browser understood, while the richer table with durations sat with no
insert path at all — so a paralyzed token's HUD read Speed 0 while the server
offered it a full 30 ft of movement range, three inches away on the same
screen. `deriveToken` now lives in `packages/shared` and is called by the HUD,
by `speedOf`, by the vision sweep and by the attack roll. `WireToken.conditions`
is derived from the rows at payload time. A condition row carries an empty
`changes` and names the condition in `statusId`, whose mechanics are looked up
from `CONDITION_EFFECTS` when it is read — copying them into the row would
freeze them, so fixing what "prone" does would apply only to tokens that went
prone afterwards.

**Durations are rounds, and rounds only advance in a fight.** Nothing ticks
outside combat; the DM removes by hand, and `effect:apply` says so in the log
rather than silently dropping a timer it cannot count. A `turns`/`startTurn`
pair was declared and read by nothing, and is gone. `roundsRemaining` is
computed against the encounter's current round rather than counted down in a
column, so rewinding a turn cannot leave it wrong.

**Blindness is enforced where vision is computed.** `flags.blinded` (from
`blinded`, `unconscious`, `petrified`) collapses `sightRadiusFeet` to 0, which
`combinedVisibility` drops entirely — no polygon, so no fog opens and no token
is revealed. `visibleTokens` still returns the tokens you control, and
`FogLayer` punches their squares clear, so a blinded player keeps their own
token and the remembered ground rather than an unbroken black rectangle. A
client-side blur would be a devtools inspection away from the room anyway.

**A curated table is checked against the data, not against itself.**
`SPELL_CONDITIONS` is hand-written, and its unit tests looked its own keys up by
themselves — which proves the lookup works and nothing about whether a key
matches anything real. That is how `tasha's hideous laughter` sat there matching
no compendium row for a whole commit: the SRD publishes it as plain "Hideous
Laughter", stripping the wizard's name as it does from every spell that carries
one. `auditSpellConditions` runs inside `npm run srd:import`, the one moment the
whole spell list is in hand, and compares all four hand-entered facts against
the compendium: the saving throw, the duration in rounds, whether it needs
concentration, and whether the spell's own text so much as mentions the
condition being applied. That last one is a smell test, not a parser — deciding
what a spell does from its prose is wrong in both directions, but a condition
the text never names is worth a look. **Every entry must exist in the
compendium**: one that does not can never fire from it and cannot be checked by
anything this project has, which is why Ensnaring Strike, Ray of Sickness and
Blinding Smite were removed rather than kept as declared gaps. A hand-entered
spell of that name sets `appliesConditions` on the item, which is visible where
a name-keyed rule is not.

**A spell save is rolled by the target, against the caster's DC, and the DC is
computed once.** `cardAction` rolled the *caster's* own save with the caster's
proficiency against the caster's own DC — the wrong creature and the wrong
number, on every spell ever cast from a card. `saveProfileFor` now answers both
"which save" and "what DC" for the card and for the roll, because two
computations of one number end with a card reading DC 15 while the server
compares against 10. It offers the button for **any** item that forces a save,
from its own `save` blob *or* from the condition it inflicts: a weapon has no
blob at all, and the SRD ships Web and Sleet Storm with no `dc` block, so both
were unreachable while the check was `item.type === 'spell' && s.save`. `SPELL_CONDITIONS` in `rules5e.ts` is a curated, unit-tested
map of which SRD spells inflict what; hand-entered items carry their own
`appliesConditions`. Spells with no save, a non-condition effect or staged
saves are deliberately absent — an omission means the DM applies it by hand,
which is merely the old behaviour, where a wrong entry makes the app
confidently wrong.

**Advantage from conditions is recomputed on the server.** The target panel
worked it out correctly, printed "Attacks at advantage — target is prone", and
then the roll went out straight because the mode never travelled with the card.
`combineRollModes` folds the server's condition-derived mode together with the
player's own circumstantial call (long range, or the manual toggle); 5e cancels
rather than stacks, so one disadvantage beats any number of advantages.

**A change that alters sight pushes the whole scene, not one token.**
`token:update` re-emitted only the token that changed, so blinding somebody — or
editing their `visionRange` — never recomputed their polygon, and the change did
not land until an unrelated event happened to push a full scene state.

**AoE outlines and target lists come from the same geometry.** `templateCovers`
decides both what is drawn and who is caught, so they cannot disagree.

**A stamped monster's numbers are copied, not recomputed.** `from-monster` used
to create the actor and nothing else, so a goblin arrived with an empty attack
table and the DM rolled its scimitar by hand off a stat block the app would not
show them. `itemsFromMonster` now stamps its actions as items — but a monster's
`+4 to hit` includes proficiency its stat line never states, so it is not
derivable from the sheet. `attackExpression` adds the actor's ability modifier
and proficiency, so the item cancels both: proficiency off, ability STR, and
`attackBonus` carrying the remainder. The same trick on `damageBonus` lets the
published `damage_dice` — which already includes its flat bonus, `1d6+2` —
stand exactly as written, and a critical still doubles only the dice. Melee
reach is filed as `ranged`, never `touch`, because `reachOf` clamps touch to
5 ft and would quietly halve an Adult Red Dragon's bite.

**An action the SRD did not publish numbers for becomes a feature, not an
attack.** Multiattack has no attack bonus, and a breath weapon has a *published*
DC that `saveProfileFor` would recompute from the NPC's own sheet — offering
that button means comparing against a confidently wrong number. Both are
features carrying their full prose, so the DM reads "DC 21 Dexterity" and calls
it. That is the old behaviour, which is merely manual; the alternative is the
app being sure and wrong.

**Bestiary art is compendium content, not an upload.** The SRD records carry a
host-relative `image` for all 337 monsters, and it sat unread in the `data`
blob for the life of the project — no column, no download, no `<img>` anywhere
in the client. `srd:import` now caches them under `data/srd/images/` and serves
them from `/srd-images/`, deliberately *not* `/uploads/`: one file is shared by
every NPC stamped from that monster, and `deleteUpload` ignores any URL that
does not start with `/uploads/`, so deleting one goblin cannot take the goblin
picture away from the other four. They are re-derivable by re-running the
import, which is why `npm run backup` does not copy them. A download failure
is never fatal — art is a nicety, and an import that dies halfway because a
third-party host was down leaves no compendium at all.

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

**A conditional-only `set` needs an empty guard.** `db.update().set({})` throws
"No values to set", so a patch handler whose every field is optional dies on a
payload of just an id. `wall:update` had this, then `effect:update` and
`PATCH /api/items/:id` had it again — three times is a pattern, not an
accident. If every spread in a `set` is conditional, return early when nothing
was sent.

**No dead code.** Two audits found helpers that were written, tested, and never
called — `movementBlocked` let players walk through walls, `deriveActor` made
conditions decorative. Before adding a feature, check that the last one is
actually reachable: `grep` the export and see whether anything outside its own
module and tests uses it.

**Class and species facts live in `rules5e.ts`, never in the UI.** `CLASSES`
carries hit die, casting ability, the two saving throws and the caster
progression; `SPECIES_BONUSES` carries ability increases. Every one is unit
tested against the handbook, because a wrong pair here is invisible — it just
makes every save that character rolls quietly wrong for the rest of the
campaign. Subraces and the Half-Elf's free +1s are deliberately absent rather
than guessed.

**Species bonuses are shown, never applied.** The handbook expects the score
written on the sheet to already include them, so adding them again would
double-count. The green chip is a reminder of what the species grants.

**One log, two views.** Chat and the battle log are the same `chat_messages`
rows filtered on a `combat` flag set at write time by the handlers that produce
combat events — never derived from the message text, which would break the first
time a label was reworded. Clearing takes both, and the confirm says so.

**Konva bubbles drag events.** A token's `dragend` reaches the Stage, so the
Stage's own drag handler must check `e.target === e.target.getStage()` the way
its click handler does — unguarded, dropping a token wrote the token's pixel
position into the map's pan origin and the scene jumped. A token that is not
draggable also has to stop its mousedown, or the Stage starts panning under a
player trying to move someone else's token.

**A player may damage monsters, never characters.** `damage:apply` is open to
members, but `isFairGame` refuses any token that is owned or linked to a
`character` actor, and healing stays the DM's. Rolling damage and then asking
the DM to retype it is the step this removes; deciding whose hit points move is
not.

**Every compendium shelf pages the same way.** `limit`, `offset` and a `more`
flag, with the client sending an explicit `limit` and appending pages. Monsters
were the shelf this was never applied to: the browser sent no limit, took the
server's default of 60 out of 337, and had no `more` to tell it there was
anything else — which reads as a bestiary that stops at C. Add a shelf, page it.

**Compendium categories are curated, not taken from the data.** The SRD's own
`category` strings are inconsistent by source — "Weapon" and "Weapons", "Ring"
and "Rings" — so `categoryFilter` maps seven browsable shelves onto them, and
matches at word starts. A bare `%ring%` files every piece of *adventuring* gear
in the magic ring drawer.

**A potion is a consumable, and consumables carry dice.** Everything imported
arrived as `weapon` or `equipment`, so a potion could never hold the healing an
item card needs - `buildCard` offers those buttons only to a consumable - and
posting one produced a card with a name and nothing to press. All forty potions
in 5.1 declare their own category, so they import as consumables now.
`POTION_HEALING` is curated and keyed by **compendium id, never by name**: 5.1
carries two items called "Potion of Healing", the common 2d4+2 flask and a
generic entry that only points at the rarity table, and keying by name stamped
one potion's dice onto the other. `auditPotionHealing` runs inside
`srd:import`, and its smell test earned its keep immediately by catching that
the 2024 dataset letter-spaces its prose ("H i t   P o i n t").

**A heal rolls and posts; it never applies.** Exactly as damage already
behaves, so "healing stays the DM's" needs no exception - whose hit points move
is still a separate click.

**A hand-entered item fills the same `system` blob an imported one does.** The
manual form's fields are the ones the attack table and target panel read, not a
name and a description; anything left blank falls back to the Zod schema's
default on the server. An item you cannot swing is decorative.

**Enemy hit points are redacted from players in the tracker.** Knowing the boss
is on 7 HP changes how a table plays; that is the DM's to reveal. This is
*separate* from whether players may read a stat block, and stays true whatever
that setting says — see below.

**The enemy-stats grant covers creatures, never a character sheet.** A player
character is not an enemy, and `mayReadStats` reads "not yours" as "theirs to
show" — so the stat block route handed another player's ability scores *and
their whole inventory* to anyone at the table, while the roster three lines away
correctly showed them at name level. Sheets are governed by `getActorAccess`
everywhere else, and this route defers to it for `character` actors: observer or
better, or 403. A second gate on the same data is a second chance to disagree
with the first.

**What a creature is, and how close it is to dying, are two decisions.**
`campaigns.playersSeeEnemyStats` (default **on**) lets players read the stat
block of a creature they do not control — abilities, speed, actions, CR, and
the conditions it is under; `tokens.statsHidden` closes one creature while the
campaign stays open, for the boss whose tricks are the encounter. The override
is only ever restrictive, so there is one direction to reason about. **Neither
ever widens hit points**, which stay behind `showHp` in every payload and are
stripped from the stat block response in all three of its branches. `statsHidden`
is sent to players as `false` whatever it really is: telling them the DM closed
*this* creature marks it as the interesting one, which is most of what closing
it withheld. `mayReadStats` in `realtime/scene.ts` answers this for both the
token payload and the route, because a button that appears and an answer that
refuses is worse than neither.

**Only a DM creates campaign content.** `POST /api/actors` accepted
`type: 'npc'` from anyone for the life of the project — the one creation path
left open, while `token:create`, every scene route and `from-monster` were all
gated. It now requires a `campaignId` and passes it through `requireDM`, and
refuses rather than quietly downgrading to a character. Players still create
and edit their own sheets, items and spells: that is theirs, not the
campaign's. The NPCs nav entry is gated on `dmOfAny` from `/api/auth/me`, which
offers surfaces and authorises nothing — the absence of a button was never a
permission, which is exactly how this hole survived unnoticed.

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

**A secret door is wall geometry, not a door.** `SECRET_DOOR` walls are
withheld from players for exactly the reason walls are — knowing there is a way
through the library's north wall *is* the discovery. Revealing one sets it to
`DOOR`, at which point it is an ordinary door the party can see and open. The
constants exist because `door: 2` sat as a bare integer described only in a
comment, and went unread long enough that secret doors were being drawn, sent
and clicked like any other.

**Blocked ground stops you crossing it, not only standing on it.** The commit
check tested the destination footprint alone, so a player could drag clean over
a chasm and land on the far side - while the movement overlay, which is a flood
fill, had already refused to route through it. The two disagreed, and the
overlay was right. `pathBlocked` samples the segment at quarter-square steps,
the same approximation walls make by testing centre to centre. **The square the
creature starts on is skipped**: a DM may place a token on blocked ground or
paint under one already standing there, and neither should strand it.

**Painted ground is a map of the dungeon, and never leaves the DM room.** A
pillar is four wall segments and drawing it that way is fine; a lake or a
cave's ragged edge is not. `scene_terrain` holds two bitmaps per scene —
blocked and difficult — and is a table rather than columns on `scenes`
deliberately: scene rows are projected to players by `toWireScene`, and keeping
terrain out of the projected row is harder to get wrong than remembering not to
include it. Players feel it exactly as they feel walls: a movement overlay that
stops at it and a refused drag, both decided on the server. A square is never
both blocked and difficult — painting one clears the other, or a ford would
stay impassable underneath for reasons nothing on screen explains.

**Difficult ground made the movement flood fill a weighted search.** It was a
breadth-first search on the stated grounds that "every step costs the same, so
the first time a square is reached is also the cheapest way to reach it", and
that stops being true at two squares per step: a route through rubble may be
beaten later by going round, and a plain queue records the dearer one and stops
short. Costs are only 1 or 2, so a bucket per cost is enough. `footprintBlocked`
is shared by the overlay and by `token:commit`, so what the overlay promises and
what the server allows are one answer — and it tests the whole footprint,
because half an ogre in the chasm is still in the chasm.

**Walls block sight and movement independently.** `blocksSight` and
`blocksMovement` are separate flags, so a railing can be seen over but not
crossed and a curtain the reverse. Collision is enforced on `token:commit` for
players; the DM can place anything anywhere.

**The DM owns the fog as well as the vision sweep.** Exploration used to be
written only by walking, so there was no way to open a door dramatically and no
way to reuse a map. `fog:reveal` writes a fully explored bitmap for every
campaign member at the scene's current grid; `fog:reset` deletes the scene's
rows so the next sweep starts from nothing. Both are DM-only, both resolve the
scene through the campaign rather than trusting the id, and both end in
`broadcastSceneState` — a change that alters sight pushes the whole scene.
`revealAll` sets cells rather than filling the byte array, because the last byte
holds spare bits past the final square and filling it would report ground off
the edge of the map. Reveal changes what is *remembered*, never what is sent:
wall geometry still never reaches a player.

**`npm run playtest` opens the table as both a DM and a player.** The player's
half cannot be checked from the DM's chair — a stat block route that handed one
player another's inventory, and monster attacks the DM could not reach, both
survived precisely because nobody logged in as a player. The script builds,
seeds a throwaway database under the system temp directory, starts the server
and opens two windows in separate browser contexts, since one context is one
cookie jar and one person. It never opens `data/`.

**Fog is a bitmap, not accumulated polygons.** One bit per grid square per
player, base64 in `fog_exploration`. Unioning polygons grows without bound; a
100×100 scene is 1.25 KB and merges with a bitwise OR.

**A fog bitmap only means anything at the grid it was written for.** Bits are
indexed `y * width + x`, so decoding at another width shifts every row: a tidy
explored room comes back smeared diagonally across the board, ground the player
never walked drawn as remembered. `fog_exploration` stores `gridWidth` and
`gridHeight` for exactly this check and nothing read them for a year;
`fogForGrid` does, and drops the memory when the grid has moved. Re-exploring
costs a walk, where trusting a scrambled bitmap costs an ambush.

**A footprint is sampled across the space it occupies.** `tokensInTemplate`
stepped in whole squares from a token's corner, which is right for every size
except Tiny — half a square, so a fixed `+0.5` tested the corner *outside* the
creature. Every Tiny monster in the bestiary is one, and it flips the answer at
the edge of a fireball in both directions. `tokenCenter` already did this
correctly with `w / 2`, which is why vision was unaffected.

**Token drag never touches the database.** `token:move` streams position at
~30Hz and is rebroadcast without a write; `token:commit` persists once on drop
and applies the authoritative snap. A rejected move rebroadcasts the real
position so the client corrects rather than sitting desynced.

**Characters and NPCs are two pages, split on `type`.** Sheets you rolled up
and the cast a campaign accumulates are different jobs — play and prep — that
happen to share a table: one goblin per encounter buries the four characters
you actually play. They were briefly two tabs on one page, which still read as
one thing. The split is on `type`, never on campaign assignment — an unassigned
NPC is still an NPC, and a character is yours whether or not it is currently at
a table. `ActorCard` and `useRoster` in `components/roster.tsx` are shared by
both pages, because the card is identical and two copies would drift. The NPC
empty state names the bestiary, which lives on the battle map behind Scene →
Tokens, because a DM looking at an empty shelf here has no way to guess where
NPCs come from.

**A hidden scene is filed, not withheld.** `scenes.hidden` shelves a finished or
half-built scene out of the DM's own list; it hides nothing from players, who
have never been able to list scenes at all — `routes/scenes.ts` is `requireDM`
and they only ever receive the active one. Hiding the live scene is therefore
allowed and does not end it: what the party is looking at is
`campaigns.activeSceneId`, which the flag does not touch, and the row keeps its
Live badge inside the hidden section so it cannot be lost track of. The flag
rides on the DM-only list payload, never on `WireScene`, for the same reason
`sortOrder` does.

**NPCs are absent from a player's roster, not redacted.** A row reading
"Ancient Red Dragon — sheet not shared" spoils the encounter just as thoroughly
as the stat block would. The name is the leak.

**Campaign settings are the DM's, and live behind the gear.** Anything about
the campaign itself — name, description, ruleset, banner, invite code, who is
in it, deleting it — is edited in `CampaignSettings` and gated `requireDM` on
the server. The campaign page is a read-only overview. Players edit only what
is theirs: their own tokens, their own sheets. When adding a campaign-level
control, it goes in the panel, not on the page.

**There are two sources of DM truth on the server**, and they are not enforced
to agree: `campaignMembers.role === 'dm'` (what `requireDM` reads) and
`campaigns.dmUserId` (what `getActorAccess` reads). Both are written at
creation and nothing reassigns either, so they cannot currently diverge — but
anything that transfers a campaign has to write both.

**A refused move asks whether there is a way round, not whether the straight
line is clear.** `token:commit` tested one segment from centre to centre against
walls and painted ground, so dragging a token round a corner or along the shore
of a lake traced a line that clipped the thing being avoided and the move was
refused - while the movement overlay, which is a flood fill, had been drawing
those very squares as reachable. `routeExists` runs only when the straight line
*is* blocked, so the common drop costs nothing, and it walks the grid the way
the overlay does. It asks "could you get there at all", never "how far is it":
out of combat nothing spends movement, and occupancy is ignored because a
creature ringed by its own party would otherwise be unable to move. It is
bounded - a few times the direct distance, and a fixed number of squares - so a
legal but enormous detour is refused and dragged in two hops instead, because
this runs on every drop and an unbounded search is a way to make one handler
walk the whole map. Walls are culled to the searched region first, for the
reason the vision sweep culls. **One refusal covers both**: telling a player
"a wall" rather than "no footing" hands them the wall's position without their
ever having seen it.

**Ground is painted as a kind, and the cost is looked up from it.** `blocked`,
`mud` (double, the handbook's difficult terrain) and `water` (half again, a
house rule - a ford that cost the same as a bog would make the two brushes one
brush). One bitmap per kind, never a cost per square: storing the number freezes
it, the mistake `active_effects` avoids by naming a condition rather than
copying its mechanics. **Movement is counted in half squares**, because one and
a half is not expressible in whole ones and a search that rounded it would make
a ford either free or a marsh; `reachableSquares` converts its budget once, and
every cost below that line is in the same unit. A 30 ft creature therefore gets
six squares of floor, four of water, three of mud.

**A Konva stage is not mounted until its container has been measured.** Konva
draws each layer by handing its canvas to `drawImage`, and a canvas of zero
width throws `InvalidStateError` — which it did on every board mount, because
`size` starts at zero and the ResizeObserver fills it in a frame later. A
console full of an error that has nothing to do with the bug you are chasing is
how the next bug gets missed.

**A tool that is not a wall must not lay wall points.** The board's click
handler read `wallTool !== 'off'`, so every brush dropped a wall corner as well
as doing its own job - a paint stroke ends in a click, and the stroke after it
joined the two into a real wall. Two walls appeared on a scene where nothing but
ground had been painted. The wall branch names its three tools.

**A movement range is clipped to explored ground only when there is a view to
clip against.** `computePlayerView` returns null on a scene with dynamic vision
off, and the clip filtered against `view?.vision.explored ?? []` - an empty set,
which threw the entire range away. `visionEnabled` defaults to false, so on an
ordinary scene a player selected their token and saw no overlay at all, and the
feature looked like it had never been built. Nothing is hidden on such a scene,
so there is nothing to clip and nothing to leak.

**"No polygons" means blind, and only a scene with vision on can say it.**
`visibleTokens` reads an empty polygon list as "sees nothing but its own
tokens", which is right for a blinded player and wrong for a scene with dynamic
vision switched off — where `computePlayerView` returns null and nothing is
hidden from anyone. `movement:query` passed `view?.polygons ?? []` and so
handed a player only their own tokens: the threat overlay had no enemies to
union and came back empty on every ordinary scene, and a range routed straight
through creatures it should have gone round. `broadcastSceneState` had it right
already — `view ? visibleTokens(...) : permitted` — and the two now match. This
is the same conflation that emptied the movement overlay, one function along.

**A reach is a speed, so a closed stat block hides it.** `movement:query`
answered for any token the asker could see, which let a player read the speed of
a creature whose stat block the DM had closed by asking for its range instead —
a second gate on the same data, disagreeing with the first. It calls
`mayReadStats`, the function the payload gate and the stat block route already
share. **The threat union is deliberately not gated**: it covers hostiles only,
it is a union rather than one creature's answer, and offering it is the whole
point of the overlay.

**Reachability is computed on the server, for the same reason vision is.**
Players never receive wall geometry, so a browser cannot know what stops a
step. `movement:query` answers the asking socket alone, and a player's threat
range is clipped to ground they have explored — a goblin's reach spilling round
a corner would otherwise be a free map of the corridor.

**An overlay leaks by its holes as well as its shape.** Movement occupancy is
taken from the tokens the viewer can see, never from every token on the scene:
a hidden ambusher used as a blocker punches a creature-shaped gap in a player's
range and gives itself away. Accuracy loses to secrecy here — a range may cross
a square that turns out to be occupied, and `token:commit` rejects the move
anyway.

**`disposition` is what tells friend from foe, and `ownerUserId` is not.** Blue
for the party, green for neutral — allies and allies-for-now, never counted as
a threat — red for hostile. They are separate signals on purpose:
`ownerUserId` decides HP redaction, so a friendly NPC the DM runs is green on
the board and still has its hit points hidden. Do not conflate them.

**A read is scoped by its query, not by a filter afterwards.** The journal's
page fetch had no `where` clause at all: it read every page in the database and
leaned on a JavaScript filter to keep campaigns apart. Nothing leaked, because
the filter was right — but a query that returns other people's rows and trusts
the next ten lines to drop them is one edit away from being the leak, and it
grows with the whole database rather than the request.

**The acting creature is the one you selected, and a DM plays no character by
default.** `myActor` was "the first actor you own, ordered by name" — and a DM
owns every NPC they create, so they acted as whichever monster sorted first.
That decided the attacks offered in the target panel, the token range was
measured from, and the `actorId` stamped on their chat messages. It also made
the monster attacks stamped by `from-monster` unreachable: with a goblin
selected the panel read "No weapons or spells on this sheet", because it was
looking at the Ancient Red Dragon. `mine` now requires `type === 'character'`,
and a DM's acting creature follows their selection — the only answer that can
be right when they run every monster on the board.

**Repeated creatures are numbered, and never renamed afterwards.**
`nextTokenName` leaves the first "Goblin" alone and calls the next ones
"Goblin 2", "Goblin 3", counting on from the highest already present rather
than the count — killing Goblin 2 must not let the next one reuse the name and
put two of them in the initiative order. Placement loops rather than batching
because each copy has to see the ones before it: `firstFreeSquare` needs the
square its predecessor took, and the numbering needs its number.

**A condition's summary is prose; whether the app enforces it is derived.**
`CONDITION_SUMMARY` is what a person reads, `CONDITION_EFFECTS` is what the
engine applies, and `conditionIsAutomated` reads the second rather than
restating it — so the reference cannot claim automation that is not there. Five
conditions have no mechanical entry (charmed, deafened, exhaustion,
incapacitated, concentrating) because they turn on intent rather than a number,
and the panel says "by hand" for them instead of pretending. Unit tests check
the table against `CONDITIONS` in both directions, because a curated table
checked against itself proves nothing.

**The DM's panel is split by when a tool is used, not by what it is.** Building
a map, calibrating a grid and drawing walls are done alone between sessions;
initiative, damage and dropping a monster in are done with four people
watching. They were interleaved across Combat / Scene / Journal, and placing a
creature sat two clicks inside the prep panel — so adding a goblin mid-fight
meant leaving the initiative order and finding the way back, several times a
session. `RunPanel` now stacks everything used during play, `SceneManager` is
prep only, and the two sit behind one switch that renders **only for the DM**:
a player has no prep tools, so they get the run panel directly with no chrome
above it. Run is stacked rather than tabbed because the fight is the thing you
must never lose sight of; the bulky parts collapse so it keeps the top of the
column.

**The turn bar shows faces, not labels.** Names and initiative live in the
tooltip; the bar itself is portraits. Twelve goblins are twelve identical
pictures, and the answer to that is the ring around the one acting rather than a
row of captions — which is also why the acting creature is drawn larger and at
full opacity while the rest are dimmed. A creature with no art falls back to its
initial, the same placeholder used everywhere else.

**A creature that does not fit the turn bar is hidden, not clipped, and
counted.** A dozen combatants overflow it, and a portrait sliced down the middle
at the edge reads as a rendering fault. Fit is measured with
`getBoundingClientRect`, never `offsetLeft` — offsets are relative to the
nearest *positioned* ancestor, which is not the strip, so comparing them
against its width compares two coordinate spaces and cheerfully reports that
everything fits at any width. The "+N later" counter keeps its space whether or
not it has anything to say: appearing and disappearing would change the strip's
width, which changes how many portraits fit, which changes the counter — a
measurement that argues with itself. Because the order is rotated to the
current turn, a hidden creature slides into view as its turn approaches, which
is the point.

**A ResizeObserver on a conditionally rendered node needs a ref callback.** The
bar renders nothing until a fight starts, so an effect with `[]` dependencies
runs while there is no strip to observe and never attaches — the fit then
recomputed on a turn change but not on a resize.

**The turn bar is rotated, and its height is subtracted from the board's.**
`TurnBar` starts at whoever is acting and reads left to right, so turn order is
reading order; the creature that just acted leaves the front and everyone
shuffles up. Movement is FLIP - measure after the reorder, put each node back
with a transform, release it next frame - which needs `key={entry.id}` to keep
React moving the same DOM nodes rather than rebuilding them. The wrapping
creature *fades* instead of sliding, because a portrait travelling the full
width of the screen reads as a glitch rather than a turn. `prefers-reduced-motion`
skips it entirely. It draws no hit points at all: names and initiative are
already public in the tracker, while a health bar would have needed one shape
for the DM and another for players. **`TURN_BAR_HEIGHT_REM` is exported because
the board's `calc(100vh - 8rem)` has to subtract it while a fight is running** -
that sizing is the load-bearing kind, and a bar above the grid otherwise pushes
a tall map past the bottom of the window.

**`TurnPrompt` folds conditions with `deriveToken`, the same function the
server uses.** A 5e turn is move, one action, usually a bonus action — and
everything hanging off the creature complicates it: an incapacitated creature
acts not at all, a concentrating one loses its spell to damage. The speed shown
must be the speed the server will allow, which is why it derives rather than
reads: those two drifted once already, and a paralyzed token read Speed 0 in
the HUD while the server offered it a full 30 ft. Its attack list comes from the
stat block route, which is already permission-checked and already knows how to
answer for a stamped monster, a hand-written NPC or a bare token.

**A player reads their own sheet without leaving the table.** `MySheetDrawer`
is read-only on purpose: editing mid-combat is what the sheet page is for, and
a drawer that can write hit points is one that can lose an edit when a damage
roll arrives over the top of it. Every panel in it is the one the sheet already
uses with `editable` off, so the two cannot describe the same spell
differently. It has a visible button as well as the `C` key — the lesson of the
shortcut panel, which nobody found while it was a keystroke only.

**An NPC's attack rows print no ability chip.** The chip tells a player which
score drives a weapon, which is true for a character and a lie for a stamped
monster: a goblin's shortbow reads STR only because that is what the copied
numbers cancel against. Suppressed on `actor.type === 'npc'` rather than
printing something that looks like a bug.

**A socket handler must never take an id on trust.** Room membership says which
campaigns you are in; it does not say which one an id came from, and
`context()` reports whichever campaign was joined first. Every handler that
takes a client-supplied id looks it up through `tokenIn` / `wallIn` /
`tokensIn` / `templateIn`, which join to `scenes.campaignId` — so an id borrowed
from another table is simply not found. The delete handlers are where this gets
missed: `template:create` and `drawing:create` both checked the scene they were
placed on while their deletes checked nothing, which let a DM of their own game
rub out somebody else's annotation and then broadcast the change to the wrong
table. Without that, "is this socket a DM" was being
answered about the wrong game.

**A throwing handler must not be able to end the session.** Every handler
starts with `schema.parse`, and socket.io does not await a listener's promise,
so one malformed payload became an unhandled rejection and Node exited — the
whole table dropped because somebody's client sent a stray field.
`guardHandlers` wraps `socket.on` once per connection, which is the point: a
rule enforced at 33 call sites is a rule that will be missed at the 34th.

**Hit points are redacted where the row becomes a payload.** `toWireToken`
takes `showHp`, false for anything the party does not own. The initiative
tracker used to redact carefully while the board tooltip, the token HUD and the
target panel all read `hp` straight off the wire — one hover and the boss's 7 HP
was public. Redacting in one place is the only way it stays redacted.

**A socket acts in the campaign it last joined.** Handlers used to read "the
first room in the map", which is arbitrary: a socket joined to two campaigns
acted in whichever it entered first rather than the one the player is looking
at. `socket.data.activeCampaignId` is set on join and falls back on leave, and
all four `context()` copies read it. The official client closes its socket when
the campaign changes, so this was unreachable through the UI — but room
membership authenticates and does not authorize, which is the whole reason ids
are scoped.

**Circumstantial modifiers are measured when the button is pressed.** Long range
was computed by the client and sent with the card, so the disadvantage froze at
posting time — step into melee before pressing Attack and the roll still carried
it. `longRangeShot` measures from where the two tokens actually are, and joins
the condition-derived mode through `combineRollModes`. The card carries no range
hint at all now; the mode select is the player's own call and nothing else.

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
drives an installed browser — no download needed. **This machine has Edge, not
Chrome**, so use `channel: 'msedge'`; `channel: 'chrome'` fails with "Chromium
distribution 'chrome' is not found". Screenshot the page and look at it; a
sheet that renders is not the same as a sheet whose numbers are right. Drive a
throwaway `DATA_DIR`, never `data/app.db` — and restart the server after a
client rebuild, because `serveClient` reads `index.html` once at boot and will
otherwise serve one pointing at deleted asset hashes.

**An empty compendium is not a code bug.** `srd_monsters`, `srd_spells` and
`srd_items` are empty until `npm run srd:import` runs, and `data/srd/` being
empty is the tell that it never has. Every browser correctly renders nothing,
which reads as broken search — so their empty states name the command.

**`npm run backup` exists and should be run before sessions.** This machine
holds the only copy of a campaign. The snapshot uses `VACUUM INTO` rather than
a file copy, because copying a live SQLite file can capture a torn write — the
result looks fine until the day you need it.

**`data/` does not sync between machines.** The desktop is the server of record
and holds the real campaign database; other machines keep throwaway local data.
Never sync a live SQLite file between two running servers.

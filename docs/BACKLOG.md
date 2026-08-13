# Backlog — post-phase-7 fixes

Raised 2026-08-13 after playing with the finished build. Grouped as they were
given, with the root cause where one has already been found. Tick items off in
the same commit as the work.

Phases 1-7 are done; this is the punch list from actually using the thing.

> **Cross-machine note.** The desktop is the server of record and holds the real
> campaign database. This file is the handoff — `data/` does not sync, but this
> does. Pull before picking anything up.

## Where this stands

**Done** (2026-08-13): everything below except Character sheet 6, which is in
progress. Table 1 was resolved by deleting the audio system rather than
extending it. Migrations `0005`–`0008` are applied on the desktop; run
`npm run db:migrate` after pulling on the laptop.

**Still open:** Character sheet 6, and the Online/Local split at the bottom,
which is deferred by choice.

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

### 6. Dropdowns for spells / inventory / attacks — OPEN
`CompendiumPicker` already searches the SRD, but only from an "Add spell" /
"Add item" modal — you cannot see what the database *has* without opening it and
typing. Wanted: a browsable dropdown per panel, and when the thing genuinely is
not in the SRD, an "add it manually" path. Note the SRD gap — the 2024 dataset
publishes no spells and only three monsters, so a 2024 campaign is drawing from
the 2014 list and manual entry matters more than it looks.

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

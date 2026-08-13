# Backlog — post-phase-7 fixes

Raised 2026-08-13 after playing with the finished build. Grouped as they were
given, with the root cause where one has already been found. Tick items off in
the same commit as the work.

Phases 1-7 are done; this is the punch list from actually using the thing.

> **Cross-machine note.** The desktop is the server of record and holds the real
> campaign database. This file is the handoff — `data/` does not sync, but this
> does. Pull before picking anything up.

---

## Table

### 1. Ambient audio from YouTube links — *needs a decision*
Today a track is an uploaded file (`POST /api/playlists/:id/tracks`, a URL on
disk). The wish is to paste a YouTube link instead.

Workable, and it keeps the **synced by timestamp, never streamed** invariant —
every client loads its own IFrame player and seeks to the same offset, exactly
as the `<audio>` element does now. What changes:

- A track needs a `source` discriminator (`upload` | `youtube`) and a video id.
- Playback goes through the YouTube IFrame API instead of an `Audio` element.
  `setVolume(0-100)` still exists, so **positional volume and the server's
  per-listener `occlusion` multiplier keep working** — that invariant survives.
- Autoplay: the API needs a user gesture before the first `playVideo()`. There
  is already an "unmute" style gate at the table; it has to cover this too.
- No Web Audio graph over an iframe, so any future crossfade/filter work on
  YouTube tracks is off the table. Uploads keep theirs.
- `deleteOrphanedUploads` must skip YouTube tracks — there is no file to orphan.

Open question for the DM: **replace uploads, or add alongside them?** Adding
alongside is the recommendation — the mixed model costs one discriminator and
keeps offline sessions working when the wifi at the table is bad.

### 2. Journal "show" button does not work — *root cause found*
Two separate faults, both real:

1. **Solo campaigns silently no-op.** `POST /api/journal/:id/share`
   ([journal.ts:225](../apps/server/src/routes/journal.ts#L225)) loops over
   campaign members and `continue`s past the DM. With no players joined yet it
   writes zero `ownership` rows. The GET then derives `shared` from "does any
   grant row exist" ([journal.ts:58](../apps/server/src/routes/journal.ts#L58)),
   so the reload reports `shared: false` and the optimistic "shown" pill snaps
   back to "show". Looks broken because it *is* a no-op.
   *Fix:* persist sharedness on the entry itself (a `shared` column) rather than
   inferring it from grants, and keep the grants as the per-user filter.
2. **No live push to players.** Sharing writes rows but emits no socket event,
   and `JournalPanel` only loads on mount. A player already at the table sees
   nothing until they reload — so the DM presses show, the table says "I don't
   see it", and the button gets blamed.
   *Fix:* emit a journal event to the campaign room on share; panel re-fetches.

### 3. Dice: a count + type picker, not seven buttons
Replace the `QUICK_DICE` row ([ChatPanel.tsx:88](../apps/web/src/components/ChatPanel.tsx#L88))
with a number input and a die-type select, plus an optional modifier. Build the
expression client-side with the existing helpers and send it through
`roll()` — the server still does the actual rolling. `validateExpression`
already caps count at 100 and sides at 1000, so bound the number input to match
rather than inventing a second limit.

### 4. "Coming next" card → last session recap + where the map left off
The card at [CampaignDetail.tsx:174](../apps/web/src/pages/CampaignDetail.tsx#L174)
is a stale Phase-3 placeholder promising a battle map that shipped in phases
4-5. Every campaign page currently tells the DM a delivered feature is pending.

Replace with a "Last session" card:
- **Where the map left off** — active scene name, thumbnail, and whether an
  initiative order is still open (an unfinished combat is the single most useful
  thing to see before a session).
- **Recap** — a DM-written field is the reliable half; an auto-summary of recent
  chat is a nice-to-have on top. Default plan: DM-editable recap text, with the
  scene/initiative line derived automatically so it is never stale.
- Respect the redaction invariants — no enemy HP, no unrevealed scene names to
  players.

### 5. Back button from a character sheet goes to the wrong place
The sheet's back link is hard-coded to `/characters`
([CharacterSheet.tsx:82](../apps/web/src/pages/CharacterSheet.tsx#L82)). Reached
from a campaign, it should return to the campaign. Use router state (or
`navigate(-1)` with a sane fallback when the sheet was opened cold in a new tab).
Same treatment anywhere else a sheet is linked from the table.

### 6. Rename scenes
**Server already supports it** — `PATCH /api/scenes/:id` accepts `name`
([scenes.ts:82](../apps/server/src/routes/scenes.ts#L82)). Only the UI is
missing: the scene name renders as a plain `<span>`
([SceneManager.tsx:148](../apps/web/src/components/board/SceneManager.tsx#L148)).
Make it an inline editable field like the sheet's identity row. Small.

### 7. Actions must not move the screen
Anchor navigation and re-render are scrolling the page under the user. Sheet nav
uses `href="#…"` anchors ([CharacterSheet.tsx:98](../apps/web/src/pages/CharacterSheet.tsx#L98));
buttons inside forms default to `type="submit"`, which navigates. Audit for
missing `type="button"`, and stop any handler that reloads a panel from
resetting scroll. See also Character sheet item 7 — same bug, same fix.

### 8. Pings draw a line in the character's colour
Today alt-click sends a one-point ping rendered as an expanding circle
([BattleMap.tsx:416](../apps/web/src/components/board/BattleMap.tsx#L416)).
Wanted: alt-**drag** leaves a stroke in that player's character colour that
fades out.

Most of this exists — `DrawingLayer` already renders freehand strokes with a
colour, in grid units. The work is to let a *player* (not just the DM) emit a
short-lived stroke, tag it with their character's colour, and expire it like a
ping rather than persisting it like a drawing.

### 9. Roll cards should show the dice, then the values
Wanted, for `2d6`:

```
2d6
4 + 1
5
```

`RollCard` ([ChatPanel.tsx:193](../apps/web/src/components/ChatPanel.tsx#L193))
already has `expression`, `output` and `total` — this is mostly presentation:
promote the expression to a header line, put the per-die breakdown on its own
line, keep the big total. Check `output`'s exact shape from the server roller
before assuming it splits cleanly.

---

## Character sheet

> Numbered 4-7 as given; items 1-3 were not in this list.

### 4. "What is the number between class and background?" — *answered*
It is the **character level** — a bare `<input type="number">` with only an
`aria-label`, so it renders as a naked number with no visible label
([CharacterSheet.tsx:372-381](../apps/web/src/pages/CharacterSheet.tsx#L372-L381)).
Give it a visible "Level" prefix. The same row hides a "Level up to N" button
that only appears once XP has earned it.

### 5. "Roll ability scores (4d6dl1)" — rename, and it is broken — *root cause found*
- Label: drop the expression, keep the tooltip. `ABILITY_ROLL` is `4d6dl1`
  (roll 4d6, drop lowest) — correct, just unreadable in a button.
- **Why nothing happens:** the handler calls `useTable.getState().roll(...)`,
  which emits on the table socket ([table.ts:315](../apps/web/src/store/table.ts#L315)).
  The character sheet is not the table page and has no socket connected, so the
  emit goes nowhere and fails silently. The comment says it rolls in chat "so the
  table can see the stats were genuinely rolled" — a good intention that only
  works while you are *at* the table.
  *Fix:* roll server-side over HTTP and write the result into the campaign chat
  log, or fall back to showing the six results on the sheet when the character
  belongs to no campaign. Either way it must not depend on a live socket.

### 6. Dropdowns for spells / inventory / attacks, with manual fallback
`CompendiumPicker` already searches the SRD, but only from an "Add spell" /
"Add item" modal — you cannot see what the database *has* without opening it and
typing. Wanted: a browsable dropdown per panel, and when the thing genuinely is
not in the SRD, an "add it manually" path. Note the SRD gap — the 2024 dataset
publishes no spells and only three monsters, so a 2024 campaign is drawing from
the 2014 list and manual entry matters more than it looks.

### 7. Short/long rest scrolls to the top of the page
`RestControl`'s `onRested` calls `sheet.load(actor.id)`
([CharacterSheet.tsx:215](../apps/web/src/pages/CharacterSheet.tsx#L215)), which
flips `sheet.loading` to true. The sheet then returns `<Spinner />`, unmounting
the entire page — so the browser has nothing to hold scroll against and lands at
the top. Same class of bug as Table item 7.
*Fix:* refetch without tearing the page down — keep the last actor rendered
while a refresh is in flight, and reserve the full-page spinner for first load.

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

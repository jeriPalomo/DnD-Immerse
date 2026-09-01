# The rules engine against the 2024 edition

Raised 2026-08-22, after being asked to make the app reflect the 2024 Player's
Handbook and Dungeon Master's Guide.

## What this can and cannot be

The books are WotC copyright. This project is built on the **SRD**, the subset
published under licence, and the codebase already refuses to import text it is
not licensed for — see the subclass note in [CLAUDE.md](../CLAUDE.md), where
authoring by hand is called the only honest fix. Nothing here copies prose out
of a rulebook.

What *is* fair game is the arithmetic. A threshold table, an ability modifier,
whether a species grants +2 — these are facts about a game, not passages of
writing, and the engine either matches them or it does not. This file is the
list of places it does not.

**The dataset is also partial, and that is upstream, not a bug here.** The 2024
SRD publishes Equipment (182 rows, carrying weapon mastery), Features (232),
Levels (287), Species (9), Magic Items and Traits. It publishes **three
monsters and no spells at all**. A 2024 campaign therefore draws its spells and
bestiary from the 2014 list, and will until the upstream data lands.

---

## The headline: the engine never asked which edition it is — FIXED 2026-09-01

`campaigns.ruleset` exists, is set at creation, and decides which compendium
rows are imported. **`packages/shared/src/rules5e.ts` did not read it once.**
Every rule below was 2014, in every campaign, whatever the setting said.

`Ruleset` is now a shared type and the two tables that genuinely differ branch
on it (#1 and #2 below). The route reads the campaign's column and the client
reads the bands back, so no UI hardcodes a difficulty word again.

---

## Divergences, worst first

### 1. Ability score increases come from the wrong place — FIXED 2026-09-01

`speciesBonuses(species, ruleset)` returns `{}` for 2024, and the ability block
says where they come from instead — a 2024 sheet with no green chips otherwise
looks exactly like one whose species was typed wrong. `SPECIES_2024` is a
separate list, so Half-Elf and Half-Orc are absent from a 2024 game and Goliath
and Orc are present; merging the two lists would offer every character a species
their own edition does not have. The original note follows.


`SPECIES_BONUSES` (`rules5e.ts:255`) is the 2014 table — Dragonborn +2 STR/+1
CHA, Human +1 to everything. In 2024 **species grant no ability increases at
all**; the character's *background* grants +2/+1 or three +1s.

`speciesBonuses()` feeds the green chips in
`apps/web/src/components/sheet/Abilities.tsx:42`, so a 2024 character is being
told to add numbers the 2024 rules do not give them. The chips are advisory —
the invariant is that species bonuses are *shown, never applied* — so nothing is
silently miscalculated, but the advice is wrong.

The same table lists **Half-Elf and Half-Orc**, which 2024 does not have.

### 2. Encounter building is the 2014 DMG — FIXED 2026-09-01

`ENCOUNTER_BUDGETS_2024` is the flat per-character budget at low/moderate/high,
and `encounterMultiplier` returns 1 for 2024 — the crowd allowance is already
inside those numbers, so applying it as well counts it twice. `PartyBudget` is
one shape for both editions (an ordered list of named bands) so `howManyFit`
counts rather than knowing which words exist, and asking a 2024 party for a
"deadly" fight returns 0 rather than being quietly mapped onto "high". The
original note follows.


`ENCOUNTER_THRESHOLDS` (`rules5e.ts:841`) is the four-column easy/medium/hard/
deadly table, and `encounterMultiplier` (`:906`) scales the monsters' XP by
their number — ×1.5 for two, ×2 up to six, and so on.

The 2024 DMG replaced both. It gives a flat XP budget per character at three
difficulties (low / moderate / high) and has **no multiplier for the number of
monsters**. So `howManyFit` and the difficulty label are answering a question in
the old edition's terms. This one changes the numbers a DM plans a night
around, which is why it is second on the list rather than last.

### 3. Weapon mastery is imported and inert

The 2024 equipment rows carry a mastery property; `srd/import.ts:474` stores it
and `sheet/Combat.tsx:229` prints it as a chip. Nothing applies it. Vex, Topple,
Sap, Nick, Push, Slow, Graze and Cleave each change what a hit does, and a
player reading the chip on their sheet would reasonably expect the attack card
to know about it.

This is the largest *feature* gap rather than a wrong number, and it needs the
action economy the app deliberately does not have (see the Dash note in
CLAUDE.md), so it wants designing rather than patching.

### 4. There are no feats

`itemTypeSchema` (`documents.ts:97`) has weapon, spell, feature, equipment,
consumable, class, background, race — and no feat. In 2024 every background
grants an origin feat at level 1, and feats are a normal part of levelling.
Today a feat can only be written as a `feature`, which is the honest workaround
but means nothing can reason about one.

### 5. Exhaustion could now be modelled, and is not

`CONDITIONS` (`schemas.ts:186`) includes exhaustion, and `conditionIsAutomated`
correctly reports it as by-hand: the 2014 rule is a six-tier table of prose.
**2024 replaced it with arithmetic** — each level is −2 on d20 tests and −5 ft
of speed. That is exactly the shape `CONDITION_EFFECTS` already folds, so
2024 exhaustion is implementable where 2014's never was.

### 6. Rules the app does not model at all

Named so they are not mistaken for oversights. None of these are wrong today;
they are simply absent, and each needs an action economy the app does not have:

- **Grapple and Shove** — 2024 makes them unarmed-strike options against a save
  DC rather than contested checks.
- **Surprise** — 2024 grants disadvantage on initiative instead of a lost turn.
- **Potions as a Bonus Action** — 2024.
- **Two-weapon fighting** — folded into the Nick mastery in 2024.

---

## What is already edition-correct

Worth recording so nobody re-audits it:

- **XP by challenge rating** is unchanged between editions, and
  `auditXpByCr` already checks `XP_BY_CR` against all 337 published monsters on
  every import.
- **Proficiency bonus by level, ability modifiers, save DCs, death saves,
  concentration DCs** are identical in both editions.
- **Rest structure** — short 1 hour, long 8 hours, half hit dice back — is
  unchanged.
- **`ASI_LEVELS`** is curated and audited against the published data by
  `auditAsiLevels`, and the levels did not move in 2024.

---

## Where this stands

**Done 2026-09-01:** the headline (the engine reads `ruleset`), #1 species
ability increases, and #2 encounter building. Those were the two places the app
put a wrong *number* on screen.

**Still open, in the order worth doing them:**

1. **Exhaustion (#5)** — small, and it turns a by-hand condition into an
   automated one. Needs exhaustion to carry a *level* rather than be a boolean
   condition, which is a schema change, and `CONDITION_EFFECTS` to become
   edition-aware.
2. **Feats (#4)** — an `itemTypeSchema` entry plus somewhere to grant one. The
   honest workaround (writing a feat as a `feature`) still works today.
3. **Weapon mastery (#3)** — the largest, and it needs the action economy the
   app deliberately does not have. Design work rather than a patch.
4. **#6** — grapple/shove, surprise, bonus-action potions, two-weapon fighting.
   All need that same action economy.

import { classInfo, gainsAbilityScoreIncrease, proficiencyBonus } from './rules5e.js';

/**
 * What a character gains by reaching a level.
 *
 * Pure, and deliberately takes its compendium rows as arguments rather than
 * reaching for a database: the arithmetic here is the part that can be wrong in
 * ways nobody sees, and it is only testable if it can be called with three
 * arrays and no server.
 *
 * Everything is expressed as a *difference* between two levels. That is not
 * fussiness - the published data is cumulative in places, and a running total
 * read as "gained here" hands out an ability score increase at every level from
 * four upwards. Nothing in this file ever reports a value; it reports a change.
 */

/** A class's published row for one level, as `srd_class_levels` stores it. */
export interface ClassLevelRow {
  className: string;
  level: number;
  spellcasting: Record<string, number> | null;
  classSpecific: Record<string, unknown>;
}

/** A class or subclass feature, as `srd_features` stores it. */
export interface FeatureRow {
  className: string;
  subclassName: string;
  level: number;
  name: string;
  description: string;
  parentName: string;
}

/** A racial trait, as `srd_traits` stores it. */
export interface TraitRow {
  name: string;
  description: string;
  races: string[];
}

export interface GainedFeature {
  name: string;
  description: string;
  /** Empty for a feature the whole class gets. */
  subclassName: string;
  /** The level it arrives at, which matters when several are gained at once. */
  level: number;
  /** The choices this feature offers, where it is a choice rather than a thing. */
  options: { name: string; description: string }[];
}

export interface CounterChange {
  /** "Rage count" - the published key, made readable. */
  label: string;
  from: string;
  to: string;
}

export interface SlotChange {
  spellLevel: number;
  from: number;
  to: number;
}

export interface LevelGains {
  className: string;
  /** The level reached. */
  level: number;
  /** Set when nothing can be said, and why. Everything else is empty then. */
  unavailable: string | null;
  features: GainedFeature[];
  subclassFeatures: GainedFeature[];
  /** How many ability score increases are owed - two, if a level was skipped. */
  abilityScoreIncreases: number;
  /** Only when it moved. */
  proficiencyBonus: { from: number; to: number } | null;
  spellSlots: SlotChange[];
  cantrips: { from: number; to: number } | null;
  counters: CounterChange[];
  /**
   * Racial traits whose text names one of the levels reached.
   *
   * A pointer to re-read, never a claim about what is gained. 5e writes the
   * few racial level-ups it has into prose - a Dragonborn's breath weapon, a
   * Tiefling's Infernal Legacy - and deciding what those do by reading them is
   * wrong in both directions.
   */
  raceHints: { name: string; description: string }[];
}

/** "3" as "3rd", for matching prose that says "at 3rd level". */
function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** `rage_count` as "Rage count". */
function readable(key: string): string {
  const words = key.replace(/_/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * A published counter as something a person can read.
 *
 * Numbers and dice pairs cover everything the data actually carries per level;
 * a list (the sorcerer's table of slot costs) is not a counter that went up, so
 * it returns null and is left out rather than printed as `[object Object]`.
 */
function counterValue(value: unknown): string | null {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'yes' : 'no';

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const dice = value as { dice_count?: number; dice_value?: number };
    if (typeof dice.dice_count === 'number' && typeof dice.dice_value === 'number') {
      return `${dice.dice_count}d${dice.dice_value}`;
    }
  }

  return null;
}

const SLOT_KEY = /^spell_slots_level_(\d)$/;

/**
 * Turns a flat list of feature rows into features with their options nested.
 *
 * The SRD publishes "Fighting Style" and its six options as seven sibling rows,
 * so a Fighter reaching level 1 flat is handed eight things instead of two and
 * a choice. An option whose parent is not in the same batch is kept as a
 * feature of its own rather than dropped - a lost feature is worse than an
 * ungrouped one.
 */
function nest(rows: FeatureRow[]): GainedFeature[] {
  const parents = rows.filter((row) => !row.parentName);
  const byName = new Map(parents.map((row) => [row.name, row]));

  const built = parents.map((row) => ({
    name: row.name,
    description: row.description,
    subclassName: row.subclassName,
    level: row.level,
    options: rows
      .filter((option) => option.parentName === row.name)
      .map((option) => ({ name: option.name, description: option.description })),
  }));

  const orphans = rows
    .filter((row) => row.parentName && !byName.has(row.parentName))
    .map((row) => ({
      name: row.name,
      description: row.description,
      subclassName: row.subclassName,
      level: row.level,
      options: [],
    }));

  return [...built, ...orphans];
}

export function levelGains(input: {
  className: string;
  subclass: string;
  race: string;
  /** The level left behind. */
  from: number;
  /** The level reached. */
  to: number;
  classLevels: ClassLevelRow[];
  features: FeatureRow[];
  traits: TraitRow[];
}): LevelGains {
  const empty: LevelGains = {
    className: input.className,
    level: input.to,
    unavailable: null,
    features: [],
    subclassFeatures: [],
    abilityScoreIncreases: 0,
    proficiencyBonus: null,
    spellSlots: [],
    cantrips: null,
    counters: [],
    raceHints: [],
  };

  // The class field stays free text so homebrew and "Fighter 3 / Rogue 2" keep
  // working, which means this has to say so rather than guess - exactly as the
  // hit-point prompt already does for a class it has no die for.
  const info = classInfo(input.className);
  if (!info) {
    return {
      ...empty,
      unavailable: input.className.trim()
        ? `Nothing published for “${input.className}” — a multiclass or homebrew class is yours to look up.`
        : 'No class is set on this sheet yet.',
    };
  }

  if (input.to <= input.from) {
    return { ...empty, unavailable: 'That is not a level gained.' };
  }

  // Every level crossed, not only the last: a DM moving the party from 3 to 5
  // owes them both levels' worth, and showing only the fifth loses the fourth.
  const crossed: number[] = [];
  for (let level = input.from + 1; level <= input.to; level += 1) crossed.push(level);

  const named = (row: { className: string }) =>
    row.className.trim().toLowerCase() === input.className.trim().toLowerCase();

  const gained = input.features.filter((row) => named(row) && crossed.includes(row.level));

  // A subclass the sheet names wins; with none set, whatever the SRD publishes
  // is shown under its own heading so nobody mistakes it for their own.
  const wantedSubclass = input.subclass.trim().toLowerCase();
  const subclassRows = gained.filter(
    (row) => row.subclassName && (!wantedSubclass || row.subclassName.trim().toLowerCase() === wantedSubclass),
  );

  const rowFor = (level: number) =>
    input.classLevels.find((row) => named(row) && row.level === level) ?? null;

  const before = rowFor(input.from);
  const after = rowFor(input.to);

  // Slots and cantrips, as differences. A caster who gained nothing this level
  // gets an empty list rather than a table of unchanged numbers.
  const slots: SlotChange[] = [];
  let cantrips: { from: number; to: number } | null = null;

  if (after?.spellcasting) {
    for (const [key, value] of Object.entries(after.spellcasting)) {
      const match = SLOT_KEY.exec(key);
      if (!match) continue;

      const was = before?.spellcasting?.[key] ?? 0;
      if (value > was) slots.push({ spellLevel: Number(match[1]), from: was, to: value });
    }
    slots.sort((a, b) => a.spellLevel - b.spellLevel);

    const cantripsNow = after.spellcasting.cantrips_known ?? 0;
    const cantripsWas = before?.spellcasting?.cantrips_known ?? 0;
    if (cantripsNow > cantripsWas) cantrips = { from: cantripsWas, to: cantripsNow };
  }

  const counters: CounterChange[] = [];
  if (after) {
    for (const [key, value] of Object.entries(after.classSpecific ?? {})) {
      const now = counterValue(value);
      const was = counterValue((before?.classSpecific ?? {})[key]);
      // Unchanged counters are left out: the list is what moved, and a wall of
      // identical numbers buries the two that did.
      if (now !== null && now !== was && now !== '0') {
        counters.push({ label: readable(key), from: was ?? '—', to: now });
      }
    }
  }

  const profFrom = proficiencyBonus(input.from);
  const profTo = proficiencyBonus(input.to);

  const race = input.race.trim().toLowerCase();
  const ordinals = crossed.map((level) => ordinal(level));
  const raceHints = race
    ? input.traits
        .filter((trait) => trait.races.some((name) => name.trim().toLowerCase() === race))
        .filter((trait) =>
          ordinals.some((word) => new RegExp(`\\b${word}\\s+level\\b`, 'i').test(trait.description)),
        )
        .map((trait) => ({ name: trait.name, description: trait.description }))
    : [];

  return {
    className: input.className,
    level: input.to,
    unavailable: null,
    features: nest(gained.filter((row) => !row.subclassName)),
    subclassFeatures: nest(subclassRows),
    abilityScoreIncreases: crossed.filter((level) =>
      gainsAbilityScoreIncrease(input.className, level),
    ).length,
    proficiencyBonus: profTo > profFrom ? { from: profFrom, to: profTo } : null,
    spellSlots: slots,
    cantrips,
    counters,
    raceHints,
  };
}

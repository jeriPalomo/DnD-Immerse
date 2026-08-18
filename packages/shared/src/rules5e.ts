/**
 * Pure 5e rules math. Every derived value on a character sheet is computed
 * here rather than stored, so nothing can drift out of sync with the
 * underlying ability scores.
 */

export type AbilityKey = 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha';

export const ABILITIES: readonly AbilityKey[] = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;

export const ABILITY_NAMES: Record<AbilityKey, string> = {
  str: 'Strength',
  dex: 'Dexterity',
  con: 'Constitution',
  int: 'Intelligence',
  wis: 'Wisdom',
  cha: 'Charisma',
};

export type AbilityScores = Record<AbilityKey, number>;

/** The 18 SRD skills and the ability each keys off. */
export const SKILLS = {
  acrobatics: { name: 'Acrobatics', ability: 'dex' },
  animalHandling: { name: 'Animal Handling', ability: 'wis' },
  arcana: { name: 'Arcana', ability: 'int' },
  athletics: { name: 'Athletics', ability: 'str' },
  deception: { name: 'Deception', ability: 'cha' },
  history: { name: 'History', ability: 'int' },
  insight: { name: 'Insight', ability: 'wis' },
  intimidation: { name: 'Intimidation', ability: 'cha' },
  investigation: { name: 'Investigation', ability: 'int' },
  medicine: { name: 'Medicine', ability: 'wis' },
  nature: { name: 'Nature', ability: 'int' },
  perception: { name: 'Perception', ability: 'wis' },
  performance: { name: 'Performance', ability: 'cha' },
  persuasion: { name: 'Persuasion', ability: 'cha' },
  religion: { name: 'Religion', ability: 'int' },
  sleightOfHand: { name: 'Sleight of Hand', ability: 'dex' },
  stealth: { name: 'Stealth', ability: 'dex' },
  survival: { name: 'Survival', ability: 'wis' },
} as const satisfies Record<string, { name: string; ability: AbilityKey }>;

export type SkillKey = keyof typeof SKILLS;

export const SKILL_KEYS = Object.keys(SKILLS) as SkillKey[];

/** Proficiency level in a skill or save: none, proficient, or expertise (double). */
export type ProficiencyLevel = 0 | 1 | 2;

/** -5 at score 1, +0 at 10-11, +10 at 30. */
export function abilityModifier(score: number): number {
  return Math.floor((score - 10) / 2);
}

/** +2 at levels 1-4, rising by 1 every 4 levels to +6 at 17-20. */
export function proficiencyBonus(level: number): number {
  const clamped = Math.max(1, Math.min(20, Math.floor(level)));
  return Math.floor((clamped - 1) / 4) + 2;
}

export function skillBonus(
  scores: AbilityScores,
  level: number,
  skill: SkillKey,
  proficiency: ProficiencyLevel,
): number {
  const ability = SKILLS[skill].ability;
  return abilityModifier(scores[ability]) + proficiencyBonus(level) * proficiency;
}

export function savingThrowBonus(
  scores: AbilityScores,
  level: number,
  ability: AbilityKey,
  proficient: boolean,
): number {
  return abilityModifier(scores[ability]) + (proficient ? proficiencyBonus(level) : 0);
}

/** Passive scores are 10 + the relevant skill bonus (advantage/disadvantage aside). */
export function passiveSkill(
  scores: AbilityScores,
  level: number,
  skill: SkillKey,
  proficiency: ProficiencyLevel,
): number {
  return 10 + skillBonus(scores, level, skill, proficiency);
}

export function spellSaveDC(scores: AbilityScores, level: number, casting: AbilityKey): number {
  return 8 + proficiencyBonus(level) + abilityModifier(scores[casting]);
}

export function spellAttackBonus(scores: AbilityScores, level: number, casting: AbilityKey): number {
  return proficiencyBonus(level) + abilityModifier(scores[casting]);
}

/** Formats a bonus for display: 3 -> "+3", -1 -> "-1", 0 -> "+0". */
export function formatModifier(value: number): string {
  return value >= 0 ? `+${value}` : `${value}`;
}

/** Carrying capacity in pounds (SRD: STR score x 15). */
export function carryingCapacity(scores: AbilityScores): number {
  return scores.str * 15;
}

/** XP thresholds for levels 1-20, index 0 = level 1. */
export const XP_THRESHOLDS = [
  0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000,
  85000, 100000, 120000, 140000, 165000, 195000, 225000, 265000, 305000, 355000,
] as const;

export function levelFromXP(xp: number): number {
  let level = 1;
  for (let i = 0; i < XP_THRESHOLDS.length; i++) {
    if (xp >= XP_THRESHOLDS[i]) level = i + 1;
  }
  return level;
}

/* ------------------------------------------------------ character classes */

/**
 * The twelve SRD classes, with the two things the sheet cannot work out for
 * itself: hit die size, and which ability casts.
 *
 * These exist because both were previously unreachable. Nothing in the UI ever
 * set `hitDiceTotal`, so every character - a level 12 barbarian included -
 * short-rested on the schema default of `1d8`; and nothing ever set
 * `spellcastingAbility`, so the spell save DC header returned null and no
 * caster ever saw their DC. Picking a class from a list fills both, which is
 * the point of it being a list rather than a text box.
 */
/**
 * How a class gets spell slots, which decides the highest level it can cast.
 *
 * Third casters (Eldritch Knight, Arcane Trickster) are subclass choices, and
 * subclasses are not modelled - a Fighter reads as non-casting here.
 */
export type CasterKind = 'full' | 'half' | 'pact' | null;

export interface ClassInfo {
  hitDie: number;
  casting: AbilityKey | null;
  /** The two saving throws the class is proficient in, per the PHB. */
  saves: readonly [AbilityKey, AbilityKey];
  caster: CasterKind;
}

export const CLASSES = {
  Barbarian: { hitDie: 12, casting: null, saves: ['str', 'con'], caster: null },
  Bard: { hitDie: 8, casting: 'cha', saves: ['dex', 'cha'], caster: 'full' },
  Cleric: { hitDie: 8, casting: 'wis', saves: ['wis', 'cha'], caster: 'full' },
  Druid: { hitDie: 8, casting: 'wis', saves: ['int', 'wis'], caster: 'full' },
  Fighter: { hitDie: 10, casting: null, saves: ['str', 'con'], caster: null },
  Monk: { hitDie: 8, casting: null, saves: ['str', 'dex'], caster: null },
  Paladin: { hitDie: 10, casting: 'cha', saves: ['wis', 'cha'], caster: 'half' },
  Ranger: { hitDie: 10, casting: 'wis', saves: ['str', 'dex'], caster: 'half' },
  Rogue: { hitDie: 8, casting: null, saves: ['dex', 'int'], caster: null },
  Sorcerer: { hitDie: 6, casting: 'cha', saves: ['con', 'cha'], caster: 'full' },
  Warlock: { hitDie: 8, casting: 'cha', saves: ['wis', 'cha'], caster: 'pact' },
  Wizard: { hitDie: 6, casting: 'int', saves: ['int', 'wis'], caster: 'full' },
} as const satisfies Record<string, ClassInfo>;

export type ClassName = keyof typeof CLASSES;

export const CLASS_NAMES = Object.keys(CLASSES) as ClassName[];

/**
 * Looks a class up loosely, because the field stays free text - homebrew and
 * multiclass strings like "Fighter 3 / Rogue 2" have to keep working. Returns
 * null for anything it does not recognise rather than guessing.
 */
export function classInfo(name: string): ClassInfo | null {
  const wanted = (name ?? '').trim().toLowerCase();
  const found = CLASS_NAMES.find((c) => c.toLowerCase() === wanted);
  return found ? CLASSES[found] : null;
}

/** The two saves a class grants. Empty for anything unrecognised. */
export function classSaves(className: string): AbilityKey[] {
  return [...(classInfo(className)?.saves ?? [])];
}

/**
 * The highest spell level a class can cast at a given level.
 *
 * 0 means cantrips only; -1 means the class does not cast at all, which is a
 * different answer from "cantrips only" and the picker needs to tell them
 * apart. Half casters get nothing at all until level 2.
 */
export function maxSpellLevel(className: string, level: number): number {
  const info = classInfo(className);
  if (!info || !info.caster) return -1;

  const lvl = Math.max(1, Math.min(20, Math.trunc(level) || 1));

  if (info.caster === 'full') return Math.min(9, Math.ceil(lvl / 2));
  if (info.caster === 'pact') return Math.min(5, Math.ceil(lvl / 2));
  // Paladins and rangers have no slots at level 1, then 1st at 2, 2nd at 5,
  // 3rd at 9, 4th at 13, 5th at 17.
  return lvl < 2 ? 0 : Math.min(5, Math.floor((lvl - 1) / 4) + 1);
}

/**
 * Hit points gained for a level after the first: roll the class die, or take
 * the fixed average the handbook offers instead.
 *
 * The Constitution modifier is added to whichever is chosen, and a level never
 * grants less than 1 hit point however bad the constitution.
 */
export function hitPointsForLevel(hitDie: number): { roll: string; average: number } {
  return { roll: `1d${hitDie}`, average: Math.floor(hitDie / 2) + 1 };
}

/** Hit points from one level's die result and Constitution. Never below 1. */
export function hitPointsGained(dieResult: number, conMod: number): number {
  return Math.max(1, dieResult + conMod);
}

/** The hit dice pool a class and level imply, e.g. "5d10". Blank if unknown. */
export function hitDicePool(className: string, level: number): string {
  const info = classInfo(className);
  if (!info) return '';
  return `${Math.max(1, Math.min(20, Math.trunc(level) || 1))}d${info.hitDie}`;
}

/** SRD species. Free text still wins - this is a list of suggestions. */
export const SPECIES = [
  'Dragonborn',
  'Dwarf',
  'Elf',
  'Gnome',
  'Half-Elf',
  'Half-Orc',
  'Halfling',
  'Human',
  'Tiefling',
] as const;

/**
 * Ability score increases granted by species.
 *
 * Two things this deliberately does not model, because guessing would be worse
 * than saying nothing: SUBRACES, so a Hill Dwarf's +1 Wisdom is absent and only
 * the base Dwarf +2 Constitution is here; and the Half-Elf's "+1 to two
 * abilities of your choice", which is a choice rather than a fact.
 *
 * These are shown on the sheet as a reminder of what the species grants. They
 * are never added to a score - the handbook expects the number written on the
 * sheet to already include them, so applying them again would double-count.
 */
export const SPECIES_BONUSES = {
  Dragonborn: { str: 2, cha: 1 },
  Dwarf: { con: 2 },
  Elf: { dex: 2 },
  Gnome: { int: 2 },
  'Half-Elf': { cha: 2 },
  'Half-Orc': { str: 2, con: 1 },
  Halfling: { dex: 2 },
  Human: { str: 1, dex: 1, con: 1, int: 1, wis: 1, cha: 1 },
  Tiefling: { int: 1, cha: 2 },
} as const satisfies Record<(typeof SPECIES)[number], Partial<Record<AbilityKey, number>>>;

/** What a species adds, looked up loosely. Empty for anything unrecognised. */
export function speciesBonuses(species: string): Partial<Record<AbilityKey, number>> {
  const wanted = (species ?? '').trim().toLowerCase();
  const found = SPECIES.find((s) => s.toLowerCase() === wanted);
  return found ? SPECIES_BONUSES[found] : {};
}

export const BACKGROUNDS = [
  'Acolyte',
  'Charlatan',
  'Criminal',
  'Entertainer',
  'Folk Hero',
  'Guild Artisan',
  'Hermit',
  'Noble',
  'Outlander',
  'Sage',
  'Sailor',
  'Soldier',
  'Urchin',
] as const;

export const ALIGNMENTS = [
  'Lawful Good',
  'Neutral Good',
  'Chaotic Good',
  'Lawful Neutral',
  'True Neutral',
  'Chaotic Neutral',
  'Lawful Evil',
  'Neutral Evil',
  'Chaotic Evil',
] as const;

/* -------------------------------------------------- spells that condition */

export interface SpellCondition {
  /** The saving throw that avoids it. */
  save: AbilityKey;
  /** Conditions inflicted on a failed save. Names from `CONDITIONS`. */
  conditions: string[];
  /**
   * How long it lasts, in rounds. Null means until removed - `prone` is stood
   * up from rather than waited out, so a timer on it would be wrong.
   */
  rounds: number | null;
  /** Whether holding it needs concentration, so the caster can be reminded. */
  concentration: boolean;
}

/**
 * Which SRD spells inflict which conditions.
 *
 * Curated by hand and unit tested against the handbook, exactly like `CLASSES`
 * and for the same reason: a wrong pair here is invisible. It does not announce
 * itself - it just quietly paralyses the wrong creature, or fails to, for the
 * rest of the campaign.
 *
 * The SRD's own data cannot supply this. Spell effects are prose, and parsing
 * them is wrong in both directions - "immune to being blinded" reads exactly
 * like a spell that blinds. So this is the same call the compendium categories
 * made: curated, not taken from the data.
 *
 * DELIBERATELY ABSENT, rather than guessed:
 *   - Sleep, Color Spray, Power Word Stun - no saving throw at all. They work
 *     off a hit point pool, which is a judgement this cannot adjudicate.
 *   - Slow, Confusion, Bestow Curse, Contagion, Eyebite - their effect is not
 *     one of the 5e conditions, or the caster picks from several.
 *   - Flesh to Stone - three staged saves. A one-shot apply would misread it.
 * Add to this table only where the handbook is unambiguous. An omission means
 * the DM applies it by hand, which is merely the old behaviour; a wrong entry
 * means the app is confidently wrong.
 *
 * Rounds follow the spell's stated duration: 1 minute is 10 rounds, 1 hour 600.
 */
export const SPELL_CONDITIONS: Record<string, SpellCondition> = {
  'hold person': { save: 'wis', conditions: ['paralyzed'], rounds: 10, concentration: true },
  'hold monster': { save: 'wis', conditions: ['paralyzed'], rounds: 10, concentration: true },
  'blindness/deafness': { save: 'con', conditions: ['blinded'], rounds: 10, concentration: false },
  web: { save: 'dex', conditions: ['restrained'], rounds: 600, concentration: true },
  entangle: { save: 'str', conditions: ['restrained'], rounds: 10, concentration: true },
  'ensnaring strike': { save: 'str', conditions: ['restrained'], rounds: 10, concentration: true },
  'charm person': { save: 'wis', conditions: ['charmed'], rounds: 600, concentration: false },
  fear: { save: 'wis', conditions: ['frightened'], rounds: 10, concentration: true },
  'hypnotic pattern': {
    save: 'wis',
    conditions: ['charmed', 'incapacitated'],
    rounds: 10,
    concentration: true,
  },
  // The SRD calls this "Hideous Laughter". Keyed on the SRD's name, because
  // that is what the compendium row is called; the handbook's "Tasha's" form
  // still resolves, via the prefix rule in `spellCondition`.
  'hideous laughter': {
    save: 'wis',
    conditions: ['prone', 'incapacitated'],
    rounds: 10,
    concentration: true,
  },
  'dominate person': { save: 'wis', conditions: ['charmed'], rounds: 10, concentration: true },
  'dominate beast': { save: 'wis', conditions: ['charmed'], rounds: 10, concentration: true },
  'dominate monster': { save: 'wis', conditions: ['charmed'], rounds: 600, concentration: true },
  'ray of sickness': { save: 'con', conditions: ['poisoned'], rounds: 1, concentration: false },
  'blinding smite': { save: 'con', conditions: ['blinded'], rounds: 10, concentration: true },
  // Prone has no duration: you stand up out of it. The spell's own 1 minute is
  // how long the ground stays slick, which is terrain rather than a condition.
  grease: { save: 'dex', conditions: ['prone'], rounds: null, concentration: false },
  'sleet storm': { save: 'dex', conditions: ['prone'], rounds: null, concentration: true },
};

/**
 * What a spell inflicts, or null if this table does not know.
 *
 * Matched on a normalised name so "Hold Person" from the compendium and a
 * hand-typed "hold person " are the same spell.
 *
 * The SRD strips the wizard's name from every spell that carries one - the
 * handbook's "Tasha's Hideous Laughter" is published as plain "Hideous
 * Laughter", and likewise for Otiluke, Evard and the rest. So a possessive
 * prefix is tried and dropped rather than each spell being keyed twice. This
 * is not cosmetic: keyed on the handbook name alone, the entry silently never
 * matched the compendium row, which is exactly the invisible-wrong-entry
 * failure this table is meant to avoid.
 */
export function spellCondition(name: string): SpellCondition | null {
  const key = name.trim().toLowerCase();
  const direct = SPELL_CONDITIONS[key];
  if (direct) return direct;

  return SPELL_CONDITIONS[key.replace(/^[a-z]+'s\s+/, '')] ?? null;
}

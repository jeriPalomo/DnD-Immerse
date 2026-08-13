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
export const CLASSES = {
  Barbarian: { hitDie: 12, casting: null },
  Bard: { hitDie: 8, casting: 'cha' },
  Cleric: { hitDie: 8, casting: 'wis' },
  Druid: { hitDie: 8, casting: 'wis' },
  Fighter: { hitDie: 10, casting: null },
  Monk: { hitDie: 8, casting: null },
  Paladin: { hitDie: 10, casting: 'cha' },
  Ranger: { hitDie: 10, casting: 'wis' },
  Rogue: { hitDie: 8, casting: null },
  Sorcerer: { hitDie: 6, casting: 'cha' },
  Warlock: { hitDie: 8, casting: 'cha' },
  Wizard: { hitDie: 6, casting: 'int' },
} as const satisfies Record<string, { hitDie: number; casting: AbilityKey | null }>;

export type ClassName = keyof typeof CLASSES;

export const CLASS_NAMES = Object.keys(CLASSES) as ClassName[];

/**
 * Looks a class up loosely, because the field stays free text - homebrew and
 * multiclass strings like "Fighter 3 / Rogue 2" have to keep working. Returns
 * null for anything it does not recognise rather than guessing.
 */
export function classInfo(name: string): { hitDie: number; casting: AbilityKey | null } | null {
  const wanted = (name ?? '').trim().toLowerCase();
  const found = CLASS_NAMES.find((c) => c.toLowerCase() === wanted);
  return found ? CLASSES[found] : null;
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

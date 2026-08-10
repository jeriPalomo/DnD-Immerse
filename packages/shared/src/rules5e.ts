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

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
 * Every entry must exist in the SRD compendium, and `auditSpellConditions`
 * enforces that on every import. Ensnaring Strike, Ray of Sickness and Blinding
 * Smite were here and are gone: SRD 5.1 does not carry them, so nothing this
 * project has could check their save, duration or conditions, and they could
 * never fire from the compendium anyway. A hand-entered spell of that name sets
 * `appliesConditions` on the item itself, which is visible where a name-keyed
 * rule is not.
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


/**
 * A minute is ten rounds and an hour six hundred, which is how the durations in
 * this table are written. Returns null when the text says something this cannot
 * turn into a number ("Until dispelled", "Special"), so the audit skips it
 * rather than inventing a disagreement.
 */
export function roundsFromDuration(text: string): number | null {
  const match = /(\d+)\s*(round|minute|hour)/i.exec(text);
  if (!match) return /instantaneous/i.test(text) ? 0 : null;

  const count = Number(match[1]);
  const unit = match[2].toLowerCase();
  return count * (unit === 'round' ? 1 : unit === 'minute' ? 10 : 600);
}

/** One spell as the compendium holds it, which is everything the audit can check. */
export interface CompendiumSpell {
  name: string;
  save: AbilityKey | null;
  duration: string;
  concentration: boolean;
  description: string;
}

export interface SpellConditionAudit {
  /** Found, and everything the data can answer agrees. */
  matched: string[];
  /** Found, but carrying no save of its own; this table supplies it. */
  supplied: string[];
  /** Not in the compendium at all, so nothing here can be checked. */
  absent: string[];
  /** The data disagrees about which save it forces. */
  mismatched: { spell: string; field: string; table: string; data: string }[];
  /** A condition this table applies that the spell's own text never mentions. */
  unmentioned: { spell: string; condition: string }[];
}

/**
 * Checks this table against a real compendium.
 *
 * The reason this exists: `SPELL_CONDITIONS` is hand-written, and its unit
 * tests look its own keys up by themselves - which proves the lookup works and
 * says nothing about whether a key matches anything real. That is how
 * "tasha's hideous laughter" sat here matching no compendium row at all, since
 * the SRD publishes it as plain "Hideous Laughter".
 *
 * So the check runs where real data is: the importer calls this and prints the
 * result, the one moment the whole spell list is in hand. Four things are
 * compared, because all four are hand-entered and all four are invisible when
 * wrong: the saving throw, the duration in rounds, whether it needs
 * concentration, and whether the spell's own text so much as mentions the
 * condition being applied.
 *
 * That last one is a smell test, not a parser. Deciding what a spell does from
 * its prose is wrong in both directions - "immune to being blinded" reads
 * exactly like a spell that blinds - but a condition the text never names at
 * all is worth a human look.
 */
export function auditSpellConditions(spells: CompendiumSpell[]): SpellConditionAudit {
  const audit: SpellConditionAudit = {
    matched: [],
    supplied: [],
    absent: [],
    mismatched: [],
    unmentioned: [],
  };

  // Resolved the same way `spellCondition` resolves a cast, so the possessive
  // rule is exercised by the audit rather than only by the lookup.
  const found = new Map<string, CompendiumSpell>();
  for (const spell of spells) {
    const key = spell.name.trim().toLowerCase();
    const resolved = key in SPELL_CONDITIONS ? key : key.replace(/^[a-z]+'s\s+/, '');
    if (resolved in SPELL_CONDITIONS) found.set(resolved, spell);
  }

  for (const [key, entry] of Object.entries(SPELL_CONDITIONS)) {
    const data = found.get(key);
    if (!data) {
      audit.absent.push(key);
      continue;
    }

    let agrees = true;
    const disagree = (field: string, table: string, value: string) => {
      audit.mismatched.push({ spell: key, field, table, data: value });
      agrees = false;
    };

    // No save in the data is fine: the SRD ships Web and Sleet Storm with no dc
    // block at all, and this table is what supplies one.
    if (data.save === null) audit.supplied.push(key);
    else if (data.save !== entry.save) disagree('save', entry.save, data.save);

    if (data.concentration !== entry.concentration) {
      disagree('concentration', String(entry.concentration), String(data.concentration));
    }

    // Skipped where the table deliberately carries no timer - prone is stood up
    // from rather than waited out, however long the spell itself lasts.
    const stated = roundsFromDuration(data.duration);
    if (entry.rounds !== null && stated !== null && stated !== entry.rounds) {
      disagree('rounds', String(entry.rounds), `${stated} (${data.duration})`);
    }

    const text = data.description.toLowerCase();
    for (const condition of entry.conditions) {
      if (!text.includes(condition)) audit.unmentioned.push({ spell: key, condition });
    }

    if (agrees && data.save !== null) audit.matched.push(key);
  }

  return audit;
}

/* -------------------------------------------------------------- potions */

/**
 * What the SRD's healing potions restore, keyed by compendium id.
 *
 * Curated, because the compendium publishes these numbers only inside the
 * item's description and parsing prose for mechanics is the mistake this
 * codebase keeps refusing to make.
 *
 * Keyed by the SRD index rather than the display name, because the name is not
 * unique: 5.1 carries two items called "Potion of Healing" - the common 2d4+2
 * flask, and a generic entry whose text just points at the rarity table. Keying
 * by name matched whichever happened to be loaded last and would have stamped
 * one potion's dice onto the other. The generic entry is deliberately absent:
 * it has no fixed dice to state.
 *
 * `auditPotionHealing` checks the table against the compendium on every import
 * - an entry matching no real item can never fire and cannot be verified, so it
 * is a bug in the table rather than a gap to live with. Everything else stays
 * descriptive until a DM types its dice in by hand, the same bargain
 * `SPELL_CONDITIONS` strikes.
 */
export const POTION_HEALING: Record<string, string> = {
  'potion-of-healing-common': '2d4+2',
  'potion-of-healing-greater': '4d4+4',
  'potion-of-healing-superior': '8d4+8',
  'potion-of-healing-supreme': '10d4+20',
};

export interface PotionAudit {
  /** Entries that matched a compendium item, and were applied. */
  matched: string[];
  /** Entries matching nothing in the compendium - a bug in the table. */
  missing: string[];
  /**
   * Matched items whose own text does not mention hit points. A smell test,
   * not a parser: it cannot prove the dice are right, but a healing potion
   * whose description never says "hit points" is worth a second look. The 2024
   * dataset letter-spaces its prose ("H i t   P o i n t"), which is exactly the
   * sort of thing this is meant to surface rather than silently accept.
   */
  suspicious: string[];
}

/** Checks the curated table against the data, never against itself. */
export function auditPotionHealing(
  items: { id: string; name: string; description: string }[],
): PotionAudit {
  const byId = new Map(items.map((item) => [item.id, item]));
  const audit: PotionAudit = { matched: [], missing: [], suspicious: [] };

  for (const id of Object.keys(POTION_HEALING)) {
    const item = byId.get(id);
    if (!item) {
      audit.missing.push(id);
      continue;
    }

    audit.matched.push(id);
    if (!/hit\s*point/i.test(item.description ?? '')) audit.suspicious.push(id);
  }

  return audit;
}

/* ------------------------------------------------------ levelling up */

/**
 * The levels at which a class gains an ability score increase.
 *
 * Curated rather than imported, because the two editions disagree about
 * publishing it at all: 2014 ships a cumulative `ability_score_bonuses` count
 * per level, and 2024 ships no such field anywhere. One table serves both, and
 * `auditAsiLevels` checks it against the 2014 data during `srd:import` - which
 * is the only way a hand-written table earns any trust.
 *
 * Everyone gets 4, 8, 12, 16 and 19. Fighters get two more and Rogues one, and
 * those three exceptions are the whole reason this cannot be a formula.
 */
export const ASI_LEVELS: Readonly<Record<string, readonly number[]>> = {
  Barbarian: [4, 8, 12, 16, 19],
  Bard: [4, 8, 12, 16, 19],
  Cleric: [4, 8, 12, 16, 19],
  Druid: [4, 8, 12, 16, 19],
  Fighter: [4, 6, 8, 12, 14, 16, 19],
  Monk: [4, 8, 12, 16, 19],
  Paladin: [4, 8, 12, 16, 19],
  Ranger: [4, 8, 12, 16, 19],
  Rogue: [4, 8, 10, 12, 16, 19],
  Sorcerer: [4, 8, 12, 16, 19],
  Warlock: [4, 8, 12, 16, 19],
  Wizard: [4, 8, 12, 16, 19],
};

/**
 * Whether reaching this level owes an ability score increase.
 *
 * Answered from the level alone, never from a running total. The 2014 dataset
 * publishes the count *cumulatively* - a Barbarian reads 1 at level 5 because
 * of the increase at 4 - so reading that number as "you get one here" hands out
 * an increase at every level from 4 upwards.
 */
export function gainsAbilityScoreIncrease(className: string, level: number): boolean {
  const found = CLASS_NAMES.find((name) => name.toLowerCase() === (className ?? '').trim().toLowerCase());
  return found ? (ASI_LEVELS[found] ?? []).includes(level) : false;
}

export interface AsiAudit {
  /** Classes where the table and the published counts agree at every level. */
  matched: string[];
  /** Classes they disagree about, and where. */
  disagreed: { className: string; ours: number[]; published: number[] }[];
  /** Classes the data says nothing about, so nothing here can check them. */
  unchecked: string[];
}

/**
 * Checks `ASI_LEVELS` against the levels the 2014 compendium publishes.
 *
 * Takes the cumulative counts and turns them back into the levels where the
 * count *went up*, which is the same arithmetic `gainsAbilityScoreIncrease`
 * refuses to get wrong - so this is a real comparison against the data rather
 * than the table agreeing with itself.
 */
export function auditAsiLevels(
  rows: { className: string; level: number; cumulative: number }[],
): AsiAudit {
  const audit: AsiAudit = { matched: [], disagreed: [], unchecked: [] };

  for (const className of CLASS_NAMES) {
    const mine = rows.filter((row) => row.className === className);
    if (mine.length === 0) {
      audit.unchecked.push(className);
      continue;
    }

    const counts = new Map(mine.map((row) => [row.level, row.cumulative]));
    const published = [...counts.keys()]
      .sort((a, b) => a - b)
      .filter((level) => (counts.get(level) ?? 0) > (counts.get(level - 1) ?? 0));

    const ours = [...(ASI_LEVELS[className] ?? [])];
    if (ours.join(',') === published.join(',')) audit.matched.push(className);
    else audit.disagreed.push({ className, ours, published });
  }

  return audit;
}

/* ------------------------------------------------------ experience points */

/**
 * What a creature of each challenge rating is worth, from the DMG.
 *
 * Keyed by the challenge rating exactly as the compendium writes it, fractions
 * and all, so a lookup needs no parsing. A stamped monster does not need this -
 * `srd_monsters` carries its own published `xp` and that always wins - but an
 * NPC written by hand carries a CR and nothing else, and a DM who gives their
 * boss a CR of 7 has said what it is worth.
 *
 * `auditXpByCr` checks every row of it against the compendium during
 * `srd:import`, which is the one moment all 337 published CR/XP pairs are in
 * hand. A curated table checked against itself proves nothing.
 */
export const XP_BY_CR: Readonly<Record<string, number>> = {
  '0': 10,
  '1/8': 25,
  '1/4': 50,
  '1/2': 100,
  '1': 200,
  '2': 450,
  '3': 700,
  '4': 1100,
  '5': 1800,
  '6': 2300,
  '7': 2900,
  '8': 3900,
  '9': 5000,
  '10': 5900,
  '11': 7200,
  '12': 8400,
  '13': 10000,
  '14': 11500,
  '15': 13000,
  '16': 15000,
  '17': 18000,
  '18': 20000,
  '19': 22000,
  '20': 25000,
  '21': 33000,
  '22': 41000,
  '23': 50000,
  '24': 62000,
  '25': 75000,
  '26': 90000,
  '27': 105000,
  '28': 120000,
  '29': 135000,
  '30': 155000,
};

/**
 * A challenge rating as experience points, or null when it says nothing.
 *
 * Null rather than zero, and the caller has to deal with it: an NPC with no CR
 * written on it is worth an unknown amount, which is a different fact from
 * being worth nothing, and summing it as zero would hand a table a confidently
 * short total.
 */
export function xpForChallengeRating(cr: string | null | undefined): number | null {
  if (cr === null || cr === undefined) return null;
  const key = cr.trim();
  if (!key) return null;
  return XP_BY_CR[key] ?? null;
}

/**
 * What a creature is worth, given what is known about it.
 *
 * The challenge rating wins over the compendium's own `xp` column, which is a
 * deliberate exception to the rule that a stamped monster's published numbers
 * beat anything recomputed. That rule exists for facts a stat block states and
 * a sheet cannot derive - a `+4 to hit` carrying proficiency the stat line
 * never mentions. Experience is not one of those: the DMG defines it *as* a
 * function of challenge rating, so there is no per-monster XP fact for a
 * published figure to know better.
 *
 * And it is measurably the safer way round. `auditXpByCr` against the 337
 * monsters in the compendium finds four rows carrying the XP of the rating one
 * step below - a Brass Dragon Wyrmling at CR 1 published as 100 rather than
 * 200 - so trusting the column outright would quietly halve the reward for
 * killing them.
 *
 * The column is still the fallback, for a creature whose rating means nothing
 * to the table.
 */
export function xpForMonster(source: {
  challengeRating?: string | null;
  publishedXp?: number | null;
}): number | null {
  const fromRating = xpForChallengeRating(source.challengeRating);
  if (fromRating !== null) return fromRating;
  return source.publishedXp && source.publishedXp > 0 ? source.publishedXp : null;
}

export interface XpAudit {
  /** CRs where the table and every published monster agree. */
  matched: string[];
  /**
   * CRs some published monster disagrees with, and how many.
   *
   * The count is the point. One row out of twenty-five is a typo upstream;
   * twenty-five out of twenty-five would mean the table here is wrong, and the
   * two want opposite responses.
   */
  disagreed: {
    cr: string;
    ours: number;
    published: number;
    example: string;
    disagreeing: number;
    total: number;
  }[];
  /** CRs no published monster uses, so nothing here can check them. */
  unchecked: string[];
}

/**
 * Checks `XP_BY_CR` against every monster the compendium publishes.
 *
 * The compendium carries both the challenge rating and the experience points
 * for all of them, so this is a straight comparison rather than a smell test -
 * the one audit in this file that can be certain. A CR nothing is published at
 * is reported as unchecked rather than passed over: it means the number is
 * hand-entered and unverified, which is worth knowing about even though there
 * is nothing to do.
 */
export function auditXpByCr(
  monsters: { name: string; challengeRating: string; xp: number }[],
): XpAudit {
  const audit: XpAudit = { matched: [], disagreed: [], unchecked: [] };

  for (const [cr, ours] of Object.entries(XP_BY_CR)) {
    // Zero-XP rows are the compendium declining to say, not a disagreement.
    const published = monsters.filter((m) => m.challengeRating === cr && m.xp > 0);
    if (published.length === 0) {
      audit.unchecked.push(cr);
      continue;
    }

    const wrong = published.filter((m) => m.xp !== ours);
    if (wrong.length > 0) {
      audit.disagreed.push({
        cr,
        ours,
        published: wrong[0]!.xp,
        example: wrong[0]!.name,
        disagreeing: wrong.length,
        total: published.length,
      });
    } else {
      audit.matched.push(cr);
    }
  }

  return audit;
}

/* ------------------------------------------------- building an encounter */

/**
 * What one character of each level can take, in XP, before an encounter stops
 * being a warm-up.
 *
 * Straight from the Dungeon Master's Guide's table. Indexed by level, so index
 * 0 is unused and level 5 is `ENCOUNTER_THRESHOLDS[5]`. A party's threshold is
 * the sum over its characters - four level 3s and a level 1 is a real party and
 * averaging their levels would describe neither.
 */
export const ENCOUNTER_THRESHOLDS: readonly {
  easy: number;
  medium: number;
  hard: number;
  deadly: number;
}[] = [
  { easy: 0, medium: 0, hard: 0, deadly: 0 },
  { easy: 25, medium: 50, hard: 75, deadly: 100 },
  { easy: 50, medium: 100, hard: 150, deadly: 200 },
  { easy: 75, medium: 150, hard: 225, deadly: 400 },
  { easy: 125, medium: 250, hard: 375, deadly: 500 },
  { easy: 250, medium: 500, hard: 750, deadly: 1100 },
  { easy: 300, medium: 600, hard: 900, deadly: 1400 },
  { easy: 350, medium: 750, hard: 1100, deadly: 1700 },
  { easy: 450, medium: 900, hard: 1400, deadly: 2100 },
  { easy: 550, medium: 1100, hard: 1600, deadly: 2400 },
  { easy: 600, medium: 1200, hard: 1900, deadly: 2800 },
  { easy: 800, medium: 1600, hard: 2400, deadly: 3600 },
  { easy: 1000, medium: 2000, hard: 3000, deadly: 4500 },
  { easy: 1100, medium: 2200, hard: 3400, deadly: 5100 },
  { easy: 1250, medium: 2500, hard: 3800, deadly: 5700 },
  { easy: 1400, medium: 2800, hard: 4300, deadly: 6400 },
  { easy: 1600, medium: 3200, hard: 4800, deadly: 7200 },
  { easy: 2000, medium: 3900, hard: 5900, deadly: 8800 },
  { easy: 2100, medium: 4200, hard: 6300, deadly: 9500 },
  { easy: 2400, medium: 4900, hard: 7300, deadly: 10900 },
  { easy: 2800, medium: 5700, hard: 8500, deadly: 12700 },
];

export interface PartyThresholds {
  easy: number;
  medium: number;
  hard: number;
  deadly: number;
}

/**
 * The party's thresholds, summed over the characters actually at the table.
 *
 * Levels outside 1-20 are clamped rather than dropped: a sheet with a nonsense
 * level should shift the answer, not silently shrink the party.
 */
export function partyThresholds(levels: readonly number[]): PartyThresholds {
  const total: PartyThresholds = { easy: 0, medium: 0, hard: 0, deadly: 0 };

  for (const raw of levels) {
    const level = Math.max(1, Math.min(20, Math.round(raw) || 1));
    const row = ENCOUNTER_THRESHOLDS[level];
    total.easy += row.easy;
    total.medium += row.medium;
    total.hard += row.hard;
    total.deadly += row.deadly;
  }

  return total;
}

/**
 * The DMG's multiplier for fighting several things at once.
 *
 * Six goblins are worth far more trouble than six times one goblin, and this is
 * the handbook's way of saying so. Applied to the monsters' XP before it is
 * compared with a threshold - never to the threshold itself, which is a common
 * way to get this backwards.
 */
export function encounterMultiplier(monsterCount: number): number {
  if (monsterCount <= 0) return 0;
  if (monsterCount === 1) return 1;
  if (monsterCount === 2) return 1.5;
  if (monsterCount <= 6) return 2;
  if (monsterCount <= 10) return 2.5;
  if (monsterCount <= 14) return 3;
  return 4;
}

/**
 * How hard a fight is, in the four words the handbook uses.
 *
 * `trivial` is below even the easy threshold - not a DMG term, but a real
 * answer: a single rat against four level 10s is not an "easy encounter", it is
 * scenery, and saying "easy" would suggest it is worth rolling for.
 */
export type EncounterDifficulty = 'trivial' | 'easy' | 'medium' | 'hard' | 'deadly';

export function encounterDifficulty(
  monsterXp: readonly number[],
  thresholds: PartyThresholds,
): { difficulty: EncounterDifficulty; adjustedXp: number } {
  const raw = monsterXp.reduce((sum, xp) => sum + xp, 0);
  const adjustedXp = Math.round(raw * encounterMultiplier(monsterXp.length));

  const difficulty: EncounterDifficulty =
    adjustedXp >= thresholds.deadly
      ? 'deadly'
      : adjustedXp >= thresholds.hard
        ? 'hard'
        : adjustedXp >= thresholds.medium
          ? 'medium'
          : adjustedXp >= thresholds.easy
            ? 'easy'
            : 'trivial';

  return { difficulty, adjustedXp };
}

/**
 * How many of a creature the party can take before the fight tips over.
 *
 * Answers the question a DM actually has in front of the bestiary - "how many
 * of these?" - rather than "is one of these hard", which is nearly always no.
 * Counts up rather than dividing, because the multiplier changes as the number
 * does and dividing by a multiplier that depends on the answer is circular.
 *
 * Returns the largest number that is still no harder than `ceiling`, and 0 when
 * even one is already worse than that.
 */
export function howManyFit(
  monsterXp: number,
  thresholds: PartyThresholds,
  ceiling: EncounterDifficulty,
  max = 12,
): number {
  const order: EncounterDifficulty[] = ['trivial', 'easy', 'medium', 'hard', 'deadly'];
  const limit = order.indexOf(ceiling);

  let fits = 0;
  for (let count = 1; count <= max; count++) {
    const { difficulty } = encounterDifficulty(Array(count).fill(monsterXp), thresholds);
    if (order.indexOf(difficulty) > limit) break;
    fits = count;
  }
  return fits;
}

/**
 * A saving throw or skill bonus as the stat block published it.
 *
 * A monster's numbers are copied, never recomputed - the same rule
 * `from-monster` follows for its attacks, and for the same reason. A stamped
 * goblin's actor row carries level 1 and no proficiencies, because a stat line
 * states neither: recomputing its Stealth from the sheet gives DEX +2 and the
 * book says +6, and recomputing an Ancient Red Dragon's DEX save gives +0
 * against a published +7. Both are the app being confidently wrong, which is
 * worse than the app not answering.
 *
 * Returns null when the block publishes nothing for that key, which is a real
 * answer: a stat line that lists no Wisdom save means the creature rolls its
 * bare ability modifier, and the caller falls back to exactly that.
 */
export function publishedMonsterBonus(
  proficiencies: unknown,
  kind: 'save' | 'skill',
  key: string,
): number | null {
  if (!Array.isArray(proficiencies)) return null;

  // `sleightOfHand` is `skill-sleight-of-hand` upstream; saves are the bare
  // three-letter ability. Both are lowercase, hyphenated at the word breaks.
  const wanted =
    kind === 'save'
      ? `saving-throw-${key.toLowerCase()}`
      : `skill-${key.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()}`;

  for (const entry of proficiencies) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as { value?: unknown; proficiency?: { index?: unknown } };
    if (row.proficiency?.index !== wanted) continue;
    return typeof row.value === 'number' ? row.value : null;
  }
  return null;
}

/**
 * Whether an attack roll landed, and how to say so.
 *
 * Separated from the handler that rolls it so the two cases dice will not
 * reliably produce - a natural 1 and an ordinary miss - can be tested at all.
 *
 * A natural 20 always hits and a natural 1 always misses, whatever the totals
 * say: the one place in 5e where the number on the die beats the arithmetic.
 * Meeting the AC exactly is a hit, which is the off-by-one worth pinning down.
 */
export function attackVerdict(
  total: number,
  natural: number | undefined,
  armorClass: number,
  targetName: string,
): { hit: boolean; critical: boolean; text: string } {
  if (natural === 20) {
    return { hit: true, critical: true, text: ` — CRITICAL HIT on ${targetName}` };
  }
  if (natural === 1) {
    return { hit: false, critical: false, text: ` — MISS (natural 1) against ${targetName}` };
  }

  const hit = total >= armorClass;
  return {
    hit,
    critical: false,
    text: ` — ${hit ? 'HIT' : 'MISS'} against ${targetName} (AC ${armorClass})`,
  };
}

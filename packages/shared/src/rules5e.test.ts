import { describe, expect, it } from 'vitest';
import {
  CLASS_NAMES,
  abilityModifier,
  classInfo,
  classSaves,
  formatModifier,
  hitDicePool,
  hitPointsForLevel,
  hitPointsGained,
  levelFromXP,
  maxSpellLevel,
  passiveSkill,
  proficiencyBonus,
  savingThrowBonus,
  skillBonus,
  speciesBonuses,
  spellAttackBonus,
  auditSpellConditions,
  spellCondition,
  spellSaveDC,
  SPELL_CONDITIONS,
  SPELL_CONDITIONS_NOT_IN_SRD,
  type AbilityScores,
} from './rules5e.js';
import { CONDITIONS } from './schemas.js';

const scores: AbilityScores = { str: 16, dex: 14, con: 15, int: 8, wis: 12, cha: 20 };

describe('abilityModifier', () => {
  it('matches the PHB table', () => {
    expect(abilityModifier(1)).toBe(-5);
    expect(abilityModifier(8)).toBe(-1);
    expect(abilityModifier(10)).toBe(0);
    expect(abilityModifier(11)).toBe(0);
    expect(abilityModifier(15)).toBe(2);
    expect(abilityModifier(20)).toBe(5);
    expect(abilityModifier(30)).toBe(10);
  });

  it('rounds odd scores down, not toward zero', () => {
    expect(abilityModifier(9)).toBe(-1);
    expect(abilityModifier(7)).toBe(-2);
  });
});

describe('proficiencyBonus', () => {
  it('steps up every four levels', () => {
    expect([1, 2, 3, 4].map(proficiencyBonus)).toEqual([2, 2, 2, 2]);
    expect([5, 8].map(proficiencyBonus)).toEqual([3, 3]);
    expect([9, 12].map(proficiencyBonus)).toEqual([4, 4]);
    expect([13, 16].map(proficiencyBonus)).toEqual([5, 5]);
    expect([17, 20].map(proficiencyBonus)).toEqual([6, 6]);
  });

  it('clamps out-of-range levels', () => {
    expect(proficiencyBonus(0)).toBe(2);
    expect(proficiencyBonus(99)).toBe(6);
  });
});

describe('skillBonus', () => {
  it('adds nothing when not proficient', () => {
    // Athletics is STR-based; STR 16 gives +3.
    expect(skillBonus(scores, 5, 'athletics', 0)).toBe(3);
  });

  it('adds proficiency once when proficient', () => {
    expect(skillBonus(scores, 5, 'athletics', 1)).toBe(6);
  });

  it('doubles proficiency for expertise', () => {
    expect(skillBonus(scores, 5, 'athletics', 2)).toBe(9);
  });

  it('keys each skill off the right ability', () => {
    // Persuasion is CHA-based; CHA 20 gives +5, plus +2 proficiency at level 1.
    expect(skillBonus(scores, 1, 'persuasion', 1)).toBe(7);
    // Arcana is INT-based; INT 8 gives -1.
    expect(skillBonus(scores, 1, 'arcana', 0)).toBe(-1);
  });
});

describe('savingThrowBonus', () => {
  it('applies proficiency only to proficient saves', () => {
    expect(savingThrowBonus(scores, 9, 'con', true)).toBe(6); // +2 CON, +4 prof
    expect(savingThrowBonus(scores, 9, 'con', false)).toBe(2);
  });
});

describe('passiveSkill', () => {
  it('is 10 plus the skill bonus', () => {
    // WIS 12 gives +1, proficient at level 5 adds +3.
    expect(passiveSkill(scores, 5, 'perception', 1)).toBe(14);
  });
});

describe('spellcasting', () => {
  it('computes save DC as 8 + proficiency + casting modifier', () => {
    expect(spellSaveDC(scores, 5, 'cha')).toBe(16); // 8 + 3 + 5
  });

  it('computes attack bonus as proficiency + casting modifier', () => {
    expect(spellAttackBonus(scores, 5, 'cha')).toBe(8);
  });
});

describe('formatModifier', () => {
  it('always shows a sign', () => {
    expect(formatModifier(3)).toBe('+3');
    expect(formatModifier(0)).toBe('+0');
    expect(formatModifier(-2)).toBe('-2');
  });
});

describe('levelFromXP', () => {
  it('maps XP onto the PHB advancement table', () => {
    expect(levelFromXP(0)).toBe(1);
    expect(levelFromXP(299)).toBe(1);
    expect(levelFromXP(300)).toBe(2);
    expect(levelFromXP(48000)).toBe(9);
    expect(levelFromXP(355000)).toBe(20);
    expect(levelFromXP(999999)).toBe(20);
  });
});

describe('class reference data', () => {
  it('knows the hit die and casting ability of every SRD class', () => {
    expect(CLASS_NAMES).toHaveLength(12);
    expect(classInfo('Barbarian')).toMatchObject({ hitDie: 12, casting: null });
    expect(classInfo('Wizard')).toMatchObject({ hitDie: 6, casting: 'int' });
    expect(classInfo('Paladin')).toMatchObject({ hitDie: 10, casting: 'cha' });
    expect(classInfo('Ranger')).toMatchObject({ hitDie: 10, casting: 'wis' });
  });

  it('matches loosely, because the field people type into is free text', () => {
    expect(classInfo('wizard')?.hitDie).toBe(6);
    expect(classInfo('  Cleric  ')?.casting).toBe('wis');
  });

  it('returns null for homebrew rather than guessing', () => {
    // A wrong hit die silently changes how much a rest heals, which is worse
    // than leaving the value alone.
    expect(classInfo('Blood Hunter')).toBeNull();
    expect(classInfo('Fighter 3 / Rogue 2')).toBeNull();
    expect(classInfo('')).toBeNull();
  });

  it('builds a hit dice pool from class and level', () => {
    expect(hitDicePool('Fighter', 5)).toBe('5d10');
    expect(hitDicePool('Sorcerer', 1)).toBe('1d6');
    // The default that everyone was stuck on before this existed.
    expect(hitDicePool('Cleric', 1)).toBe('1d8');
  });

  it('leaves the pool blank for a class it does not know', () => {
    expect(hitDicePool('Blood Hunter', 5)).toBe('');
  });

  it('clamps a level outside 1-20 rather than emitting nonsense', () => {
    expect(hitDicePool('Wizard', 0)).toBe('1d6');
    expect(hitDicePool('Wizard', 99)).toBe('20d6');
  });
});

describe('saving throw proficiencies by class', () => {
  it('matches the PHB for all twelve', () => {
    // Written out in full rather than spot-checked: a wrong pair here silently
    // changes every save a character rolls for the rest of the campaign.
    expect(classSaves('Barbarian')).toEqual(['str', 'con']);
    expect(classSaves('Bard')).toEqual(['dex', 'cha']);
    expect(classSaves('Cleric')).toEqual(['wis', 'cha']);
    expect(classSaves('Druid')).toEqual(['int', 'wis']);
    expect(classSaves('Fighter')).toEqual(['str', 'con']);
    expect(classSaves('Monk')).toEqual(['str', 'dex']);
    expect(classSaves('Paladin')).toEqual(['wis', 'cha']);
    expect(classSaves('Ranger')).toEqual(['str', 'dex']);
    expect(classSaves('Rogue')).toEqual(['dex', 'int']);
    expect(classSaves('Sorcerer')).toEqual(['con', 'cha']);
    expect(classSaves('Warlock')).toEqual(['wis', 'cha']);
    expect(classSaves('Wizard')).toEqual(['int', 'wis']);
  });

  it('grants exactly two to every class', () => {
    for (const name of CLASS_NAMES) expect(classSaves(name)).toHaveLength(2);
  });

  it('grants none for homebrew, rather than guessing a pair', () => {
    expect(classSaves('Blood Hunter')).toEqual([]);
  });
});

describe('maxSpellLevel', () => {
  it('advances a full caster one spell level every two character levels', () => {
    expect(maxSpellLevel('Wizard', 1)).toBe(1);
    expect(maxSpellLevel('Wizard', 2)).toBe(1);
    expect(maxSpellLevel('Wizard', 3)).toBe(2);
    expect(maxSpellLevel('Cleric', 9)).toBe(5);
    expect(maxSpellLevel('Bard', 17)).toBe(9);
    expect(maxSpellLevel('Sorcerer', 20)).toBe(9);
  });

  it('gives a half caster nothing until level 2, then caps at 5th', () => {
    expect(maxSpellLevel('Paladin', 1)).toBe(0);
    expect(maxSpellLevel('Paladin', 2)).toBe(1);
    expect(maxSpellLevel('Ranger', 4)).toBe(1);
    expect(maxSpellLevel('Ranger', 5)).toBe(2);
    expect(maxSpellLevel('Paladin', 9)).toBe(3);
    expect(maxSpellLevel('Paladin', 13)).toBe(4);
    expect(maxSpellLevel('Ranger', 17)).toBe(5);
    expect(maxSpellLevel('Ranger', 20)).toBe(5);
  });

  it('caps pact magic at 5th', () => {
    expect(maxSpellLevel('Warlock', 1)).toBe(1);
    expect(maxSpellLevel('Warlock', 5)).toBe(3);
    expect(maxSpellLevel('Warlock', 9)).toBe(5);
    expect(maxSpellLevel('Warlock', 20)).toBe(5);
  });

  it('reports -1 for a class that does not cast at all', () => {
    // Distinct from 0, which means cantrips only - the picker has to tell a
    // fighter "your class does not cast" rather than "cantrips only".
    expect(maxSpellLevel('Fighter', 20)).toBe(-1);
    expect(maxSpellLevel('Barbarian', 1)).toBe(-1);
    expect(maxSpellLevel('Blood Hunter', 5)).toBe(-1);
  });
});

describe('species ability increases', () => {
  it('matches the PHB for the base races', () => {
    expect(speciesBonuses('Dwarf')).toEqual({ con: 2 });
    expect(speciesBonuses('Half-Orc')).toEqual({ str: 2, con: 1 });
    expect(speciesBonuses('Tiefling')).toEqual({ int: 1, cha: 2 });
    expect(speciesBonuses('Human')).toEqual({ str: 1, dex: 1, con: 1, int: 1, wis: 1, cha: 1 });
  });

  it('matches loosely, like the class lookup', () => {
    expect(speciesBonuses('  elf ')).toEqual({ dex: 2 });
  });

  it('gives nothing for a species it does not know', () => {
    expect(speciesBonuses('Aarakocra')).toEqual({});
    expect(speciesBonuses('')).toEqual({});
  });
});

describe('hit points on level up', () => {
  it('offers the class die and the handbook average', () => {
    expect(hitPointsForLevel(6)).toEqual({ roll: '1d6', average: 4 });
    expect(hitPointsForLevel(8)).toEqual({ roll: '1d8', average: 5 });
    expect(hitPointsForLevel(10)).toEqual({ roll: '1d10', average: 6 });
    expect(hitPointsForLevel(12)).toEqual({ roll: '1d12', average: 7 });
  });

  it('never grants less than one hit point, however bad the constitution', () => {
    expect(hitPointsGained(1, -3)).toBe(1);
    expect(hitPointsGained(2, -5)).toBe(1);
    expect(hitPointsGained(5, 3)).toBe(8);
  });
});

describe('SPELL_CONDITIONS', () => {
  it('names only conditions the app can actually model', () => {
    // A typo here would apply a condition with no mechanics behind it, which
    // looks exactly like the feature working.
    for (const [spell, entry] of Object.entries(SPELL_CONDITIONS)) {
      for (const condition of entry.conditions) {
        expect(CONDITIONS, `${spell} → ${condition}`).toContain(condition);
      }
    }
  });

  it('matches the handbook on the ones a table uses most', () => {
    expect(spellCondition('Hold Person')).toEqual({
      save: 'wis', conditions: ['paralyzed'], rounds: 10, concentration: true,
    });
    expect(spellCondition('Blindness/Deafness')).toEqual({
      save: 'con', conditions: ['blinded'], rounds: 10, concentration: false,
    });
    expect(spellCondition('Web')).toEqual({
      save: 'dex', conditions: ['restrained'], rounds: 600, concentration: true,
    });
    expect(spellCondition('Entangle')?.save).toBe('str');
    expect(spellCondition('Fear')?.conditions).toEqual(['frightened']);
  });

  it('counts a minute as ten rounds and an hour as six hundred', () => {
    expect(spellCondition('Hold Person')?.rounds).toBe(10);
    expect(spellCondition('Charm Person')?.rounds).toBe(600);
  });

  it('leaves prone open-ended, because you stand up out of it', () => {
    expect(spellCondition('Grease')?.rounds).toBeNull();
    expect(spellCondition('Sleet Storm')?.rounds).toBeNull();
  });

  it('applies two conditions where the spell does', () => {
    expect(spellCondition('Hideous Laughter')?.conditions).toEqual(['prone', 'incapacitated']);
    expect(spellCondition('Hypnotic Pattern')?.conditions).toEqual(['charmed', 'incapacitated']);
  });

  it('matches the SRD name when the handbook adds a wizard to it', () => {
    // The SRD publishes "Hideous Laughter"; the handbook calls it Tasha's.
    // Keyed on the handbook name alone, this entry matched nothing at all.
    expect(spellCondition('Hideous Laughter')).not.toBeNull();
    expect(spellCondition("Tasha's Hideous Laughter")).toEqual(spellCondition('Hideous Laughter'));
    expect(spellCondition("Otiluke's Hideous Laughter")).toEqual(spellCondition('Hideous Laughter'));
  });

  it('does not let the prefix rule invent a match', () => {
    expect(spellCondition("Bigby's Handy Haversack")).toBeNull();
  });

  it('normalises the name it is looked up by', () => {
    expect(spellCondition('  hold person  ')).not.toBeNull();
    expect(spellCondition('HOLD PERSON')).not.toBeNull();
  });

  it('knows nothing about the spells it deliberately omits', () => {
    // Each of these has no save, a non-condition effect, or a staged one, and a
    // guess would be worse than the DM applying it by hand.
    for (const spell of ['Sleep', 'Color Spray', 'Slow', 'Confusion', 'Flesh to Stone', 'Eyebite']) {
      expect(spellCondition(spell), spell).toBeNull();
    }
  });

  it('returns null for a spell it has never heard of', () => {
    expect(spellCondition('Bigby’s Interpretive Dance')).toBeNull();
  });
});


describe('auditSpellConditions', () => {
  const everything = Object.entries(SPELL_CONDITIONS).map(([name, entry]) => ({
    name,
    save: entry.save,
  }));

  it('matches every entry against a compendium that agrees', () => {
    const audit = auditSpellConditions(everything);
    expect(audit.matched).toHaveLength(Object.keys(SPELL_CONDITIONS).length);
    expect(audit.absent).toEqual([]);
    expect(audit.mismatched).toEqual([]);
  });

  it('catches a spell the data says forces a different save', () => {
    // The failure the whole audit exists for: silently wrong on every casting.
    const wrong = everything.map((s) =>
      s.name === 'hold person' ? { ...s, save: 'con' as const } : s,
    );
    const audit = auditSpellConditions(wrong);

    expect(audit.mismatched).toEqual([{ spell: 'hold person', table: 'wis', data: 'con' }]);
    expect(audit.matched).not.toContain('hold person');
  });

  it('does not call a missing dc block a mismatch', () => {
    // The SRD ships Web and Sleet Storm with no save of their own; this table
    // is what supplies one, which is a supported case rather than a conflict.
    const audit = auditSpellConditions(
      everything.map((s) => (s.name === 'web' ? { ...s, save: null } : s)),
    );
    expect(audit.supplied).toContain('web');
    expect(audit.mismatched).toEqual([]);
  });

  it('resolves a spell the handbook names after a wizard', () => {
    const audit = auditSpellConditions(
      everything.map((s) =>
        s.name === 'hideous laughter' ? { ...s, name: "Tasha's Hideous Laughter" } : s,
      ),
    );
    expect(audit.matched).toContain('hideous laughter');
    expect(audit.absent).toEqual([]);
  });

  it('separates an expected absence from an unexpected one', () => {
    // Absent entries are declared, so a NEW one -- a typo, or a name the
    // dataset renamed -- stands out instead of joining a list of known gaps.
    const audit = auditSpellConditions(
      everything.filter((s) => !SPELL_CONDITIONS_NOT_IN_SRD.includes(s.name)),
    );
    expect(audit.absent.sort()).toEqual([...SPELL_CONDITIONS_NOT_IN_SRD].sort());
    expect(audit.unexpected).toEqual([]);

    const withTypo = auditSpellConditions(everything.filter((s) => s.name !== 'web'));
    expect(withTypo.unexpected).toEqual(['web']);
  });

  it('lists only spells that are genuinely outside SRD 5.1', () => {
    // A guard on the declaration itself: naming a spell here that IS in the
    // dataset would hide a real regression behind an expected gap.
    for (const name of SPELL_CONDITIONS_NOT_IN_SRD) {
      expect(SPELL_CONDITIONS[name], `${name} is declared absent but not in the table`).toBeDefined();
    }
  });
});

import { describe, expect, it } from 'vitest';
import {
  CLASS_NAMES,
  abilityModifier,
  classInfo,
  formatModifier,
  hitDicePool,
  levelFromXP,
  passiveSkill,
  proficiencyBonus,
  savingThrowBonus,
  skillBonus,
  spellAttackBonus,
  spellSaveDC,
  type AbilityScores,
} from './rules5e.js';

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
    expect(classInfo('Barbarian')).toEqual({ hitDie: 12, casting: null });
    expect(classInfo('Wizard')).toEqual({ hitDie: 6, casting: 'int' });
    expect(classInfo('Paladin')).toEqual({ hitDie: 10, casting: 'cha' });
    expect(classInfo('Ranger')).toEqual({ hitDie: 10, casting: 'wis' });
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

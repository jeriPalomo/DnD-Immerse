import { describe, expect, it } from 'vitest';
import {
  abilityModifier,
  publishedMonsterBonus,
  savingThrowBonus,
  skillBonus,
} from './rules5e.js';

/**
 * The shape upstream publishes, verbatim from the compendium rows for these
 * three creatures. Copied rather than paraphrased: the whole point of this
 * function is that it reads what is actually there, and a fixture written from
 * memory tests the memory.
 */
const GOBLIN = [
  { value: 6, proficiency: { index: 'skill-stealth', name: 'Skill: Stealth' } },
];

const ANCIENT_RED_DRAGON = [
  { value: 7, proficiency: { index: 'saving-throw-dex', name: 'Saving Throw: DEX' } },
  { value: 16, proficiency: { index: 'saving-throw-con', name: 'Saving Throw: CON' } },
  { value: 9, proficiency: { index: 'saving-throw-wis', name: 'Saving Throw: WIS' } },
  { value: 13, proficiency: { index: 'saving-throw-cha', name: 'Saving Throw: CHA' } },
  { value: 16, proficiency: { index: 'skill-perception', name: 'Skill: Perception' } },
];

const THIEF = [
  { value: 4, proficiency: { index: 'skill-sleight-of-hand', name: 'Skill: Sleight of Hand' } },
];

describe('publishedMonsterBonus', () => {
  it('reads a saving throw the block publishes', () => {
    expect(publishedMonsterBonus(ANCIENT_RED_DRAGON, 'save', 'dex')).toBe(7);
    expect(publishedMonsterBonus(ANCIENT_RED_DRAGON, 'save', 'con')).toBe(16);
  });

  it('reads a skill the block publishes', () => {
    expect(publishedMonsterBonus(GOBLIN, 'skill', 'stealth')).toBe(6);
    expect(publishedMonsterBonus(ANCIENT_RED_DRAGON, 'skill', 'perception')).toBe(16);
  });

  it('hyphenates a camelCase skill key the way upstream files it', () => {
    // `sleightOfHand` here, `skill-sleight-of-hand` there. Getting this wrong
    // is silent: the lookup misses and the creature falls back to its bare
    // modifier, which is a plausible number and the wrong one.
    expect(publishedMonsterBonus(THIEF, 'skill', 'sleightOfHand')).toBe(4);
  });

  it('answers null for a key the block says nothing about', () => {
    // A real answer, not a failure: a stat line with no Wisdom save means the
    // creature rolls its bare Wisdom modifier, and the caller does exactly that.
    expect(publishedMonsterBonus(GOBLIN, 'save', 'wis')).toBeNull();
    expect(publishedMonsterBonus(GOBLIN, 'skill', 'perception')).toBeNull();
    expect(publishedMonsterBonus(ANCIENT_RED_DRAGON, 'save', 'str')).toBeNull();
  });

  it('answers null for anything that is not a proficiency list', () => {
    for (const junk of [null, undefined, {}, 'stealth +6', 42, [null], [{}], [{ value: 3 }]]) {
      expect(publishedMonsterBonus(junk, 'skill', 'stealth')).toBeNull();
    }
  });

  it('does not confuse a save with the skill of the same ability', () => {
    const both = [
      { value: 5, proficiency: { index: 'saving-throw-dex', name: 'Saving Throw: DEX' } },
      { value: 9, proficiency: { index: 'skill-stealth', name: 'Skill: Stealth' } },
    ];
    expect(publishedMonsterBonus(both, 'save', 'dex')).toBe(5);
    expect(publishedMonsterBonus(both, 'skill', 'stealth')).toBe(9);
  });
});

/**
 * Why this function exists at all.
 *
 * A stamped monster's actor row carries level 1 and no proficiencies, because a
 * stat line states neither - so recomputing from the sheet is not merely a
 * different route to the same number, it is a different number.
 */
describe('the published number and the recomputed one disagree', () => {
  it('a goblin: Stealth +6 published, +2 recomputed', () => {
    const goblin = { str: 8, dex: 14, con: 10, int: 10, wis: 8, cha: 8 };

    const recomputed = skillBonus(goblin, 1, 'stealth', 0);
    expect(recomputed).toBe(2);
    expect(publishedMonsterBonus(GOBLIN, 'skill', 'stealth')).toBe(6);
  });

  it('an ancient red dragon: DEX save +7 published, +0 recomputed', () => {
    const dragon = { str: 30, dex: 10, con: 29, int: 18, wis: 15, cha: 23 };

    // Not proficient as far as the sheet knows, and level 1 besides.
    expect(savingThrowBonus(dragon, 1, 'dex', false)).toBe(0);
    expect(abilityModifier(dragon.dex)).toBe(0);
    expect(publishedMonsterBonus(ANCIENT_RED_DRAGON, 'save', 'dex')).toBe(7);
  });
});

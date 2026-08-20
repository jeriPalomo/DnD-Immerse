import { describe, expect, it } from 'vitest';
import {
  ENCOUNTER_THRESHOLDS,
  encounterDifficulty,
  encounterMultiplier,
  howManyFit,
  partyThresholds,
} from './rules5e.js';

/**
 * Checked against the handbook's own worked example rather than against
 * themselves - a curated table tested by looking its own keys up proves the
 * lookup works and nothing about whether the numbers are right.
 */
describe('encounter thresholds', () => {
  it('matches the DMG table at both ends and in the middle', () => {
    expect(ENCOUNTER_THRESHOLDS[1]).toEqual({ easy: 25, medium: 50, hard: 75, deadly: 100 });
    expect(ENCOUNTER_THRESHOLDS[5]).toEqual({ easy: 250, medium: 500, hard: 750, deadly: 1100 });
    expect(ENCOUNTER_THRESHOLDS[20]).toEqual({
      easy: 2800,
      medium: 5700,
      hard: 8500,
      deadly: 12700,
    });
  });

  it('has a row for every level from 1 to 20', () => {
    expect(ENCOUNTER_THRESHOLDS).toHaveLength(21);
    for (let level = 1; level <= 20; level++) {
      const row = ENCOUNTER_THRESHOLDS[level];
      expect(row.easy).toBeGreaterThan(0);
      expect(row.medium).toBeGreaterThan(row.easy);
      expect(row.hard).toBeGreaterThan(row.medium);
      expect(row.deadly).toBeGreaterThan(row.hard);
    }
  });

  it('sums over the characters rather than averaging them', () => {
    // Four level 3s and a level 1 is a real party, and an average describes
    // neither half of it.
    expect(partyThresholds([3, 3, 3, 3, 1])).toEqual({
      easy: 4 * 75 + 25,
      medium: 4 * 150 + 50,
      hard: 4 * 225 + 75,
      deadly: 4 * 400 + 100,
    });
  });

  it('clamps a nonsense level rather than dropping the character', () => {
    expect(partyThresholds([0])).toEqual(ENCOUNTER_THRESHOLDS[1]);
    expect(partyThresholds([99])).toEqual(ENCOUNTER_THRESHOLDS[20]);
  });
});

describe('the multiplier for fighting several things', () => {
  it('follows the handbook step for step', () => {
    expect(encounterMultiplier(1)).toBe(1);
    expect(encounterMultiplier(2)).toBe(1.5);
    expect(encounterMultiplier(3)).toBe(2);
    expect(encounterMultiplier(6)).toBe(2);
    expect(encounterMultiplier(7)).toBe(2.5);
    expect(encounterMultiplier(10)).toBe(2.5);
    expect(encounterMultiplier(11)).toBe(3);
    expect(encounterMultiplier(15)).toBe(4);
  });
});

describe('how hard a fight is', () => {
  // Four level 3 characters: easy 300, medium 600, hard 900, deadly 1600.
  const party = partyThresholds([3, 3, 3, 3]);

  it('calls one goblin scenery rather than easy', () => {
    // 50 XP against an easy threshold of 300. "Easy encounter" would suggest it
    // is worth rolling initiative for.
    expect(encounterDifficulty([50], party).difficulty).toBe('trivial');
  });

  it('counts the multiplier against the monsters, not the party', () => {
    // Six goblins: 300 raw, doubled to 600 - which is medium, not easy. Getting
    // this backwards is the classic way to run a party over.
    const six = encounterDifficulty(Array(6).fill(50), party);
    expect(six.adjustedXp).toBe(600);
    expect(six.difficulty).toBe('medium');
  });

  it('turns deadly as the numbers climb', () => {
    // Twelve goblins: 600 raw at triple is 1800, past a deadly threshold of 1600.
    expect(encounterDifficulty(Array(12).fill(50), party).difficulty).toBe('deadly');
  });

  it('reads a single big creature the same way', () => {
    // An ogre is 450 XP, alone: below the party's 600 medium, so easy.
    expect(encounterDifficulty([450], party).difficulty).toBe('easy');
  });
});

describe('how many of a creature the party can take', () => {
  const party = partyThresholds([3, 3, 3, 3]);

  it('answers the question a DM actually has', () => {
    // Goblins at 50 XP. Six are 300 doubled to 600, exactly medium; seven are
    // 350 at x2.5 - 875, still medium - and eight reach 1000, which is hard.
    expect(howManyFit(50, party, 'medium')).toBe(7);
  });

  it('counts up rather than dividing, since the multiplier moves', () => {
    // Ten goblins are 500 at x2.5, or 1250: hard, and under a deadly 1600.
    // Eleven cross into x3 and jump straight to 1650, which is deadly. Dividing
    // a threshold by a multiplier chosen from the answer cannot find that step;
    // it is only visible by walking up through it.
    expect(howManyFit(50, party, 'hard')).toBe(10);
  });

  it('says none when even one is already worse than asked for', () => {
    // A creature worth 2000 XP is deadly on its own to a party this size.
    expect(howManyFit(2000, party, 'medium')).toBe(0);
  });

  it('never suggests more than the cap', () => {
    expect(howManyFit(1, party, 'deadly', 8)).toBeLessThanOrEqual(8);
  });
});

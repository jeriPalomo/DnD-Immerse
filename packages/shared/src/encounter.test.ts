import { describe, expect, it } from 'vitest';
import {
  ENCOUNTER_THRESHOLDS,
  encounterDifficulty,
  encounterMultiplier,
  howManyFit,
  partyThresholds,
  partyBudget,
  ENCOUNTER_BUDGETS_2024,
  difficultyBands,
  speciesBonuses,
  speciesFor,
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
  const party = partyBudget([3, 3, 3, 3]);

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
  const party = partyBudget([3, 3, 3, 3]);

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

/**
 * The engine finally asks which edition it is in.
 *
 * `campaigns.ruleset` decided which compendium was imported and the rules
 * engine never read it, so every one of these numbers was the 2014 answer in
 * a 2024 campaign.
 */
describe('the 2024 encounter budget', () => {
  it('has a row for every level from 1 to 20', () => {
    for (let level = 1; level <= 20; level += 1) {
      const row = ENCOUNTER_BUDGETS_2024[level];
      expect(row.low).toBeGreaterThan(0);
      expect(row.moderate).toBeGreaterThan(row.low);
      expect(row.high).toBeGreaterThan(row.moderate);
    }
  });

  it('matches the DMG table at both ends', () => {
    expect(ENCOUNTER_BUDGETS_2024[1]).toEqual({ low: 50, moderate: 75, high: 100 });
    expect(ENCOUNTER_BUDGETS_2024[20]).toEqual({ low: 6400, moderate: 13200, high: 22000 });
  });

  it('offers three bands, and never the word deadly', () => {
    expect(difficultyBands('2024')).toEqual(['low', 'moderate', 'high']);
    expect(difficultyBands('2024')).not.toContain('deadly');
    expect(difficultyBands('2014')).toEqual(['easy', 'medium', 'hard', 'deadly']);
  });

  it('sums over the party, as 2014 does', () => {
    const party = partyBudget([3, 3, 3, 3], '2024');
    expect(party.bands).toEqual([
      { name: 'low', xp: 600 },
      { name: 'moderate', xp: 900 },
      { name: 'high', xp: 1600 },
    ]);
  });

  it('applies no multiplier for a crowd', () => {
    // The whole difference between the editions here. 2024 folded the crowd
    // allowance into the budget table, so multiplying as well counts it twice.
    for (const count of [1, 2, 5, 8, 12, 20]) {
      expect(encounterMultiplier(count, '2024')).toBe(1);
    }
    expect(encounterMultiplier(5, '2014')).toBe(2);
  });

  it('reads a fight in the words its own edition uses', () => {
    const party = partyBudget([3, 3, 3, 3], '2024');
    // Eight goblins at 50 XP each: 400 raw, 400 adjusted, under the 600 low band.
    expect(encounterDifficulty(Array(8).fill(50), party)).toEqual({
      difficulty: 'trivial',
      adjustedXp: 400,
    });
    // Sixteen of them clears low but not moderate.
    expect(encounterDifficulty(Array(16).fill(50), party).difficulty).toBe('low');
  });

  it('lets more monsters through than 2014 would, which is the point', () => {
    // Same party, same goblin, different edition. 2014 multiplies a crowd's XP
    // and tips over sooner; 2024 does not, so the same fight reads easier.
    const goblin = 50;
    const in2014 = howManyFit(goblin, partyBudget([3, 3, 3, 3], '2014'), 'medium', 30);
    const in2024 = howManyFit(goblin, partyBudget([3, 3, 3, 3], '2024'), 'moderate', 30);
    expect(in2024).toBeGreaterThan(in2014);
  });

  it('refuses a band the edition does not have', () => {
    // Asking a 2024 party for a "deadly" fight is a question with no answer,
    // and inventing one by mapping it onto "high" would be the app quietly
    // deciding the two words mean the same thing.
    expect(howManyFit(50, partyBudget([3, 3, 3, 3], '2024'), 'deadly')).toBe(0);
    expect(howManyFit(50, partyBudget([3, 3, 3, 3], '2014'), 'moderate')).toBe(0);
  });
});

describe('species ability increases moved in 2024', () => {
  it('grants what the 2014 handbook grants', () => {
    expect(speciesBonuses('Dragonborn', '2014')).toEqual({ str: 2, cha: 1 });
    expect(speciesBonuses('Dwarf')).toEqual({ con: 2 });
  });

  it('grants nothing at all in 2024', () => {
    // Not an omission: 2024 moved ability increases to the character's
    // background. Showing the 2014 chips would tell a 2024 player to add
    // numbers their own rules do not give them.
    expect(speciesBonuses('Dragonborn', '2024')).toEqual({});
    expect(speciesBonuses('Human', '2024')).toEqual({});
  });

  it('drops the half-species and adds the new ones', () => {
    expect(speciesFor('2014')).toContain('Half-Elf');
    expect(speciesFor('2024')).not.toContain('Half-Elf');
    expect(speciesFor('2024')).not.toContain('Half-Orc');
    expect(speciesFor('2024')).toContain('Goliath');
    expect(speciesFor('2024')).toContain('Orc');
  });
});

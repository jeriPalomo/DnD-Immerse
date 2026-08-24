import { describe, expect, it } from 'vitest';
import {
  battleSummary,
  combatDuration,
  combatSeconds,
  formatBattleSummary,
} from './effects.js';
import { XP_BY_CR, auditXpByCr, xpForChallengeRating, xpForMonster } from './rules5e.js';

/** Three goblins, two of them down, at 50 XP each. */
const goblins = [
  { name: 'Goblin', defeated: true, xp: 50 },
  { name: 'Goblin 2', defeated: true, xp: 50 },
  { name: 'Goblin 3', defeated: false, xp: 50 },
];

describe('how long a finished fight took', () => {
  it('counts every round that happened', () => {
    // Five rounds is thirty seconds: all five of them occurred.
    expect(combatDuration(5)).toBe(30);
    expect(combatDuration(1)).toBe(6);
  });

  it('is a different question from the running clock', () => {
    // Part-way through round 5, four rounds are behind you. Once the fight
    // ends after round 5, five rounds have been fought. Both are right, and
    // using one for the other docks every battle six seconds.
    expect(combatSeconds(5)).toBe(24);
    expect(combatDuration(5)).toBe(30);
  });

  it('never goes negative', () => {
    expect(combatDuration(0)).toBe(0);
    expect(combatDuration(-3)).toBe(0);
  });
});

describe('what the fight came to', () => {
  it('counts only the creatures that went down', () => {
    const summary = battleSummary({ rounds: 5, foes: goblins, characters: 4 });
    expect(summary.vanquished).toEqual(['Goblin', 'Goblin 2']);
    expect(summary.xpTotal).toBe(100);
  });

  it('divides the experience across the party, rounding down', () => {
    // 100 XP across three characters is 33 each, not 33.33 and not 34.
    const summary = battleSummary({ rounds: 2, foes: goblins, characters: 3 });
    expect(summary.xpEach).toBe(33);
  });

  it('has no opinion about shares when no characters are assigned', () => {
    const summary = battleSummary({ rounds: 2, foes: goblins, characters: 0 });
    expect(summary.xpEach).toBeNull();
    expect(summary.xpTotal).toBe(100);
  });

  it('counts a creature with no published XP rather than scoring it zero', () => {
    // Zero and unknown are different facts. Folding them together hands a
    // table a total that is short with nothing to say so.
    const summary = battleSummary({
      rounds: 3,
      foes: [
        { name: 'Goblin', defeated: true, xp: 50 },
        { name: "Grix's pet", defeated: true, xp: null },
      ],
      characters: 2,
    });
    expect(summary.xpTotal).toBe(50);
    expect(summary.xpUnknown).toBe(1);
    expect(summary.vanquished).toHaveLength(2);
  });

  it('reports a fight nobody won', () => {
    const summary = battleSummary({
      rounds: 4,
      foes: [{ name: 'Ogre', defeated: false, xp: 450 }],
      characters: 4,
    });
    expect(summary.vanquished).toEqual([]);
    expect(summary.xpTotal).toBe(0);
  });
});

describe('the summary as the table reads it', () => {
  it('leads with the duration and names the kills', () => {
    const text = formatBattleSummary(battleSummary({ rounds: 5, foes: goblins, characters: 4 }));
    expect(text).toContain('Battle Summary — 5 rounds');
    expect(text).toContain('Time elapsed: 30 seconds');
    expect(text).toContain('Enemies vanquished: Goblin, Goblin 2');
    expect(text).toContain('EXP gain: 100, 25 each across 4 characters');
  });

  it('says so when nothing was killed, rather than dropping the line', () => {
    const text = formatBattleSummary(
      battleSummary({ rounds: 2, foes: [{ name: 'Ogre', defeated: false, xp: 450 }], characters: 4 }),
    );
    expect(text).toContain('Enemies vanquished: none');
    // Nothing died, so there is no experience line to argue about.
    expect(text).not.toContain('EXP gain');
  });

  it('admits the creatures it could not price', () => {
    const text = formatBattleSummary(
      battleSummary({
        rounds: 1,
        foes: [{ name: 'Something', defeated: true, xp: null }],
        characters: 2,
      }),
    );
    expect(text).toContain('with no published XP');
  });

  /**
   * The elapsed time is the fight's, in the world - eighteen seconds for three
   * rounds. How long it took at the table was a second duration for one fight,
   * answering a question nobody asks, so it is gone.
   */
  it('times the fight in the world and never at the table', () => {
    const summary = battleSummary({ rounds: 3, foes: goblins, characters: 4 });
    const text = formatBattleSummary(summary);
    expect(text).toContain('Time elapsed: 18 seconds');
    expect(text).not.toContain('at the table');
  });

  it('is written as lines, because it is separate facts', () => {
    const text = formatBattleSummary(battleSummary({ rounds: 5, foes: goblins, characters: 4 }));
    expect(text.split(String.fromCharCode(10))).toHaveLength(4);
  });
});

describe('experience by challenge rating', () => {
  it('reads the handbook for the ratings a party actually meets', () => {
    expect(xpForChallengeRating('1/4')).toBe(50);
    expect(xpForChallengeRating('1')).toBe(200);
    expect(xpForChallengeRating('5')).toBe(1800);
    expect(xpForChallengeRating('24')).toBe(62000);
  });

  it('answers null for a rating nobody wrote', () => {
    // Not zero: an NPC with no CR is worth an unknown amount, which is a
    // different fact from being worth nothing.
    expect(xpForChallengeRating('')).toBeNull();
    expect(xpForChallengeRating(null)).toBeNull();
    expect(xpForChallengeRating(undefined)).toBeNull();
    expect(xpForChallengeRating('banana')).toBeNull();
  });

  it('covers every rating from 0 to 30, fractions included', () => {
    expect(Object.keys(XP_BY_CR)).toHaveLength(34);
    for (const cr of ['0', '1/8', '1/4', '1/2', ...Array.from({ length: 30 }, (_, i) => String(i + 1))]) {
      expect(XP_BY_CR[cr], `CR ${cr}`).toBeGreaterThan(0);
    }
  });

  it('rises with the rating, which is the one shape it must have', () => {
    const order = ['0', '1/8', '1/4', '1/2', ...Array.from({ length: 30 }, (_, i) => String(i + 1))];
    for (let i = 1; i < order.length; i += 1) {
      expect(XP_BY_CR[order[i]!], `CR ${order[i]}`).toBeGreaterThan(XP_BY_CR[order[i - 1]!]!);
    }
  });
});

describe('auditing the table against the compendium', () => {
  it('matches a rating the published monsters agree with', () => {
    const audit = auditXpByCr([{ name: 'Goblin', challengeRating: '1/4', xp: 50 }]);
    expect(audit.matched).toContain('1/4');
    expect(audit.disagreed).toEqual([]);
  });

  it('names a rating the compendium disagrees with, and what it says', () => {
    const audit = auditXpByCr([{ name: 'Goblin', challengeRating: '1/4', xp: 999 }]);
    expect(audit.disagreed).toEqual([
      { cr: '1/4', ours: 50, published: 999, example: 'Goblin', disagreeing: 1, total: 1 },
    ]);
  });

  it('reports a rating nothing is published at as unchecked, not as passing', () => {
    // The distinction is the whole point: "nothing disagreed" and "nothing
    // was compared" are not the same result.
    const audit = auditXpByCr([{ name: 'Goblin', challengeRating: '1/4', xp: 50 }]);
    expect(audit.unchecked).toContain('30');
    expect(audit.matched).not.toContain('30');
  });

  it('ignores a monster the compendium published no XP for', () => {
    const audit = auditXpByCr([{ name: 'Awkward', challengeRating: '5', xp: 0 }]);
    expect(audit.unchecked).toContain('5');
    expect(audit.disagreed).toEqual([]);
  });
});

describe('what a creature is worth', () => {
  it('takes the rating over the compendium column', () => {
    // The real case this exists for: the dataset publishes a Brass Dragon
    // Wyrmling at CR 1 for 100 XP, which is the figure for CR 1/2. The
    // handbook's table is definitional, so it wins.
    expect(xpForMonster({ challengeRating: '1', publishedXp: 100 })).toBe(200);
  });

  it('falls back to the published column when the rating says nothing', () => {
    expect(xpForMonster({ challengeRating: '', publishedXp: 1234 })).toBe(1234);
    expect(xpForMonster({ challengeRating: null, publishedXp: 1234 })).toBe(1234);
  });

  it('is unknown when neither has anything to say', () => {
    expect(xpForMonster({ challengeRating: '', publishedXp: 0 })).toBeNull();
    expect(xpForMonster({})).toBeNull();
  });

  it('counts how many published monsters disagree, not just that one does', () => {
    const audit = auditXpByCr([
      { name: 'Brass Dragon Wyrmling', challengeRating: '1', xp: 100 },
      { name: 'Animated Armor', challengeRating: '1', xp: 200 },
      { name: 'Bugbear', challengeRating: '1', xp: 200 },
    ]);
    expect(audit.disagreed[0]).toMatchObject({ cr: '1', disagreeing: 1, total: 3, ours: 200 });
  });
});

import { describe, expect, it } from 'vitest';
import {
  applyRest,
  hitDiceRegained,
  parseHitDicePool,
  periodsRestoredBy,
  type RestActor,
  type RestFeature,
} from './rest.js';

const fighter: RestActor = {
  level: 5,
  hpCurrent: 12,
  hpMax: 47,
  hpTemp: 5,
  hitDiceTotal: '5d10',
  hitDiceUsed: 3,
  spellSlots: { max: [4, 3, 2, 0, 0, 0, 0, 0, 0], used: [4, 1, 2, 0, 0, 0, 0, 0, 0] },
};

function feature(name: string, per: RestFeature['uses'] extends null ? never : 'short' | 'long' | 'day', value = 0, max = 2): RestFeature {
  return { id: name, name, uses: { value, max, per } };
}

describe('parseHitDicePool', () => {
  it('reads a pool string', () => {
    expect(parseHitDicePool('5d10')).toEqual({ count: 5, die: 10 });
    expect(parseHitDicePool('11d8')).toEqual({ count: 11, die: 8 });
  });

  it('survives a malformed pool', () => {
    expect(parseHitDicePool('')).toEqual({ count: 0, die: 0 });
    expect(parseHitDicePool('lots')).toEqual({ count: 0, die: 0 });
  });
});

describe('hitDiceRegained', () => {
  it('is half the total, rounded down', () => {
    // The rule people get wrong: level 5 regains 2, not 3.
    expect(hitDiceRegained(5)).toBe(2);
    expect(hitDiceRegained(4)).toBe(2);
    expect(hitDiceRegained(20)).toBe(10);
  });

  it('is never less than one for a character with any hit dice', () => {
    expect(hitDiceRegained(1)).toBe(1);
    expect(hitDiceRegained(2)).toBe(1);
  });

  it('is zero with no hit dice at all', () => {
    expect(hitDiceRegained(0)).toBe(0);
  });
});

describe('long rest', () => {
  const result = applyRest({ actor: fighter, features: [], type: 'long' });

  it('restores all hit points', () => {
    expect(result.hpCurrent).toBe(47);
  });

  it('ends temporary hit points', () => {
    // Temp HP does not survive a rest, per the PHB.
    expect(result.hpTemp).toBe(0);
  });

  it('gives back half the hit dice, rounded down', () => {
    // 5d10 total, 3 spent, regain 2 -> 1 still spent.
    expect(result.hitDiceUsed).toBe(1);
  });

  it('never pushes hit dice below zero spent', () => {
    const barely = applyRest({
      actor: { ...fighter, hitDiceUsed: 1 },
      features: [],
      type: 'long',
    });
    expect(barely.hitDiceUsed).toBe(0);
  });

  it('restores every spell slot', () => {
    expect(result.spellSlots.used).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
    // Maximums are untouched.
    expect(result.spellSlots.max).toEqual(fighter.spellSlots.max);
  });

  it('says what it did', () => {
    expect(result.summary.join(' ')).toMatch(/hit points/i);
    expect(result.summary.join(' ')).toMatch(/spell slots/i);
  });

  it('reports being already rested rather than saying nothing', () => {
    const fresh = applyRest({
      actor: { ...fighter, hpCurrent: 47, hpTemp: 0, hitDiceUsed: 0, spellSlots: { max: [4], used: [0] } },
      features: [],
      type: 'long',
    });
    expect(fresh.summary).toEqual(['Already fully rested']);
  });
});

describe('short rest', () => {
  it('heals only what the spent hit dice rolled', () => {
    const result = applyRest({
      actor: fighter,
      features: [],
      type: 'short',
      hitDiceSpent: 2,
      hitDiceHealing: 14,
    });

    expect(result.hpCurrent).toBe(26);
    expect(result.hitDiceUsed).toBe(5);
  });

  it('never heals past the maximum', () => {
    const result = applyRest({
      actor: { ...fighter, hpCurrent: 45 },
      features: [],
      type: 'short',
      hitDiceSpent: 1,
      hitDiceHealing: 30,
    });
    expect(result.hpCurrent).toBe(47);
  });

  it('cannot spend more hit dice than remain', () => {
    // 5 total, 3 already spent, so only 2 are available however many are asked for.
    const result = applyRest({
      actor: fighter,
      features: [],
      type: 'short',
      hitDiceSpent: 99,
      hitDiceHealing: 10,
    });
    expect(result.hitDiceUsed).toBe(5);
  });

  it('leaves spell slots alone', () => {
    const result = applyRest({ actor: fighter, features: [], type: 'short', hitDiceSpent: 0 });
    expect(result.spellSlots.used).toEqual(fighter.spellSlots.used);
  });

  it('still ends temporary hit points', () => {
    expect(applyRest({ actor: fighter, features: [], type: 'short' }).hpTemp).toBe(0);
  });
});

describe('limited-use features', () => {
  const shortFeature = feature('Second Wind', 'short');
  const longFeature = feature('Action Surge', 'long');
  const dailyFeature = feature('Bardic Inspiration', 'day');

  it('a short rest restores short-rest features only', () => {
    const result = applyRest({
      actor: fighter,
      features: [shortFeature, longFeature, dailyFeature],
      type: 'short',
    });
    expect(result.restored.map((r) => r.name)).toEqual(['Second Wind']);
  });

  it('a long rest restores everything shorter than itself too', () => {
    const result = applyRest({
      actor: fighter,
      features: [shortFeature, longFeature, dailyFeature],
      type: 'long',
    });
    expect(result.restored.map((r) => r.name).sort()).toEqual([
      'Action Surge',
      'Bardic Inspiration',
      'Second Wind',
    ]);
  });

  it('ignores features already at full uses', () => {
    const full = feature('Second Wind', 'short', 2, 2);
    expect(applyRest({ actor: fighter, features: [full], type: 'short' }).restored).toEqual([]);
  });

  it('ignores features with no uses at all', () => {
    const passive: RestFeature = { id: 'x', name: 'Darkvision', uses: null };
    expect(applyRest({ actor: fighter, features: [passive], type: 'long' }).restored).toEqual([]);
  });

  it('restores to the maximum, not by one', () => {
    const drained = feature('Channel Divinity', 'short', 0, 3);
    const result = applyRest({ actor: fighter, features: [drained], type: 'short' });
    expect(result.restored[0].to).toBe(3);
  });
});

describe('periodsRestoredBy', () => {
  it('does not let a short rest refresh long-rest features', () => {
    expect(periodsRestoredBy('short')).not.toContain('long');
    expect(periodsRestoredBy('short')).not.toContain('day');
  });

  it('lets a long rest refresh short-rest features', () => {
    expect(periodsRestoredBy('long')).toContain('short');
  });

  it('never refreshes charges, which recharge on their own schedule', () => {
    expect(periodsRestoredBy('long')).not.toContain('charges');
    expect(periodsRestoredBy('short')).not.toContain('charges');
  });
});

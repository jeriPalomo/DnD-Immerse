import { describe, expect, it } from 'vitest';
import { POTION_HEALING, auditPotionHealing } from './rules5e.js';

/**
 * The table is checked against the data, never against itself. Looking its own
 * keys up in itself proves the lookup works and nothing about whether a key
 * matches a real item - which is exactly how a spell entry once sat matching
 * nothing for a whole commit.
 */
describe('the curated potion table', () => {
  it('reports an entry that matches no compendium item', () => {
    const audit = auditPotionHealing([
      { id: 'potion-of-healing-common', name: 'Potion of Healing', description: 'You regain 2d4 + 2 hit points.' },
    ]);
    expect(audit.matched).toEqual(['potion-of-healing-common']);
    expect(audit.missing).toContain('potion-of-healing-greater');
  });

  it('is keyed by id, because two SRD items share the name "Potion of Healing"', () => {
    // 5.1 carries the common 2d4+2 flask and a generic entry that only points
    // at the rarity table. Keyed by name, one would have stamped its dice onto
    // the other; the generic entry is deliberately not in the table at all.
    expect(POTION_HEALING['potion-of-healing']).toBeUndefined();
    expect(POTION_HEALING['potion-of-healing-common']).toBe('2d4+2');
  });

  it('flags a match whose text never mentions hit points', () => {
    // A smell test, not a parser. The 2024 dataset letter-spaces its prose
    // ("H i t   P o i n t"), which is exactly what this is meant to surface.
    const audit = auditPotionHealing([
      { id: 'potion-of-healing-common', name: 'Potion of Healing', description: 'Tastes of elderberries.' },
    ]);
    expect(audit.suspicious).toEqual(['potion-of-healing-common']);
  });

  it('holds only dice expressions the roller can read', () => {
    for (const [id, dice] of Object.entries(POTION_HEALING)) {
      expect(dice, id).toMatch(/^\d+d\d+(\+\d+)?$/);
    }
  });

  it('scales with the potion, which is the one thing a typo would break', () => {
    // A transposed digit here is invisible at the table until someone drinks a
    // supreme potion and heals less than a basic one.
    const roll = (d: string) => {
      const [, count, sides, bonus] = /^(\d+)d(\d+)(?:\+(\d+))?$/.exec(d)!;
      return Number(count) * Number(sides) + Number(bonus ?? 0);
    };
    expect(roll(POTION_HEALING['potion-of-healing-greater'])).toBeGreaterThan(
      roll(POTION_HEALING['potion-of-healing-common']),
    );
    expect(roll(POTION_HEALING['potion-of-healing-superior'])).toBeGreaterThan(
      roll(POTION_HEALING['potion-of-healing-greater']),
    );
    expect(roll(POTION_HEALING['potion-of-healing-supreme'])).toBeGreaterThan(
      roll(POTION_HEALING['potion-of-healing-superior']),
    );
  });
});

import { describe, expect, it } from 'vitest';
import { attackExpression, damageExpression } from '@dnd/shared';
import { itemsFromMonster, reachFromDescription } from './monsterItems.js';

/** The goblin, as the SRD publishes it. STR 8 (-1), scimitar +4, 1d6+2. */
const GOBLIN = {
  actions: [
    {
      name: 'Scimitar',
      attack_bonus: 4,
      damage: [{ damage_type: { name: 'Slashing' }, damage_dice: '1d6+2' }],
      desc: 'Melee Weapon Attack: +4 to hit, reach 5 ft., one target. Hit: 5 (1d6 + 2) slashing damage.',
    },
    {
      name: 'Shortbow',
      attack_bonus: 4,
      damage: [{ damage_type: { name: 'Piercing' }, damage_dice: '1d6+2' }],
      desc: 'Ranged Weapon Attack: +4 to hit, range 80/320 ft., one target. Hit: 5 (1d6 + 2) piercing damage.',
    },
  ],
  special_abilities: [{ name: 'Nimble Escape', desc: 'Disengage or Hide as a bonus action.' }],
};

const scores = (str: number) => ({ str, dex: 10, con: 10, int: 10, wis: 10, cha: 10 });

describe('a stamped monster can be swung', () => {
  it('reproduces the published attack bonus exactly, whatever the ability modifier is', () => {
    const [scimitar] = itemsFromMonster(GOBLIN, 8);

    // The whole point: +4 on the card, +4 out of the dice engine. The engine
    // adds the actor's STR modifier and proficiency, so the item has to cancel
    // both - a monster's numbers include proficiency its stat line never states.
    expect(attackExpression(scimitar.system as never, scores(8), 1)).toBe('1d20+4');
  });

  it('holds for a creature whose modifier is large and positive', () => {
    // Adult Red Dragon: STR 27 (+8), bite +14.
    const dragon = {
      actions: [{
        name: 'Bite',
        attack_bonus: 14,
        damage: [{ damage_type: { name: 'Piercing' }, damage_dice: '2d10+8' }],
        desc: 'Melee Weapon Attack: +14 to hit, reach 10 ft., one target.',
      }],
    };
    const [bite] = itemsFromMonster(dragon, 27);
    expect(attackExpression(bite.system as never, scores(27), 1)).toBe('1d20+14');
    expect(damageExpression(bite.system as never, scores(27))).toBe('2d10+8');
  });

  it('leaves the published damage dice exactly as written', () => {
    const [scimitar] = itemsFromMonster(GOBLIN, 8);
    // `damage_dice` already carries its flat bonus, so nothing may be added on.
    expect(damageExpression(scimitar.system as never, scores(8))).toBe('1d6+2');
  });

  it('doubles only the dice on a critical, never the flat bonus', () => {
    const [scimitar] = itemsFromMonster(GOBLIN, 8);
    expect(damageExpression(scimitar.system as never, scores(8), { critical: true })).toBe('2d6+2');
  });

  it('carries reach and range bands off the published sentence', () => {
    const [scimitar, shortbow] = itemsFromMonster(GOBLIN, 8);
    expect(scimitar.system.range).toEqual({ type: 'ranged', value: 5, long: null });
    expect(shortbow.system.range).toEqual({ type: 'ranged', value: 80, long: 320 });
  });

  it('never files a melee reach as touch, which the target panel would clamp to 5 ft', () => {
    expect(reachFromDescription('Melee Weapon Attack: +14 to hit, reach 10 ft.')).toEqual({
      type: 'ranged', value: 10, long: null,
    });
  });

  it('prefers the thrown band over the reach, so an adjacent throw is still legal', () => {
    expect(reachFromDescription('Melee or Ranged Weapon Attack: reach 5 ft. or range 20/60 ft.')).toEqual({
      type: 'ranged', value: 20, long: 60,
    });
  });

  it('keeps traits and legendary actions as features, not as attacks', () => {
    const items = itemsFromMonster(GOBLIN, 8);
    const nimble = items.find((i) => i.name === 'Nimble Escape');
    expect(nimble?.type).toBe('feature');
    expect(items.filter((i) => i.type === 'weapon')).toHaveLength(2);
  });

  it('refuses to invent numbers for an action the SRD did not publish them for', () => {
    // Multiattack has no attack bonus; a breath weapon has a DC rather than
    // one, and its save DC is published, not derivable from the NPC's sheet -
    // offering a save button would compare against a confidently wrong number.
    const dragon = {
      actions: [
        { name: 'Multiattack', desc: 'The dragon makes three attacks.' },
        {
          name: 'Fire Breath',
          dc: { dc_type: { index: 'dex' }, dc_value: 21, success_type: 'half' },
          damage: [{ damage_type: { name: 'Fire' }, damage_dice: '18d6' }],
          desc: 'Each creature in a 60-foot cone must make a DC 21 Dexterity saving throw.',
        },
      ],
    };
    const items = itemsFromMonster(dragon, 27);
    expect(items.every((i) => i.type === 'feature')).toBe(true);
    // The published DC survives in the prose the DM reads.
    expect(String(items[1].system.description)).toContain('DC 21');
  });
});

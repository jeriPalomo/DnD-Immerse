import { describe, expect, it } from 'vitest';
import { evaluateOptions } from './TargetPanel.js';
import type { WireScene, WireToken } from '@dnd/shared';
import type { Actor, Item } from '../../store/sheet.js';

/**
 * The action panel's legality rules.
 *
 * The reason strings are asserted, not just the boolean: telling a player
 * "out of range — 30 ft away, reach 5 ft" is the feature. Silently hiding the
 * option would pass a boolean-only test while making the app feel arbitrary.
 */

const scene = { feetPerSquare: 5 } as WireScene;

function token(over: Partial<WireToken>): WireToken {
  return {
    id: 'x', sceneId: 's', name: '', imageUrl: null,
    x: 0, y: 0, w: 1, h: 1, rotation: 0, layer: 'token',
    ownerUserId: null, actorId: null, actorLinked: false, disposition: 'hostile',
    visionRange: 0, darkvisionRange: 0, lightBright: 0, lightDim: 0, lightColor: '#ffb46b',
    hp: null, maxHp: null, ac: null, conditions: [], effects: [], hidden: false, locked: false,
    ...over,
  };
}

function item(type: 'weapon' | 'spell', name: string, system: Record<string, unknown>): Item {
  return { id: name, ownerActorId: 'a', type, name, imageUrl: null, system, sortOrder: 0 };
}

const wizard = {
  spellSlots: { max: [4, 3, 2, 0, 0, 0, 0, 0, 0], used: [0, 0, 2, 0, 0, 0, 0, 0, 0] },
} as Actor;

const longsword = item('weapon', 'Longsword', {
  damageDice: '1d8',
  range: { type: 'touch', value: 5, long: null },
});
const longbow = item('weapon', 'Longbow', {
  damageDice: '1d8',
  range: { type: 'ranged', value: 150, long: 600 },
});
const fireball = item('spell', 'Fireball', {
  level: 3,
  damageDice: '8d6',
  range: { type: 'ranged', value: 150, long: null },
});
const magicMissile = item('spell', 'Magic Missile', {
  level: 1,
  damageDice: '3d4',
  range: { type: 'ranged', value: 120, long: null },
});
const shield = item('spell', 'Shield', {
  level: 1,
  range: { type: 'self', value: 0, long: null },
});

function optionsFor(self: WireToken, target: WireToken, items: Item[], actor: Actor | null = wizard) {
  const result = evaluateOptions({ items, actor, self, target, scene });
  return new Map(result.map((o) => [o.item.name, o]));
}

describe('melee reach', () => {
  it('allows a melee attack on an adjacent creature', () => {
    const options = optionsFor(token({ x: 0, y: 0 }), token({ x: 1, y: 0 }), [longsword]);
    expect(options.get('Longsword')?.legal).toBe(true);
  });

  it('refuses a melee attack two squares away, and says why', () => {
    const options = optionsFor(token({ x: 0, y: 0 }), token({ x: 3, y: 0 }), [longsword]);
    const sword = options.get('Longsword');

    expect(sword?.legal).toBe(false);
    expect(sword?.reason).toBe('Out of range — 15 ft away, reach 5 ft');
  });

  it('allows melee against a Gargantuan dragon you are touching', () => {
    // The case that centre-to-centre measurement gets wrong: a PC pressed
    // against the flank of a 4x4 dragon is 5 ft away, not 25.
    const dragon = token({ x: 0, y: 0, w: 4, h: 4, name: 'Ancient Red Dragon' });
    const pc = token({ x: 4, y: 1 });

    const options = optionsFor(pc, dragon, [longsword]);
    expect(options.get('Longsword')?.legal).toBe(true);
    expect(options.get('Longsword')?.reason).toBe('5 ft away');
  });
});

describe('ranged weapons', () => {
  it('is legal within normal range', () => {
    const options = optionsFor(token({ x: 0, y: 0 }), token({ x: 10, y: 0 }), [longbow]);
    expect(options.get('Longbow')?.legal).toBe(true);
  });

  it('allows long range but flags the disadvantage', () => {
    // 40 squares = 200 ft: beyond 150 normal, inside 600 long.
    const options = optionsFor(token({ x: 0, y: 0 }), token({ x: 40, y: 0 }), [longbow]);
    const bow = options.get('Longbow');

    expect(bow?.legal).toBe(true);
    expect(bow?.longRange).toBe(true);
    expect(bow?.reason).toMatch(/long range .* disadvantage/i);
  });

  it('refuses beyond long range', () => {
    const options = optionsFor(token({ x: 0, y: 0 }), token({ x: 200, y: 0 }), [longbow]);
    expect(options.get('Longbow')?.legal).toBe(false);
  });
});

describe('spell slots', () => {
  it('refuses a spell whose slots are spent, naming the level', () => {
    // The wizard has 2 third-level slots and has used both.
    const options = optionsFor(token({ x: 0, y: 0 }), token({ x: 2, y: 0 }), [fireball]);
    const spell = options.get('Fireball');

    expect(spell?.legal).toBe(false);
    expect(spell?.reason).toBe('No 3rd-level slots remaining');
  });

  it('allows a spell with slots remaining', () => {
    const options = optionsFor(token({ x: 0, y: 0 }), token({ x: 2, y: 0 }), [magicMissile]);
    expect(options.get('Magic Missile')?.legal).toBe(true);
  });

  it('treats cantrips as always available', () => {
    const cantrip = item('spell', 'Fire Bolt', {
      level: 0,
      damageDice: '1d10',
      range: { type: 'ranged', value: 120, long: null },
    });
    const empty = { spellSlots: { max: [0, 0, 0, 0, 0, 0, 0, 0, 0], used: [0, 0, 0, 0, 0, 0, 0, 0, 0] } } as Actor;

    const options = optionsFor(token({ x: 0, y: 0 }), token({ x: 2, y: 0 }), [cantrip], empty);
    expect(options.get('Fire Bolt')?.legal).toBe(true);
  });
});

describe('self-only spells', () => {
  it('cannot be aimed at another creature', () => {
    const options = optionsFor(token({ x: 0, y: 0 }), token({ x: 1, y: 0 }), [shield]);
    const spell = options.get('Shield');

    expect(spell?.legal).toBe(false);
    expect(spell?.reason).toBe('Affects only you');
  });
});

describe('ordering', () => {
  it('lists legal options before illegal ones', () => {
    const result = evaluateOptions({
      items: [shield, longsword, fireball, magicMissile],
      actor: wizard,
      self: token({ x: 0, y: 0 }),
      target: token({ x: 1, y: 0 }),
      scene,
    });

    const firstIllegal = result.findIndex((o) => !o.legal);
    const lastLegal = result.map((o) => o.legal).lastIndexOf(true);
    expect(lastLegal).toBeLessThan(firstIllegal);
  });

  it('ignores items that are neither weapons nor spells', () => {
    const rations = item('weapon', 'Rations', {}) as Item;
    (rations as { type: string }).type = 'equipment';

    const result = evaluateOptions({
      items: [rations, longsword],
      actor: wizard,
      self: token({ x: 0, y: 0 }),
      target: token({ x: 1, y: 0 }),
      scene,
    });
    expect(result.map((o) => o.item.name)).toEqual(['Longsword']);
  });
});

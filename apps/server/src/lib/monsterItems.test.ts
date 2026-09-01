import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { attackExpression, CONDITIONS, damageExpression } from '@dnd/shared';
import {
  DAMAGE_TYPES,
  itemsFromMonster,
  modifierNotes,
  modifiersFromMonster,
  reachFromDescription,
} from './monsterItems.js';

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

/* --------------------------------------------- damage and condition modifiers */

describe('what a stat block says a creature shrugs off', () => {
  it('keeps a bare damage type', () => {
    const m = modifiersFromMonster({ damage_immunities: ['fire'] });
    expect(m.immunities).toEqual(['fire']);
    expect(m.qualified).toEqual([]);
  });

  it('sorts each field into its own list', () => {
    const m = modifiersFromMonster({
      damage_resistances: ['cold'],
      damage_vulnerabilities: ['thunder'],
      damage_immunities: ['poison'],
    });
    expect(m.resistances).toEqual(['cold']);
    expect(m.vulnerabilities).toEqual(['thunder']);
    expect(m.immunities).toEqual(['poison']);
  });

  it('refuses a qualified line rather than guessing at it', () => {
    // The whole reason this parser is strict. Read as flat resistance to three
    // physical types, this would halve every hit from a magic sword too - the
    // app being confidently wrong, which is worse than it being silent.
    const m = modifiersFromMonster({
      damage_resistances: ["bludgeoning, piercing, and slashing from nonmagical weapons that aren't silvered"],
    });
    expect(m.resistances).toEqual([]);
    expect(m.qualified).toHaveLength(1);
    expect(m.qualified[0].field).toBe('resistances');
  });

  it('keeps the bare types and refuses the prose in the same field', () => {
    const m = modifiersFromMonster({
      damage_resistances: ['fire', 'bludgeoning, piercing, and slashing from nonmagical weapons'],
    });
    expect(m.resistances).toEqual(['fire']);
    expect(m.qualified).toHaveLength(1);
  });

  it('reads condition immunities off their index', () => {
    const m = modifiersFromMonster({
      condition_immunities: [{ index: 'poisoned', name: 'Poisoned' }, { index: 'charmed', name: 'Charmed' }],
    });
    expect(m.conditionImmunities).toEqual(['poisoned', 'charmed']);
  });

  it('survives a monster that declares none of it', () => {
    const m = modifiersFromMonster({});
    expect(m).toEqual({
      resistances: [], vulnerabilities: [], immunities: [], conditionImmunities: [], qualified: [],
    });
  });

  it('turns a refused line into a feature that names the kind of modifier', () => {
    const notes = modifierNotes(
      modifiersFromMonster({ damage_immunities: ['piercing from magic weapons wielded by good creatures'] }),
    );
    expect(notes).toHaveLength(1);
    expect(notes[0].type).toBe('feature');
    expect(notes[0].name).toMatch(/^Immune to: piercing from magic weapons/);
    expect(String(notes[0].system.description)).toMatch(/applied by hand/i);
  });
});

/**
 * Against the compendium, not against itself.
 *
 * A curated set checked only by its own keys proves the lookup works and
 * nothing about whether it matches anything real - the mistake
 * `SPELL_CONDITIONS` made for a whole commit. This reads the dataset the
 * import actually consumes.
 */
describe('the parser against the published bestiary', () => {
  const file = path.join(process.cwd(), 'data', 'srd', '2014-5e-SRD-Monsters.json');
  const monsters: Record<string, any>[] = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, 'utf8'))
    : [];

  it.skipIf(monsters.length === 0)('imports a type for half the bestiary and invents nothing', () => {
    let withType = 0;
    let proseOnly = 0;
    let withCondition = 0;

    for (const monster of monsters) {
      const m = modifiersFromMonster(monster);
      const types = [...m.resistances, ...m.vulnerabilities, ...m.immunities];

      // Nothing may leave this parser that is not one of the twelve.
      for (const type of types) expect(DAMAGE_TYPES).toContain(type);

      if (types.length > 0) withType += 1;
      else if (m.qualified.length > 0) proseOnly += 1;
      if (m.conditionImmunities.length > 0) withCondition += 1;
    }

    // Measured against the real file rather than asserted from memory. If
    // upstream changes shape these numbers move, which is the point.
    expect(monsters.length).toBe(334);
    expect(withType).toBe(146);
    expect(proseOnly).toBe(19);
    expect(withCondition).toBe(92);
  });

  it.skipIf(monsters.length === 0)('publishes only condition names this app already knows', () => {
    // All thirteen index values are exact members of CONDITIONS, which is why
    // the import needs no mapping table. If that ever stops being true, an
    // unmapped name would sit in the column matching nothing.
    for (const monster of monsters) {
      for (const name of modifiersFromMonster(monster).conditionImmunities) {
        expect(CONDITIONS).toContain(name);
      }
    }
  });
});

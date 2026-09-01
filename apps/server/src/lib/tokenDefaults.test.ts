import { describe, expect, it } from 'vitest';
import { tokenDefaultsFromActor } from './tokenDefaults.js';
import type { Actor } from '../db/schema.js';

/** A fighter, as the sheet holds one. */
const fighter = {
  id: 'a1',
  name: 'Thorin',
  type: 'character',
  ownerUserId: 'u1',
  portraitUrl: '/uploads/tokens/thorin.png',
  armorClass: 18,
  hpCurrent: 40,
  hpMax: 47,
  prototypeToken: { w: 1, h: 1, actorLinked: true, disposition: 'friendly' },
} as unknown as Actor;

/** A stamped dragon: big, unlinked, hostile, and nobody's. */
const dragon = {
  id: 'a2',
  name: 'Ancient Red Dragon',
  type: 'npc',
  ownerUserId: 'dm1',
  portraitUrl: '/srd-images/dragon.png',
  armorClass: 22,
  hpCurrent: 546,
  hpMax: 546,
  prototypeToken: { w: 4, h: 4, actorLinked: false, disposition: 'hostile' },
} as unknown as Actor;

describe('what a token inherits from its sheet', () => {
  it('takes armour class and hit points', () => {
    // The whole reason this exists. Written by hand in the seed, these three
    // were simply absent, so `attackVerdict` read every swing at the demo
    // party as `unresolved` and the DM could never land one.
    const t = tokenDefaultsFromActor(fighter);
    expect(t.ac).toBe(18);
    expect(t.hp).toBe(40);
    expect(t.maxHp).toBe(47);
  });

  it('takes the name and the portrait', () => {
    const t = tokenDefaultsFromActor(fighter);
    expect(t.name).toBe('Thorin');
    expect(t.imageUrl).toBe('/uploads/tokens/thorin.png');
  });

  it('sizes a big creature from its prototype', () => {
    expect(tokenDefaultsFromActor(dragon).w).toBe(4);
    expect(tokenDefaultsFromActor(dragon).h).toBe(4);
  });

  it('reads a width of 1 as unasked-for rather than as a choice', () => {
    // 1 is the schema's default, so a caller who said nothing must still get a
    // 4x4 dragon.
    expect(tokenDefaultsFromActor(dragon, { w: 1, h: 1 }).w).toBe(4);
    // ...but an explicit 2 is a decision and survives.
    expect(tokenDefaultsFromActor(dragon, { w: 2, h: 2 }).w).toBe(2);
  });

  it('lets an explicit value win over the sheet', () => {
    // "This one is the chieftain's bodyguard on 12" is ordinary play.
    const t = tokenDefaultsFromActor(fighter, { ac: 12, hp: 5, name: 'Thorin (wounded)' });
    expect(t.ac).toBe(12);
    expect(t.hp).toBe(5);
    expect(t.name).toBe('Thorin (wounded)');
  });

  it('gives a character an owner and an NPC none', () => {
    // `isFairGame` and the DM's turn-order writer both read a null owner as
    // "a creature the DM runs". An NPC carrying its author's id would make
    // every monster on the board look like somebody's character.
    expect(tokenDefaultsFromActor(fighter).ownerUserId).toBe('u1');
    expect(tokenDefaultsFromActor(dragon).ownerUserId).toBeNull();
  });

  it('carries the prototype disposition unless one was asked for', () => {
    expect(tokenDefaultsFromActor(dragon).disposition).toBe('hostile');
    expect(tokenDefaultsFromActor(dragon, { disposition: 'friendly' }).disposition).toBe('friendly');
  });

  it('links a character token and leaves a monster unlinked', () => {
    // Five goblins from one stat block keep five independent hit point pools.
    expect(tokenDefaultsFromActor(fighter).actorLinked).toBe(true);
    expect(tokenDefaultsFromActor(dragon).actorLinked).toBe(false);
  });
});

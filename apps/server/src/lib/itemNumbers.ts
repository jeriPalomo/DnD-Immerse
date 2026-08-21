import {
  attackBonusParts,
  bonusTotal,
  damageBonusParts,
  type AbilityKey,
  type AbilityScores,
  type WireCardNumbers,
} from '@dnd/shared';
import type { Actor, Item } from '../db/schema.js';

/**
 * Whether an item is swung at something.
 *
 * Shared by the card that draws the Attack button and by the numbers printed
 * beside it: a button offered where no to-hit bonus was computed, or the
 * reverse, is two answers to one question.
 */
export function rollsToHit(item: Item): boolean {
  const s = item.system as Record<string, any>;
  if (item.type === 'weapon') return true;
  return item.type === 'spell' && Boolean(s.attackRoll);
}

/** The six ability scores off a sheet. */
export function scoresOf(actor: Actor): AbilityScores {
  return {
    str: actor.str,
    dex: actor.dex,
    con: actor.con,
    int: actor.int,
    wis: actor.wis,
    cha: actor.cha,
  };
}

/**
 * What an item will actually roll, and where each number came from.
 *
 * Every number here is derived from the sheet - the rule this codebase follows
 * for ability modifiers, save DCs and everything else - and derived numbers are
 * precisely the ones a player has no way to check. A longsword card read
 * `1d8 Slashing` and then rolled `1d10+4`: the d10 was the two-handed grip and
 * the +4 was Strength, both correct, both invisible, so the only available
 * reading was that the app was wrong.
 *
 * One function for the item card and for the stat block a player opens on
 * somebody else's creature, because two of these would drift.
 */
export function itemNumbers(item: Item, actor: Actor): WireCardNumbers | null {
  const s = item.system as Record<string, any>;
  const scores = scoresOf(actor);

  // A creature stamped from the bestiary has its numbers copied rather than
  // recomputed, so its parts are not attributable to its own sheet.
  const published = actor.type === 'npc' && Boolean(actor.srdMonsterId);
  const spell = item.type === 'spell';
  const attacks = rollsToHit(item);

  const weapon = spell
    ? { ability: actor.spellcastingAbility as AbilityKey | undefined, proficient: true }
    : s;

  const toHitParts = attacks ? attackBonusParts(weapon, scores, actor.level, { published }) : [];

  // A spell adds no ability modifier to its damage, and a published block has
  // already baked its own into `damage_dice`.
  const damageParts = s.damageDice
    ? damageBonusParts(s, scores, { published, ability: !spell })
    : [];

  if (!attacks && !s.damageDice && !s.healingDice) return null;

  return {
    toHit: attacks ? bonusTotal(toHitParts) : null,
    toHitParts,
    damageDice: String(s.damageDice ?? ''),
    damageBonus: bonusTotal(damageParts),
    damageParts,
    damageType: String(s.damageType ?? ''),
    healingDice: String(s.healingDice ?? ''),
    versatileDice: item.type === 'weapon' ? String(s.versatileDice ?? '') : '',
  };
}

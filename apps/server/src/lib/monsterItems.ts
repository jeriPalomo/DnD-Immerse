import { abilityModifier } from '@dnd/shared';

type Json = Record<string, any>;

export interface StampedItem {
  type: 'weapon' | 'feature';
  name: string;
  system: Record<string, unknown>;
}

/**
 * Reach or range, from the published sentence.
 *
 * `touch` is not used even for melee: `reachOf` in the target panel hardcodes
 * touch to 5 ft and ignores `value`, so an Adult Red Dragon's 10 ft bite would
 * silently become a 5 ft one. `ranged` is the only type that honours the
 * number, and a null `long` means no long-range disadvantage.
 *
 * A thrown weapon publishes both ("reach 5 ft. or range 20/60 ft."). The
 * ranged form wins: it still covers the adjacent square, where taking the
 * reach would refuse a legal throw.
 */
export function reachFromDescription(desc: string): { type: 'ranged'; value: number; long: number | null } {
  const text = (desc ?? '').toLowerCase();

  const banded = text.match(/range\s+(\d+)\s*\/\s*(\d+)\s*(?:ft|feet|foot)/);
  if (banded) return { type: 'ranged', value: Number(banded[1]), long: Number(banded[2]) };

  const flat = text.match(/range\s+(\d+)\s*(?:ft|feet|foot)/);
  if (flat) return { type: 'ranged', value: Number(flat[1]), long: null };

  const reach = text.match(/reach\s+(\d+)\s*(?:ft|feet|foot)/);
  if (reach) return { type: 'ranged', value: Number(reach[1]), long: null };

  return { type: 'ranged', value: 5, long: null };
}

/**
 * The items a stamped NPC needs in order to be playable.
 *
 * `from-monster` copied the hot scalars and dropped everything a creature
 * actually *does*, so a goblin arrived on the board with no scimitar: the
 * attack table was empty and the DM had to roll it by hand off a stat block
 * the app would not show them.
 *
 * **Published numbers are reproduced exactly, not recomputed.** `attackExpression`
 * adds the actor's ability modifier and proficiency, so the offsets here cancel
 * both out and leave the SRD's own `+4`: proficiency is off, the ability is
 * STR, and `attackBonus` carries whatever remains. The same trick on damage
 * lets `damage_dice` - which already includes its flat bonus, "1d6+2" - stand
 * as published. A monster's numbers are not derivable from its stat line in
 * general (they include proficiency the block never states), so copying beats
 * deriving.
 *
 * The offsets are computed against the STR the actor is stamped with. Editing
 * an NPC's STR afterwards moves its attack bonus with it, which is arguably
 * what editing a creature's strength should do.
 */
export function itemsFromMonster(data: Json, str: number): StampedItem[] {
  const mod = abilityModifier(str);
  const out: StampedItem[] = [];

  for (const action of (data.actions ?? []) as Json[]) {
    const damage = (action.damage ?? [])[0] as Json | undefined;
    const dice = damage?.damage_dice as string | undefined;

    // A weapon only where the SRD published both halves of one. Anything else -
    // Multiattack, a breath weapon, a summon - becomes a feature below rather
    // than a swingable item with invented numbers.
    if (typeof action.attack_bonus === 'number' && dice) {
      out.push({
        type: 'weapon',
        name: action.name,
        system: {
          ability: 'str',
          proficient: false,
          finesse: false,
          attackBonus: action.attack_bonus - mod,
          damageDice: dice,
          damageBonus: -mod,
          damageType: String(damage?.damage_type?.name ?? '').toLowerCase(),
          range: reachFromDescription(action.desc ?? ''),
          // Extra damage riders (a red dragon's bite carries 2d6 fire) are left
          // in the prose. The schema holds one damage type, and inventing a
          // second roll is worse than a DM reading the line.
          description: action.desc ?? '',
        },
      });
      continue;
    }

    out.push({
      type: 'feature',
      name: action.name,
      system: { source: 'Action', description: action.desc ?? '' },
    });
  }

  for (const trait of (data.special_abilities ?? []) as Json[]) {
    out.push({
      type: 'feature',
      name: trait.name,
      system: { source: 'Trait', description: trait.desc ?? '' },
    });
  }

  for (const legendary of (data.legendary_actions ?? []) as Json[]) {
    out.push({
      type: 'feature',
      name: legendary.name,
      system: { source: 'Legendary action', description: legendary.desc ?? '' },
    });
  }

  return out;
}

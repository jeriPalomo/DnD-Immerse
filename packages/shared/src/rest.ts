/**
 * Short and long rests.
 *
 * Pure, like the rest of the rules in this package: it decides what a rest
 * restores and reports it, but rolls nothing and writes nothing. Hit dice are
 * dice, so the caller rolls them on the server and passes the results in.
 */

export type RestType = 'short' | 'long';

/** How often a limited-use feature comes back. */
export type UsePeriod = 'turn' | 'round' | 'encounter' | 'short' | 'long' | 'day' | 'charges';

export interface RestActor {
  level: number;
  hpCurrent: number;
  hpMax: number;
  hpTemp: number;
  /** e.g. "5d10". */
  hitDiceTotal: string;
  hitDiceUsed: number;
  spellSlots: { max: number[]; used: number[] };
}

export interface RestFeature {
  id: string;
  name: string;
  uses: { value: number; max: number; per: UsePeriod } | null;
}

export interface RestResult {
  hpCurrent: number;
  hpTemp: number;
  hitDiceUsed: number;
  spellSlots: { max: number[]; used: number[] };
  /** Features whose uses were restored, by id. */
  restored: { id: string; name: string; to: number }[];
  /** Human-readable summary for the chat card. */
  summary: string[];
}

/** Total hit dice from a pool string like "5d10"; 0 when unparseable. */
export function parseHitDicePool(pool: string): { count: number; die: number } {
  const match = /^(\d+)d(\d+)$/i.exec((pool ?? '').trim());
  if (!match) return { count: 0, die: 0 };
  return { count: Number(match[1]), die: Number(match[2]) };
}

/**
 * Hit dice regained on a long rest: half your total, minimum one.
 *
 * Rounding down is the rule people get wrong - a level 5 character regains 2,
 * not 3 - which is exactly why this is a tested function rather than an
 * expression buried in a handler.
 */
export function hitDiceRegained(totalHitDice: number): number {
  if (totalHitDice <= 0) return 0;
  return Math.max(1, Math.floor(totalHitDice / 2));
}

/** Which use periods a rest of this kind refreshes. */
export function periodsRestoredBy(type: RestType): UsePeriod[] {
  // A long rest also clears anything shorter than itself.
  return type === 'long'
    ? ['turn', 'round', 'encounter', 'short', 'long', 'day']
    : ['turn', 'round', 'encounter', 'short'];
}

export interface RestInput {
  actor: RestActor;
  features: RestFeature[];
  type: RestType;
  /**
   * Hit points recovered from hit dice spent during a short rest, already
   * rolled by the caller. Ignored for a long rest.
   */
  hitDiceSpent?: number;
  hitDiceHealing?: number;
}

/**
 * Applies a rest, returning the new state and a summary.
 *
 * A long rest restores all hit points, half the hit dice, and every spell slot.
 * A short rest restores only what hit dice were spent on, plus short-rest
 * features. Temporary hit points end on any rest, per the PHB.
 */
export function applyRest(input: RestInput): RestResult {
  const { actor, features, type } = input;
  const pool = parseHitDicePool(actor.hitDiceTotal);

  const periods = new Set<UsePeriod>(periodsRestoredBy(type));
  const restored = features
    .filter((feature) => feature.uses && periods.has(feature.uses.per))
    .filter((feature) => feature.uses!.value < feature.uses!.max)
    .map((feature) => ({ id: feature.id, name: feature.name, to: feature.uses!.max }));

  const summary: string[] = [];

  if (type === 'long') {
    const regained = hitDiceRegained(pool.count);
    const hitDiceUsed = Math.max(0, actor.hitDiceUsed - regained);

    if (actor.hpCurrent < actor.hpMax) {
      summary.push(`Hit points ${actor.hpCurrent} → ${actor.hpMax}`);
    }
    if (regained > 0 && actor.hitDiceUsed > 0) {
      summary.push(`Hit dice ${actor.hitDiceUsed} → ${hitDiceUsed} spent`);
    }
    if (actor.spellSlots.used.some((n) => n > 0)) summary.push('All spell slots restored');
    if (restored.length > 0) summary.push(`Restored: ${restored.map((r) => r.name).join(', ')}`);
    if (summary.length === 0) summary.push('Already fully rested');

    return {
      hpCurrent: actor.hpMax,
      hpTemp: 0,
      hitDiceUsed,
      spellSlots: { max: actor.spellSlots.max, used: actor.spellSlots.max.map(() => 0) },
      restored,
      summary,
    };
  }

  const spent = Math.max(0, Math.min(input.hitDiceSpent ?? 0, pool.count - actor.hitDiceUsed));
  const healed = spent > 0 ? Math.max(0, input.hitDiceHealing ?? 0) : 0;
  const hpCurrent = Math.min(actor.hpMax, actor.hpCurrent + healed);

  if (spent > 0) {
    summary.push(`Spent ${spent} hit ${spent === 1 ? 'die' : 'dice'}, healed ${hpCurrent - actor.hpCurrent}`);
  }
  if (restored.length > 0) summary.push(`Restored: ${restored.map((r) => r.name).join(', ')}`);
  if (summary.length === 0) summary.push('Nothing to recover');

  return {
    hpCurrent,
    hpTemp: 0,
    hitDiceUsed: actor.hitDiceUsed + spent,
    spellSlots: actor.spellSlots,
    restored,
    summary,
  };
}

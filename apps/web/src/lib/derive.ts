import { conditionEffect, deriveActor, type ActiveEffect, type DerivedActor } from '@dnd/shared';
import type { WireToken } from '@dnd/shared';

/**
 * Turns a token's conditions into real changes.
 *
 * Without this, "prone" is a coloured label the DM has to remember to enforce.
 * With it, the HUD shows Speed 15 instead of 30 and says why, and the action
 * panel knows the attack is at disadvantage.
 */

export interface TokenDerived extends DerivedActor {
  /** Conditions that produced a change, for the "why" line in the UI. */
  reasons: string[];
  hasDisadvantage: boolean;
  hasAdvantage: boolean;
  incapacitated: boolean;
}

export function effectsForToken(token: Pick<WireToken, 'conditions'>): ActiveEffect[] {
  return token.conditions
    .map((condition) => conditionEffect(condition))
    .filter((effect): effect is ActiveEffect => effect !== null);
}

/**
 * Derived stats for a token, given a base speed and AC.
 *
 * Tokens carry AC but not the full ability spread, so the missing pieces are
 * filled with neutral values - the conditions we model only touch speed, AC
 * and flags, so nothing downstream depends on them.
 */
export function deriveToken(
  token: Pick<WireToken, 'conditions' | 'ac' | 'maxHp'>,
  baseSpeed = 30,
  level = 1,
): TokenDerived {
  const effects = effectsForToken(token);

  const derived = deriveActor(
    {
      str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10,
      armorClass: token.ac ?? 10,
      hpMax: token.maxHp ?? 0,
      speed: baseSpeed,
      level,
    },
    effects,
  );

  return {
    ...derived,
    reasons: derived.applied,
    hasDisadvantage: Boolean(derived.flags['flags.disadvantageOnAttacks']),
    hasAdvantage: Boolean(derived.flags['flags.advantageOnAttacks']),
    incapacitated: Boolean(derived.flags['flags.incapacitated']),
  };
}

/**
 * How an attack from `attacker` against `target` should be rolled.
 *
 * 5e cancels advantage and disadvantage against each other rather than
 * stacking them, so a prone attacker striking an invisible target rolls
 * straight - which is exactly the sort of interaction a table gets wrong.
 */
export function attackModeAgainst(
  attacker: Pick<WireToken, 'conditions' | 'ac' | 'maxHp'>,
  target: Pick<WireToken, 'conditions' | 'ac' | 'maxHp'>,
): { mode: 'normal' | 'advantage' | 'disadvantage'; reasons: string[] } {
  const self = deriveToken(attacker);
  const other = deriveToken(target);

  const reasons: string[] = [];
  let advantage = false;
  let disadvantage = false;

  if (self.hasDisadvantage) {
    disadvantage = true;
    reasons.push(`you are ${attacker.conditions.join(', ')}`);
  }
  // An invisible target is harder to hit.
  if (other.hasAdvantage) {
    disadvantage = true;
    reasons.push('target is invisible');
  }
  // A prone target is easier to hit in melee.
  if (target.conditions.includes('prone')) {
    advantage = true;
    reasons.push('target is prone');
  }
  if (target.conditions.includes('paralyzed') || target.conditions.includes('unconscious')) {
    advantage = true;
    reasons.push('target is helpless');
  }

  if (advantage && disadvantage) return { mode: 'normal', reasons: [...reasons, 'they cancel out'] };
  if (advantage) return { mode: 'advantage', reasons };
  if (disadvantage) return { mode: 'disadvantage', reasons };
  return { mode: 'normal', reasons: [] };
}

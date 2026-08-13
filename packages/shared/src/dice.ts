import { abilityModifier, proficiencyBonus, type AbilityKey, type AbilityScores } from './rules5e.js';

/**
 * Dice expression building and validation.
 *
 * Building lives here so the client can show what it is about to roll, but
 * ROLLING happens only on the server (apps/server/src/lib/dice.ts). A client
 * that generated its own numbers could trivially fudge them, and half the value
 * of a shared table is that nobody can.
 */

export type RollMode = 'normal' | 'advantage' | 'disadvantage';

/** Guards against a pasted `9999d9999` locking up the roller. */
export const DICE_LIMITS = {
  maxExpressionLength: 200,
  maxDiceCount: 100,
  maxDieSides: 1000,
} as const;

const DICE_TERM = /(\d*)[dD](\d+)/g;
/** Digits, dice, arithmetic, parens and the keep/drop/explode modifiers. */
const ALLOWED = /^[0-9dDkKhHlLrRoOeE!+\-*/%()><=,\s]+$/;

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

export function validateExpression(expression: string): ValidationResult {
  const expr = expression.trim();

  if (!expr) return { ok: false, reason: 'Enter a dice expression' };
  if (expr.length > DICE_LIMITS.maxExpressionLength) {
    return { ok: false, reason: 'Expression is too long' };
  }
  if (!ALLOWED.test(expr)) {
    return { ok: false, reason: 'Expression contains unsupported characters' };
  }

  for (const match of expr.matchAll(DICE_TERM)) {
    const count = match[1] === '' ? 1 : Number(match[1]);
    const sides = Number(match[2]);

    if (count > DICE_LIMITS.maxDiceCount) {
      return { ok: false, reason: `Too many dice (max ${DICE_LIMITS.maxDiceCount})` };
    }
    if (sides > DICE_LIMITS.maxDieSides) {
      return { ok: false, reason: `Too many sides (max ${DICE_LIMITS.maxDieSides})` };
    }
    if (sides < 1) return { ok: false, reason: 'A die needs at least one side' };
  }

  return { ok: true };
}

/** `2d20kh1` for advantage, `2d20kl1` for disadvantage. */
export function d20Expression(mode: RollMode = 'normal'): string {
  if (mode === 'advantage') return '2d20kh1';
  if (mode === 'disadvantage') return '2d20kl1';
  return '1d20';
}

export function withModifier(base: string, modifier: number): string {
  if (modifier === 0) return base;
  return modifier > 0 ? `${base}+${modifier}` : `${base}${modifier}`;
}

/* ------------------------------------------------- 5e expression builders */

export interface WeaponLike {
  ability?: AbilityKey;
  finesse?: boolean;
  proficient?: boolean;
  attackBonus?: number;
  damageDice?: string;
  damageBonus?: number;
  damageType?: string;
  versatileDice?: string;
}

/** A finesse weapon uses whichever of STR or DEX is better. */
export function weaponAbility(weapon: WeaponLike, scores: AbilityScores): AbilityKey {
  const base = weapon.ability ?? 'str';
  if (!weapon.finesse) return base;
  return abilityModifier(scores.dex) > abilityModifier(scores.str) ? 'dex' : 'str';
}

export function attackExpression(
  weapon: WeaponLike,
  scores: AbilityScores,
  level: number,
  mode: RollMode = 'normal',
): string {
  const ability = weaponAbility(weapon, scores);
  const bonus =
    abilityModifier(scores[ability]) +
    (weapon.proficient === false ? 0 : proficiencyBonus(level)) +
    (weapon.attackBonus ?? 0);

  return withModifier(d20Expression(mode), bonus);
}

/**
 * Damage. A 5e critical doubles the dice, not the flat modifier - `1d8+3`
 * becomes `2d8+3`, never `2d8+6`.
 */
export function damageExpression(
  weapon: WeaponLike,
  scores: AbilityScores,
  options: { critical?: boolean; versatile?: boolean } = {},
): string {
  const ability = weaponAbility(weapon, scores);
  const dice = (options.versatile && weapon.versatileDice) || weapon.damageDice || '1d4';
  const bonus = abilityModifier(scores[ability]) + (weapon.damageBonus ?? 0);

  return withModifier(options.critical ? doubleDice(dice) : dice, bonus);
}

/** `8d6` -> `16d6`. Applies to every dice term in the expression. */
export function doubleDice(dice: string): string {
  return dice.replace(DICE_TERM, (_all, count: string, sides: string) => {
    const n = count === '' ? 1 : Number(count);
    return `${n * 2}d${sides}`;
  });
}

export function savingThrowExpression(
  scores: AbilityScores,
  level: number,
  ability: AbilityKey,
  proficient: boolean,
  mode: RollMode = 'normal',
): string {
  const bonus = abilityModifier(scores[ability]) + (proficient ? proficiencyBonus(level) : 0);
  return withModifier(d20Expression(mode), bonus);
}

export function initiativeExpression(scores: AbilityScores, mode: RollMode = 'normal'): string {
  return withModifier(d20Expression(mode), abilityModifier(scores.dex));
}

/** Standard array generation: roll 4d6, drop the lowest. */
export const ABILITY_ROLL = '4d6dl1';

/**
 * The dice a table actually owns, for the tray's die-type picker.
 *
 * Replaced a list of fixed `1dN` presets, which could only ever roll one die at
 * a time - rolling 2d6 meant typing it out.
 */
export const DIE_TYPES = [4, 6, 8, 10, 12, 20, 100] as const;

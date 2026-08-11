import { DiceRoll } from '@dice-roller/rpg-dice-roller';
import { validateExpression, type RollResult } from '@dnd/shared';
import { HttpError } from '../auth/guards.js';

/**
 * The only place dice are rolled.
 *
 * Rolling is server-side and non-negotiable: a client that generated its own
 * numbers could fudge every attack, and a shared table where nobody can cheat
 * is most of the point.
 */

interface RollEntry {
  value: number;
  useInTotal: boolean;
}

/** Pulls individual die faces out of the library's nested result structure. */
function extractDice(roll: DiceRoll): RollEntry[] {
  const out: RollEntry[] = [];

  for (const group of roll.rolls as unknown[]) {
    if (!group || typeof group !== 'object') continue;
    const inner = (group as { rolls?: unknown[] }).rolls;
    if (!Array.isArray(inner)) continue;

    for (const die of inner) {
      if (!die || typeof die !== 'object') continue;
      const { value, useInTotal } = die as { value?: number; useInTotal?: boolean };
      if (typeof value === 'number') {
        out.push({ value, useInTotal: useInTotal !== false });
      }
    }
  }

  return out;
}

/**
 * A natural 20 or 1 only means anything on a d20. Checking every die would
 * call a 20 on a d20+8d6 fireball a critical, which it is not.
 */
function d20Outcome(expression: string, dice: RollEntry[]): { crit: boolean; fumble: boolean } {
  if (!/\bd20\b/i.test(expression)) return { crit: false, fumble: false };

  // Only kept dice count: with advantage the dropped die is not the result.
  const kept = dice.filter((d) => d.useInTotal).map((d) => d.value);
  return { crit: kept.includes(20), fumble: kept.includes(1) };
}

export function rollExpression(expression: string, label = ''): RollResult {
  const expr = expression.trim();

  const validation = validateExpression(expr);
  if (!validation.ok) throw new HttpError(400, validation.reason ?? 'Invalid dice expression');

  let roll: DiceRoll;
  try {
    roll = new DiceRoll(expr);
  } catch {
    throw new HttpError(400, `Could not understand "${expr}"`);
  }

  const dice = extractDice(roll);
  const { crit, fumble } = d20Outcome(expr, dice);

  return {
    expression: expr,
    total: Number(roll.total),
    output: roll.output,
    label,
    rolls: dice.map((d) => d.value),
    isCritical: crit,
    isFumble: fumble,
  };
}

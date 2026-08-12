/**
 * Death saving throws.
 *
 * Pure, so the awkward cases are testable: a natural 20 does not merely
 * succeed, and a natural 1 costs two failures rather than one.
 */

export interface DeathSaveState {
  successes: number;
  failures: number;
}

export interface DeathSaveOutcome extends DeathSaveState {
  /** What the roll did, for the chat line. */
  result: 'critical' | 'success' | 'failure' | 'critical-failure';
  /** True once three successes are banked. */
  stable: boolean;
  /** True once three failures are banked. */
  dead: boolean;
  /** A natural 20 brings you back up on 1 hit point. */
  revivedAtHp: number | null;
  summary: string;
}

/**
 * Applies one death saving throw.
 *
 * The rules that are easy to get wrong and are each covered by a test: a
 * natural 20 restores 1 hit point and clears the tally outright, a natural 1
 * counts as two failures, and exactly 10 succeeds.
 */
export function resolveDeathSave(roll: number, state: DeathSaveState): DeathSaveOutcome {
  const successes = Math.max(0, Math.min(3, state.successes));
  const failures = Math.max(0, Math.min(3, state.failures));

  if (roll === 20) {
    return {
      successes: 0,
      failures: 0,
      result: 'critical',
      stable: false,
      dead: false,
      revivedAtHp: 1,
      summary: 'Natural 20 — back up on 1 hit point',
    };
  }

  if (roll === 1) {
    const next = Math.min(3, failures + 2);
    return {
      successes,
      failures: next,
      result: 'critical-failure',
      stable: false,
      dead: next >= 3,
      revivedAtHp: null,
      summary: next >= 3 ? 'Natural 1 — two failures, and that is three' : 'Natural 1 — two failures',
    };
  }

  if (roll >= 10) {
    const next = Math.min(3, successes + 1);
    return {
      successes: next,
      failures,
      result: 'success',
      stable: next >= 3,
      dead: false,
      revivedAtHp: null,
      summary: next >= 3 ? `Success (${next}/3) — stable` : `Success (${next}/3)`,
    };
  }

  const next = Math.min(3, failures + 1);
  return {
    successes,
    failures: next,
    result: 'failure',
    stable: false,
    dead: next >= 3,
    revivedAtHp: null,
    summary: next >= 3 ? `Failure (${next}/3) — dead` : `Failure (${next}/3)`,
  };
}

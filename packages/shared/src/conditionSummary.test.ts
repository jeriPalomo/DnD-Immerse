import { describe, expect, it } from 'vitest';
import { CONDITIONS } from './schemas.js';
import { CONDITION_EFFECTS, CONDITION_SUMMARY, conditionIsAutomated } from './effects.js';

/**
 * A hand-written table checked against the data, not against itself. A summary
 * for a condition that does not exist helps nobody, and a condition with no
 * summary is a blank row in the reference.
 */
describe('the conditions reference', () => {
  it('explains every condition the app offers', () => {
    const missing = CONDITIONS.filter((c) => !CONDITION_SUMMARY[c]);
    expect(missing).toEqual([]);
  });

  it('has no entry for a condition that does not exist', () => {
    const stray = Object.keys(CONDITION_SUMMARY).filter(
      (c) => !(CONDITIONS as readonly string[]).includes(c),
    );
    expect(stray).toEqual([]);
  });

  it('describes every condition the engine automates', () => {
    const unexplained = Object.keys(CONDITION_EFFECTS).filter((c) => !CONDITION_SUMMARY[c]);
    expect(unexplained).toEqual([]);
  });

  it('reports automation from the effects table rather than a second list', () => {
    expect(conditionIsAutomated('restrained')).toBe(true);
    // Charmed is about who you may attack, which is intent rather than a
    // number - the DM applies it, and the reference must say so.
    expect(conditionIsAutomated('charmed')).toBe(false);
    expect(conditionIsAutomated('not-a-condition')).toBe(false);
  });
});

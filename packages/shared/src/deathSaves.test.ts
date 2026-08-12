import { describe, expect, it } from 'vitest';
import { resolveDeathSave } from './deathSaves.js';
import { CONDITION_GLYPH, MAX_TOKEN_GLYPHS, isDown, tokenBadges } from './conditions.js';

const fresh = { successes: 0, failures: 0 };

describe('resolveDeathSave', () => {
  it('succeeds on exactly 10', () => {
    // The boundary people argue about: 10 is a success, not a failure.
    const outcome = resolveDeathSave(10, fresh);
    expect(outcome.result).toBe('success');
    expect(outcome.successes).toBe(1);
  });

  it('fails below 10', () => {
    const outcome = resolveDeathSave(9, fresh);
    expect(outcome.result).toBe('failure');
    expect(outcome.failures).toBe(1);
  });

  it('stabilises on the third success', () => {
    const outcome = resolveDeathSave(15, { successes: 2, failures: 1 });
    expect(outcome.stable).toBe(true);
    expect(outcome.summary).toMatch(/stable/i);
  });

  it('kills on the third failure', () => {
    const outcome = resolveDeathSave(4, { successes: 1, failures: 2 });
    expect(outcome.dead).toBe(true);
    expect(outcome.summary).toMatch(/dead/i);
  });

  it('brings you back up on a natural 20, clearing the tally', () => {
    const outcome = resolveDeathSave(20, { successes: 1, failures: 2 });

    expect(outcome.revivedAtHp).toBe(1);
    // Not merely a success - you are conscious, and the slate is clean.
    expect(outcome.successes).toBe(0);
    expect(outcome.failures).toBe(0);
    expect(outcome.dead).toBe(false);
  });

  it('counts a natural 1 as two failures', () => {
    const outcome = resolveDeathSave(1, fresh);
    expect(outcome.failures).toBe(2);
    expect(outcome.result).toBe('critical-failure');
  });

  it('lets a natural 1 finish someone on one existing failure', () => {
    const outcome = resolveDeathSave(1, { successes: 0, failures: 1 });
    expect(outcome.failures).toBe(3);
    expect(outcome.dead).toBe(true);
  });

  it('never counts past three', () => {
    expect(resolveDeathSave(1, { successes: 0, failures: 2 }).failures).toBe(3);
    expect(resolveDeathSave(18, { successes: 2, failures: 0 }).successes).toBe(3);
  });

  it('leaves the other tally alone', () => {
    const outcome = resolveDeathSave(15, { successes: 0, failures: 2 });
    expect(outcome.failures).toBe(2);
  });
});

describe('token badges', () => {
  it('maps known conditions to glyphs', () => {
    const badges = tokenBadges(['poisoned', 'prone']);
    expect(badges.glyphs.map((b) => b.condition)).toEqual(['poisoned', 'prone']);
    expect(badges.glyphs[0].glyph).toBe(CONDITION_GLYPH.poisoned);
  });

  it('ignores anything with no glyph', () => {
    expect(tokenBadges(['bewildered']).glyphs).toEqual([]);
  });

  it('caps the ring and counts the rest', () => {
    const many = ['poisoned', 'prone', 'blinded', 'charmed', 'deafened', 'stunned', 'frightened'];
    const badges = tokenBadges(many);

    // Beyond a handful, the count is the useful information.
    expect(badges.glyphs).toHaveLength(MAX_TOKEN_GLYPHS);
    expect(badges.overflow).toBe(many.length - MAX_TOKEN_GLYPHS);
  });

  it('has no overflow for a short list', () => {
    expect(tokenBadges(['prone']).overflow).toBe(0);
  });
});

describe('isDown', () => {
  it('is true at or below zero hit points', () => {
    expect(isDown(0, 30)).toBe(true);
    expect(isDown(-5, 30)).toBe(true);
  });

  it('is false while standing', () => {
    expect(isDown(1, 30)).toBe(false);
  });

  it('is false for a token with no hit points tracked at all', () => {
    // A scenery token is not unconscious; it simply has no HP.
    expect(isDown(null, null)).toBe(false);
    expect(isDown(null, 0)).toBe(false);
  });
});

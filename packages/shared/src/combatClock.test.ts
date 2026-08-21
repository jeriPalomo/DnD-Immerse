import { describe, expect, it } from 'vitest';
import { SECONDS_PER_ROUND, combatSeconds, formatCombatTime } from './effects.js';

/**
 * Six seconds a round, and the off-by-one that matters: round 1 is the first
 * six seconds of the fight, not six seconds already spent. A party that has
 * just rolled initiative has used none.
 */
describe('how long a fight has taken', () => {
  it('is six seconds a round', () => {
    expect(SECONDS_PER_ROUND).toBe(6);
  });

  it('starts at zero', () => {
    expect(combatSeconds(1)).toBe(0);
    expect(formatCombatTime(1)).toBe('0 seconds in');
  });

  it('counts rounds already finished, not rounds reached', () => {
    expect(combatSeconds(2)).toBe(6);
    expect(combatSeconds(4)).toBe(18);
  });

  it('never goes negative, whatever it is handed', () => {
    expect(combatSeconds(0)).toBe(0);
    expect(combatSeconds(-3)).toBe(0);
  });

  it('switches to minutes once seconds stop meaning anything', () => {
    // Round 11 is ten finished rounds, which is a minute exactly.
    expect(combatSeconds(11)).toBe(60);
    expect(formatCombatTime(11)).toBe('1m 00s in');
    expect(formatCombatTime(12)).toBe('1m 06s in');
    expect(formatCombatTime(21)).toBe('2m 00s in');
  });

  it('reads as seconds right up to the minute', () => {
    expect(formatCombatTime(10)).toBe('54 seconds in');
  });
});

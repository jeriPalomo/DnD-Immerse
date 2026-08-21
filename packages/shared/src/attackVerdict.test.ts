import { describe, expect, it } from 'vitest';
import { attackVerdict } from './rules5e.js';

describe('whether an attack landed', () => {
  it('hits when the total meets the AC exactly', () => {
    // The off-by-one that decides a fight: 15 against AC 15 is a hit.
    const v = attackVerdict(15, 8, 15, 'Goblin');
    expect(v.hit).toBe(true);
    expect(v.text).toContain('HIT against Goblin (AC 15)');
  });

  it('misses one under', () => {
    const v = attackVerdict(14, 7, 15, 'Goblin');
    expect(v.hit).toBe(false);
    expect(v.text).toContain('MISS against Goblin (AC 15)');
  });

  it('a natural 20 hits whatever the AC is', () => {
    const v = attackVerdict(21, 20, 30, 'Ancient Red Dragon');
    expect(v).toMatchObject({ hit: true, critical: true });
    expect(v.text).toContain('CRITICAL HIT');
  });

  it('a natural 1 misses however high the total', () => {
    // +19 on a 1 is 20, which clears an AC of 10 - and still misses.
    const v = attackVerdict(20, 1, 10, 'Goblin');
    expect(v).toMatchObject({ hit: false, critical: false });
    expect(v.text).toContain('natural 1');
  });

  it('falls back to the total when the die is unknown', () => {
    // An expression with no d20 in it has no natural roll to read.
    expect(attackVerdict(18, undefined, 15, 'Goblin').hit).toBe(true);
    expect(attackVerdict(12, undefined, 15, 'Goblin').hit).toBe(false);
  });

  it('names the creature, so a log with two goblins in it still reads', () => {
    expect(attackVerdict(9, 4, 15, 'Goblin 2').text).toContain('Goblin 2');
  });
});

import { describe, expect, it } from 'vitest';
import {
  attackExpression,
  d20Expression,
  damageExpression,
  doubleDice,
  savingThrowExpression,
  validateExpression,
  weaponAbility,
  withModifier,
} from './dice.js';
import type { AbilityScores } from './rules5e.js';

const scores: AbilityScores = { str: 18, dex: 16, con: 14, int: 8, wis: 12, cha: 10 };

describe('validateExpression', () => {
  it('accepts ordinary notation', () => {
    for (const expr of ['1d20', '2d20kh1', '4d6dl1', '8d6', '1d8+3', '2d6+1d4-2']) {
      expect(validateExpression(expr).ok, expr).toBe(true);
    }
  });

  it('rejects an empty expression', () => {
    expect(validateExpression('   ').ok).toBe(false);
  });

  it('refuses absurd dice counts rather than hanging', () => {
    const result = validateExpression('99999d6');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/too many dice/i);
  });

  it('refuses absurd die sizes', () => {
    expect(validateExpression('1d999999').ok).toBe(false);
  });

  it('rejects anything that is not dice notation', () => {
    for (const bad of ['alert(1)', '1d20; DROP TABLE users', "__proto__"]) {
      expect(validateExpression(bad).ok, bad).toBe(false);
    }
  });
});

describe('d20Expression', () => {
  it('builds advantage and disadvantage', () => {
    expect(d20Expression('normal')).toBe('1d20');
    expect(d20Expression('advantage')).toBe('2d20kh1');
    expect(d20Expression('disadvantage')).toBe('2d20kl1');
  });
});

describe('withModifier', () => {
  it('formats sign correctly and omits a zero modifier', () => {
    expect(withModifier('1d20', 5)).toBe('1d20+5');
    expect(withModifier('1d20', -2)).toBe('1d20-2');
    expect(withModifier('1d20', 0)).toBe('1d20');
  });
});

describe('weaponAbility', () => {
  it('uses the weapon ability when not finesse', () => {
    expect(weaponAbility({ ability: 'str' }, scores)).toBe('str');
  });

  it('picks the better of STR and DEX for finesse weapons', () => {
    // STR 18 (+4) beats DEX 16 (+3).
    expect(weaponAbility({ ability: 'dex', finesse: true }, scores)).toBe('str');

    const nimble: AbilityScores = { ...scores, str: 8, dex: 20 };
    expect(weaponAbility({ ability: 'str', finesse: true }, nimble)).toBe('dex');
  });
});

describe('attackExpression', () => {
  it('adds ability modifier and proficiency', () => {
    // STR +4, proficiency +3 at level 5.
    expect(attackExpression({ ability: 'str', damageDice: '1d8' }, scores, 5)).toBe('1d20+7');
  });

  it('omits proficiency when not proficient', () => {
    expect(attackExpression({ ability: 'str', proficient: false }, scores, 5)).toBe('1d20+4');
  });

  it('includes a magic weapon bonus', () => {
    expect(attackExpression({ ability: 'str', attackBonus: 1 }, scores, 5)).toBe('1d20+8');
  });

  it('rolls advantage as 2d20kh1', () => {
    expect(attackExpression({ ability: 'str' }, scores, 5, 'advantage')).toBe('2d20kh1+7');
  });
});

describe('damageExpression', () => {
  it('adds the ability modifier to the dice', () => {
    expect(damageExpression({ ability: 'str', damageDice: '1d8' }, scores)).toBe('1d8+4');
  });

  it('uses versatile dice when two-handed', () => {
    expect(
      damageExpression({ ability: 'str', damageDice: '1d8', versatileDice: '1d10' }, scores, {
        versatile: true,
      }),
    ).toBe('1d10+4');
  });

  it('doubles only the dice on a critical, never the modifier', () => {
    // The classic mistake is 2d8+8; 5e doubles dice only.
    expect(
      damageExpression({ ability: 'str', damageDice: '1d8' }, scores, { critical: true }),
    ).toBe('2d8+4');
  });
});

describe('doubleDice', () => {
  it('doubles every dice term', () => {
    expect(doubleDice('1d8')).toBe('2d8');
    expect(doubleDice('8d6')).toBe('16d6');
    expect(doubleDice('2d6+1d4')).toBe('4d6+2d4');
  });

  it('treats a bare d6 as 1d6', () => {
    expect(doubleDice('d6')).toBe('2d6');
  });
});

describe('savingThrowExpression', () => {
  it('applies proficiency only when proficient', () => {
    expect(savingThrowExpression(scores, 5, 'con', true)).toBe('1d20+5'); // +2 CON, +3 prof
    expect(savingThrowExpression(scores, 5, 'con', false)).toBe('1d20+2');
  });
});

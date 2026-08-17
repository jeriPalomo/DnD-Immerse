import { describe, expect, it } from 'vitest';
import {
  advanceTurn,
  attackModeAgainst,
  combineRollModes,
  applyDamage,
  applyHealing,
  concentrationDC,
  concentrationSave,
  conditionEffect,
  deriveActor,
  deriveToken,
  expiredEffects,
  rewindTurn,
  sortInitiative,
  type ActiveEffect,
  type BaseActor,
} from './effects.js';

const fighter: BaseActor = {
  str: 16, dex: 14, con: 15, int: 10, wis: 12, cha: 8,
  armorClass: 16, hpMax: 45, speed: 30, level: 5,
};

function effect(name: string, changes: ActiveEffect['changes']): ActiveEffect {
  return { id: name, name, changes, disabled: false };
}

describe('deriveActor', () => {
  it('leaves the actor untouched with no effects', () => {
    const derived = deriveActor(fighter, []);
    expect(derived.ac).toBe(16);
    expect(derived.abilities.str).toBe(16);
    expect(derived.proficiencyBonus).toBe(3);
    expect(derived.applied).toEqual([]);
  });

  it('adds a flat bonus', () => {
    const shield = effect('Shield', [{ key: 'ac', mode: 'add', value: 5, priority: 20 }]);
    expect(deriveActor(fighter, [shield]).ac).toBe(21);
  });

  it('names every effect that contributed, so a total is explainable', () => {
    const derived = deriveActor(fighter, [
      effect('Shield', [{ key: 'ac', mode: 'add', value: 5, priority: 20 }]),
      effect('Ring of Protection', [{ key: 'ac', mode: 'add', value: 1, priority: 20 }]),
    ]);
    expect(derived.ac).toBe(22);
    expect(derived.applied).toEqual(['Shield', 'Ring of Protection']);
  });

  it('multiplies before adding', () => {
    // The classic ordering bug: +2 then doubled would give 36, not 34.
    const derived = deriveActor(fighter, [
      effect('Bonus', [{ key: 'ac', mode: 'add', value: 2, priority: 20 }]),
      effect('Doubled', [{ key: 'ac', mode: 'multiply', value: 2, priority: 20 }]),
    ]);
    expect(derived.ac).toBe(34);
  });

  it('lets override win outright', () => {
    const derived = deriveActor(fighter, [
      effect('Bonus', [{ key: 'ac', mode: 'add', value: 5, priority: 20 }]),
      effect('Mage Armor', [{ key: 'ac', mode: 'override', value: 13, priority: 20 }]),
    ]);
    expect(derived.ac).toBe(13);
  });

  it('treats upgrade as a floor and downgrade as a ceiling', () => {
    expect(
      deriveActor(fighter, [effect('At least 18', [{ key: 'ac', mode: 'upgrade', value: 18, priority: 20 }])]).ac,
    ).toBe(18);
    // An upgrade below the current value changes nothing.
    expect(
      deriveActor(fighter, [effect('At least 10', [{ key: 'ac', mode: 'upgrade', value: 10, priority: 20 }])]).ac,
    ).toBe(16);
    expect(
      deriveActor(fighter, [effect('At most 12', [{ key: 'ac', mode: 'downgrade', value: 12, priority: 20 }])]).ac,
    ).toBe(12);
  });

  it('ignores disabled effects', () => {
    const off = { ...effect('Shield', [{ key: 'ac', mode: 'add' as const, value: 5, priority: 20 }]), disabled: true };
    expect(deriveActor(fighter, [off]).ac).toBe(16);
  });

  it('sets boolean changes as flags rather than numbers', () => {
    const derived = deriveActor(fighter, [
      effect('Prone', [{ key: 'flags.disadvantageOnAttacks', mode: 'override', value: true, priority: 20 }]),
    ]);
    expect(derived.flags['flags.disadvantageOnAttacks']).toBe(true);
  });

  it('modifies ability scores', () => {
    const derived = deriveActor(fighter, [
      effect('Belt of Giant Strength', [{ key: 'abilities.str', mode: 'override', value: 21, priority: 20 }]),
    ]);
    expect(derived.abilities.str).toBe(21);
    // Untouched abilities are unaffected.
    expect(derived.abilities.dex).toBe(14);
  });
});

describe('conditions as effects', () => {
  it('halves speed and imposes disadvantage when prone', () => {
    const prone = conditionEffect('prone')!;
    const derived = deriveActor(fighter, [prone]);

    expect(derived.speed).toBe(15);
    expect(derived.flags['flags.disadvantageOnAttacks']).toBe(true);
  });

  it('stops movement entirely when restrained', () => {
    const derived = deriveActor(fighter, [conditionEffect('restrained')!]);
    expect(derived.speed).toBe(0);
  });

  it('returns null for something that is not a condition', () => {
    expect(conditionEffect('bewildered')).toBeNull();
  });
});

describe('applyDamage', () => {
  const target = { hp: 40, maxHp: 45 };

  it('subtracts damage normally', () => {
    const result = applyDamage(target, 12, 'slashing');
    expect(result.applied).toBe(12);
    expect(result.hpAfter).toBe(28);
    expect(result.reason).toBe('normal');
  });

  it('halves resistant damage, rounding down', () => {
    const result = applyDamage(target, 13, 'fire', { resistances: ['fire'], vulnerabilities: [], immunities: [] });
    // 13 halved is 6, not 6.5 and not 7.
    expect(result.applied).toBe(6);
    expect(result.reason).toBe('resistant');
  });

  it('doubles vulnerable damage', () => {
    const result = applyDamage(target, 10, 'fire', { resistances: [], vulnerabilities: ['fire'], immunities: [] });
    expect(result.applied).toBe(20);
    expect(result.reason).toBe('vulnerable');
  });

  it('ignores immune damage entirely', () => {
    const result = applyDamage(target, 30, 'poison', { resistances: [], vulnerabilities: [], immunities: ['poison'] });
    expect(result.applied).toBe(0);
    expect(result.hpAfter).toBe(40);
    expect(result.reason).toBe('immune');
  });

  it('lets immunity beat resistance and vulnerability', () => {
    const result = applyDamage(target, 20, 'fire', {
      resistances: ['fire'], vulnerabilities: ['fire'], immunities: ['fire'],
    });
    expect(result.applied).toBe(0);
  });

  it('matches damage types case-insensitively', () => {
    const result = applyDamage(target, 10, 'Fire', { resistances: ['fire'], vulnerabilities: [], immunities: [] });
    expect(result.reason).toBe('resistant');
  });

  it('spends temporary hit points first', () => {
    const result = applyDamage({ hp: 40, maxHp: 45, tempHp: 7 }, 10, 'slashing');
    expect(result.tempAbsorbed).toBe(7);
    expect(result.tempAfter).toBe(0);
    // Only the remaining 3 reaches real hit points.
    expect(result.hpAfter).toBe(37);
  });

  it('never drops below zero', () => {
    const result = applyDamage({ hp: 5, maxHp: 45 }, 100, 'slashing');
    expect(result.hpAfter).toBe(0);
  });
});

describe('applyHealing', () => {
  it('heals up to but not beyond the maximum', () => {
    expect(applyHealing({ hp: 40, maxHp: 45 }, 20).hpAfter).toBe(45);
    expect(applyHealing({ hp: 40, maxHp: 45 }, 20).healed).toBe(5);
  });

  it('heals normally below the cap', () => {
    expect(applyHealing({ hp: 10, maxHp: 45 }, 12).hpAfter).toBe(22);
  });
});

describe('concentration', () => {
  it('uses a DC of 10 for small hits', () => {
    expect(concentrationDC(9)).toBe(10);
    expect(concentrationDC(20)).toBe(10);
  });

  it('uses half the damage once that exceeds 10', () => {
    expect(concentrationDC(30)).toBe(15);
    expect(concentrationDC(45)).toBe(22);
  });

  it('builds a CON save expression', () => {
    // CON 15 gives +2; proficiency at level 5 adds +3.
    expect(concentrationSave({ str: 16, dex: 14, con: 15, int: 10, wis: 12, cha: 8 }, 5, true).expression).toBe('1d20+5');
    expect(concentrationSave({ str: 16, dex: 14, con: 15, int: 10, wis: 12, cha: 8 }, 5, false).expression).toBe('1d20+2');
  });

  it('formats a negative modifier correctly', () => {
    expect(concentrationSave({ str: 10, dex: 10, con: 6, int: 10, wis: 10, cha: 10 }, 1, false).expression).toBe('1d20-2');
  });
});

describe('initiative order', () => {
  it('sorts descending', () => {
    const order = sortInitiative([
      { id: 'a', name: 'Goblin', initiative: 12 },
      { id: 'b', name: 'Thorin', initiative: 19 },
      { id: 'c', name: 'Elaria', initiative: 15 },
    ]);
    expect(order.map((r) => r.name)).toEqual(['Thorin', 'Elaria', 'Goblin']);
  });

  it('breaks ties on dexterity', () => {
    const order = sortInitiative([
      { id: 'a', name: 'Slow', initiative: 15, dexterity: 8 },
      { id: 'b', name: 'Quick', initiative: 15, dexterity: 18 },
    ]);
    expect(order.map((r) => r.name)).toEqual(['Quick', 'Slow']);
  });

  it('is stable by name when initiative and dexterity match', () => {
    const order = sortInitiative([
      { id: 'a', name: 'Zed', initiative: 10, dexterity: 10 },
      { id: 'b', name: 'Aria', initiative: 10, dexterity: 10 },
    ]);
    expect(order.map((r) => r.name)).toEqual(['Aria', 'Zed']);
  });
});

describe('turn advance', () => {
  it('steps through the order', () => {
    expect(advanceTurn(0, 1, 3)).toEqual({ activeIndex: 1, round: 1 });
    expect(advanceTurn(1, 1, 3)).toEqual({ activeIndex: 2, round: 1 });
  });

  it('rolls into the next round at the end of the order', () => {
    expect(advanceTurn(2, 1, 3)).toEqual({ activeIndex: 0, round: 2 });
  });

  it('rewinds, stepping back into the previous round', () => {
    expect(rewindTurn(1, 2, 3)).toEqual({ activeIndex: 0, round: 2 });
    expect(rewindTurn(0, 2, 3)).toEqual({ activeIndex: 2, round: 1 });
  });

  it('never rewinds below round 1', () => {
    expect(rewindTurn(0, 1, 3).round).toBe(1);
  });

  it('handles an empty encounter', () => {
    expect(advanceTurn(0, 1, 0)).toEqual({ activeIndex: 0, round: 1 });
  });
});

describe('effect expiry', () => {
  const timed = (name: string, rounds: number, startRound: number): ActiveEffect => ({
    id: name, name, changes: [], disabled: false, duration: { rounds, startRound },
  });

  it('expires an effect once its rounds have elapsed', () => {
    const effects = [timed('Bless', 10, 1), timed('Hex', 2, 1)];
    // Round 3: Hex started round 1 and lasts 2 rounds, so it is done.
    expect(expiredEffects(effects, 3).map((e) => e.name)).toEqual(['Hex']);
  });

  it('keeps indefinite effects forever', () => {
    const permanent: ActiveEffect = { id: 'x', name: 'Plate', changes: [], disabled: false, duration: null };
    expect(expiredEffects([permanent], 99)).toEqual([]);
  });
});

describe('deriveToken', () => {
  it('stops a grappled token and reports why', () => {
    const derived = deriveToken({ conditions: ['grappled'], ac: 15, maxHp: 20 });

    expect(derived.speed).toBe(0);
    expect(derived.reasons).toContain('Grappled');
  });

  it('halves a prone token, at whatever base speed it has', () => {
    expect(deriveToken({ conditions: ['prone'] }).speed).toBe(15);
    expect(deriveToken({ conditions: ['prone'] }, 40).speed).toBe(20);
  });

  it('blinds on blinded, unconscious and petrified', () => {
    // The server reads this to collapse sight to nothing, so a wrong answer
    // here either blinds a healthy token or lets a blind one see.
    expect(deriveToken({ conditions: ['blinded'] }).blinded).toBe(true);
    expect(deriveToken({ conditions: ['unconscious'] }).blinded).toBe(true);
    expect(deriveToken({ conditions: ['petrified'] }).blinded).toBe(true);
  });

  it('does not blind for conditions that leave you looking', () => {
    expect(deriveToken({ conditions: [] }).blinded).toBe(false);
    expect(deriveToken({ conditions: ['prone', 'poisoned', 'frightened'] }).blinded).toBe(false);
  });

  it('leaves an unconditioned token on its base numbers', () => {
    const derived = deriveToken({ conditions: [], ac: 18, maxHp: 30 });
    expect(derived.speed).toBe(30);
    expect(derived.ac).toBe(18);
    expect(derived.reasons).toEqual([]);
  });
});

describe('attackModeAgainst', () => {
  const healthy = { conditions: [] as string[] };

  it('gives advantage against a prone target', () => {
    expect(attackModeAgainst(healthy, { conditions: ['prone'] }).mode).toBe('advantage');
  });

  it('gives disadvantage when the attacker is poisoned', () => {
    expect(attackModeAgainst({ conditions: ['poisoned'] }, healthy).mode).toBe('disadvantage');
  });

  it('cancels rather than stacking', () => {
    // A poisoned attacker striking a prone target rolls straight. This is the
    // rule tables get wrong most often, which is why it is computed at all.
    const result = attackModeAgainst({ conditions: ['poisoned'] }, { conditions: ['prone'] });
    expect(result.mode).toBe('normal');
    expect(result.reasons).toContain('they cancel out');
  });

  it('treats a paralyzed target as helpless', () => {
    expect(attackModeAgainst(healthy, { conditions: ['paralyzed'] }).mode).toBe('advantage');
  });

  it('rolls straight between two healthy creatures', () => {
    expect(attackModeAgainst(healthy, healthy).mode).toBe('normal');
  });
});

describe('combineRollModes', () => {
  it('does not stack advantage', () => {
    expect(combineRollModes('advantage', 'advantage')).toBe('advantage');
  });

  it('lets one disadvantage cancel every advantage', () => {
    // A prone target shot at long range is rolled straight.
    expect(combineRollModes('advantage', 'disadvantage')).toBe('normal');
    expect(combineRollModes('advantage', 'advantage', 'disadvantage')).toBe('normal');
  });

  it('passes a single source through', () => {
    expect(combineRollModes('normal', 'disadvantage')).toBe('disadvantage');
    expect(combineRollModes('normal', 'normal')).toBe('normal');
    expect(combineRollModes()).toBe('normal');
  });
});

import { describe, expect, it } from 'vitest';
import { slotState, spellLevelOf, spendSlot, tracksSlots } from './spellSlots.js';
import type { SpellSlots } from './schemas.js';

/** A level-3 wizard: four 1st, two 2nd, none above. */
function wizard(used: number[] = [0, 0, 0, 0, 0, 0, 0, 0, 0]): SpellSlots {
  return { max: [4, 2, 0, 0, 0, 0, 0, 0, 0], used };
}

/** What a stamped monster arrives with. A stat block states no slot table. */
const monster: SpellSlots = { max: Array(9).fill(0), used: Array(9).fill(0) };

describe('reading a slot level', () => {
  it('reports max, used and what is left', () => {
    expect(slotState(wizard([3, 0, 0, 0, 0, 0, 0, 0, 0]), 1)).toEqual({ max: 4, used: 3, left: 1 });
  });

  it('never reports a negative remainder', () => {
    // A sheet edited down to fewer slots than are already spent is a state the
    // DM can produce, and it must read as empty rather than as -2 left.
    expect(slotState({ max: [1, 0, 0, 0, 0, 0, 0, 0, 0], used: [3, 0, 0, 0, 0, 0, 0, 0, 0] }, 1).left).toBe(0);
  });

  it('answers zero outside levels 1-9', () => {
    expect(slotState(wizard(), 0).max).toBe(0);
    expect(slotState(wizard(), 10).max).toBe(0);
  });
});

describe('what costs a slot', () => {
  it('charges a level the sheet has slots at', () => {
    expect(tracksSlots(wizard(), 1)).toBe(true);
  });

  it('does not charge a level the sheet has none at', () => {
    expect(tracksSlots(wizard(), 3)).toBe(false);
  });

  it('does not charge a creature with no slot table at all', () => {
    // The rule that keeps monsters casting. Charging every caster would make
    // every stamped NPC's spells unusable, since a stat block never publishes
    // a slot table.
    for (let level = 1; level <= 9; level += 1) expect(tracksSlots(monster, level)).toBe(false);
  });
});

describe('spending one', () => {
  it('increments used and leaves max alone', () => {
    const result = spendSlot(wizard(), 1);
    expect(result).not.toBeNull();
    expect(result!.slots!.used[0]).toBe(1);
    expect(result!.slots!.max[0]).toBe(4);
    expect(result!.state.left).toBe(3);
  });

  it('does not mutate what it was given', () => {
    const before = wizard();
    spendSlot(before, 1);
    expect(before.used[0]).toBe(0);
  });

  it('touches only the level cast at', () => {
    const result = spendSlot(wizard(), 2);
    expect(result!.slots!.used).toEqual([0, 1, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('refuses when they are all gone', () => {
    const result = spendSlot(wizard([4, 0, 0, 0, 0, 0, 0, 0, 0]), 1);
    expect(result).not.toBeNull();
    expect(result!.slots).toBeNull();
    expect(result!.state.left).toBe(0);
  });

  it('answers null - free, not refused - for an untracked level', () => {
    // The distinction the caller needs: null means cast on, `{ slots: null }`
    // means stop. Collapsing them would either charge a goblin or refuse it.
    expect(spendSlot(monster, 1)).toBeNull();
    expect(spendSlot(wizard(), 9)).toBeNull();
  });

  it('answers null for a cantrip', () => {
    expect(spendSlot(wizard(), 0)).toBeNull();
  });
});

describe('the level an item is cast at', () => {
  it('reads a spell level', () => {
    expect(spellLevelOf({ type: 'spell', system: { level: 3 } })).toBe(3);
  });

  it('calls a cantrip level 0', () => {
    expect(spellLevelOf({ type: 'spell', system: { level: 0 } })).toBe(0);
  });

  it('is 0 for anything that is not a spell', () => {
    // A weapon carries a `level` field for nothing, and a longsword must never
    // cost a slot because a stray number sat in its blob.
    expect(spellLevelOf({ type: 'weapon', system: { level: 4 } })).toBe(0);
  });

  it('is 0 for a spell with no level recorded', () => {
    expect(spellLevelOf({ type: 'spell', system: {} })).toBe(0);
  });
});

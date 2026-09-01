import type { SpellSlots } from './schemas.js';

/**
 * Spending and restoring spell slots.
 *
 * `spellSlots` has been a column since the schema was written, `rest.ts` has
 * always cleared it on a long rest, and two things read it - `slotsAvailable`
 * decides whether the target panel offers a spell, and `reachBands` skips one
 * "with no slots left" when drawing a reach. **Nothing ever incremented it.**
 * So both readers could only ever be true, no screen in the app displayed a
 * slot at all, and a wizard at this table had infinite spells. The same shape
 * as `movementBlocked`, `deriveActor` and `XP_THRESHOLDS` before it: a rule
 * written, tested, reachable, and wired to nothing.
 *
 * These are the only functions that move the numbers, so the sheet's pips and
 * the server's charge cannot disagree about what a slot is.
 */

/** Slots are levels 1-9, stored zero-indexed. Cantrips are level 0 and free. */
export const MAX_SPELL_LEVEL = 9;

export interface SlotState {
  /** How many the sheet has at this level. Zero means it is not tracking them. */
  max: number;
  used: number;
  left: number;
}

export function slotState(slots: SpellSlots, level: number): SlotState {
  if (level < 1 || level > MAX_SPELL_LEVEL) return { max: 0, used: 0, left: 0 };
  const max = slots.max[level - 1] ?? 0;
  const used = slots.used[level - 1] ?? 0;
  return { max, used, left: Math.max(0, max - used) };
}

/**
 * Whether casting at this level costs anything on this sheet.
 *
 * A cantrip is free, and so is a level the sheet has no slots at - which is the
 * rule that keeps monsters working. A stamped monster's `spellSlots` is all
 * zeros, because a stat block states hit dice and a challenge rating and never
 * a slot table, so charging every caster would make every NPC spell unusable.
 * Gating on `type === 'character'` instead would be the same rule written less
 * honestly: what matters is whether this sheet tracks slots, not what kind of
 * creature it is. A warlock written by hand with slots filled in is charged;
 * a goblin shaman with none is not.
 */
export function tracksSlots(slots: SpellSlots, level: number): boolean {
  return slotState(slots, level).max > 0;
}

/**
 * Spends one slot, or reports that there is none to spend.
 *
 * Returns null when the level is untracked or free - the caller writes nothing
 * and the cast goes ahead. Returns `{ slots: null }` when they are all gone, so
 * a refusal is distinguishable from a cast that simply costs nothing.
 */
export function spendSlot(
  slots: SpellSlots,
  level: number,
): { slots: SpellSlots; state: SlotState } | { slots: null; state: SlotState } | null {
  if (!tracksSlots(slots, level)) return null;

  const before = slotState(slots, level);
  if (before.left <= 0) return { slots: null, state: before };

  const used = slots.used.slice();
  used[level - 1] = before.used + 1;
  const next: SpellSlots = { max: slots.max.slice(), used };
  return { slots: next, state: slotState(next, level) };
}

/**
 * The spell level an item is cast at.
 *
 * Only spells have one. There is no upcasting anywhere in this app - no
 * `castLevel` on the wire, and the importer already flattens
 * `damage_at_slot_level` - so a level-N spell spends a level-N slot and
 * nothing else.
 */
export function spellLevelOf(item: { type: string; system: unknown }): number {
  if (item.type !== 'spell') return 0;
  const level = (item.system as { level?: unknown }).level;
  return typeof level === 'number' && level >= 0 ? level : 0;
}

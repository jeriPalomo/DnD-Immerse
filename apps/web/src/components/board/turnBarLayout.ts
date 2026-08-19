/** Face sizes in pixels: the creature acting, and everyone else. */
export const ACTIVE_FACE_PX = 48;
export const FACE_PX = 36;
export const FACE_GAP_PX = 6;

/** How much of the strip the stacked tail may occupy. */
const STACK_FRACTION = 0.3;
/** Overlap step, clamped: tight enough to pack a horde, loose enough to read. */
const MIN_STEP_PX = 5;
const MAX_STEP_PX = 14;

export interface BarLayout {
  /** How many faces are laid out normally, the acting creature included. */
  openCount: number;
  /** Pixels between the left edges of stacked faces; they overlap. */
  stackStep: number;
}

/**
 * How many faces stand on their own, and how tightly the rest clump.
 *
 * Arithmetic rather than measurement, which it can be now that a face is a
 * fixed size: measuring each child, then re-rendering a shorter list, changes
 * the widths that decided the list.
 *
 * The tail is not dropped and not counted - it is fanned out at the end,
 * overlapping and fading, still in turn order. More creatures means a tighter
 * fan rather than a wider bar, so the strip never grows and the page never
 * scrolls sideways.
 */
export function layoutTurnBar(count: number, stripWidth: number): BarLayout {
  if (count <= 0) return { openCount: 0, stackStep: MAX_STEP_PX };
  if (stripWidth <= 0) return { openCount: count, stackStep: MAX_STEP_PX };

  const widthOf = (faces: number) =>
    faces <= 0 ? 0 : ACTIVE_FACE_PX + (faces - 1) * (FACE_PX + FACE_GAP_PX);

  // Everything fits on its own: no stack at all.
  if (widthOf(count) <= stripWidth) return { openCount: count, stackStep: MAX_STEP_PX };

  const budget = Math.max(FACE_PX, stripWidth * STACK_FRACTION);
  const open = Math.max(1, Math.floor((stripWidth - budget - ACTIVE_FACE_PX) / (FACE_PX + FACE_GAP_PX)) + 1);
  const openCount = Math.min(count, open);
  const stacked = count - openCount;

  if (stacked <= 0) return { openCount, stackStep: MAX_STEP_PX };

  // The fan has to live inside its budget however many are in it, so the step
  // shrinks as the horde grows rather than pushing the bar wider.
  const step = stacked > 1 ? (budget - FACE_PX) / (stacked - 1) : MAX_STEP_PX;
  return { openCount, stackStep: Math.max(MIN_STEP_PX, Math.min(MAX_STEP_PX, step)) };
}

/** Fades along the fan, so depth in the queue reads as distance. */
export function stackOpacity(indexInStack: number, stacked: number): number {
  if (stacked <= 1) return 0.45;
  const t = indexInStack / (stacked - 1);
  return 0.45 - t * 0.3;
}

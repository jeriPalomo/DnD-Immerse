import { Group, Rect } from 'react-konva';
import { gridToPixel } from '@dnd/shared';
import type { WireToken } from '@dnd/shared';

/**
 * How far the creature you are playing can hit, drawn on the board.
 *
 * "I moved here - now what can I reach" was a question the app could answer and
 * did not show: the reach list in the sidebar knew, and nothing on the board
 * did, so the only way to find out whether the goblin across the room was in
 * range was to click it and read a refusal.
 *
 * A **rectangle**, not a circle, because that is what 5e's measurement makes
 * it: `tokenDistance` counts diagonals as one square, so the squares within N
 * of a footprint are exactly that footprint grown by N on every side. A circle
 * would be prettier and would disagree with `evaluateOptions` at the corners -
 * the same trap AoE outlines avoid by sharing their geometry with the target
 * list.
 *
 * The inner band is what lands without penalty; the outer one is the long-range
 * band a bow still covers at disadvantage.
 */
export function ReachLayer({
  grid,
  token,
  feetPerSquare,
  normalFeet,
  longFeet,
}: {
  grid: { gridSize: number; offsetX: number; offsetY: number };
  /** The creature doing the reaching. */
  token: WireToken;
  feetPerSquare: number;
  normalFeet: number;
  longFeet: number;
}) {
  if (normalFeet <= 0) return null;

  /** The footprint grown by a reach, as a pixel rectangle. */
  function band(feet: number) {
    const squares = Math.floor(feet / (feetPerSquare || 5));
    const origin = gridToPixel({ x: token.x - squares, y: token.y - squares }, grid);
    const side = (n: number) => n * grid.gridSize;
    return {
      x: origin.x,
      y: origin.y,
      width: side(token.w + squares * 2),
      height: side(token.h + squares * 2),
    };
  }

  const near = band(normalFeet);
  const far = longFeet > normalFeet ? band(longFeet) : null;

  return (
    <Group listening={false}>
      {/* Measured rather than guessed: at 1.5px and 55% over a lit stone floor
          this was invisible on screen and only a pixel diff could prove it was
          drawn at all. An overlay nobody can see is an overlay nobody has. */}
      {far && (
        <Rect
          {...far}
          stroke="#d9691f"
          strokeWidth={2}
          dash={[8, 6]}
          opacity={0.5}
          cornerRadius={2}
        />
      )}
      <Rect {...near} fill="#d9691f" opacity={0.12} cornerRadius={2} />
      <Rect {...near} stroke="#f0883e" strokeWidth={2.5} opacity={0.9} cornerRadius={2} />
    </Group>
  );
}

import { Group, Rect, Shape } from 'react-konva';
import { DISPOSITION_COLOR, gridToPixel } from '@dnd/shared';
import type { Disposition } from '@dnd/shared';

/**
 * Where things can move, the way a tactics game shows it.
 *
 * Blue for the unit you have selected, green for an ally, red for the union of
 * everything hostile, and a darker red for one enemy picked out of that union.
 * The squares come from the server - reachability depends on walls, and players
 * never receive those.
 */
export function MovementLayer({
  grid,
  moveSquares,
  moveDisposition,
  threatSquares,
}: {
  grid: { gridSize: number; offsetX: number; offsetY: number };
  /** The selected token's own reach. */
  moveSquares: [number, number][];
  moveDisposition: Disposition;
  /** Every visible hostile's reach, unioned. */
  threatSquares: [number, number][];
}) {
  return (
    <Group listening={false}>
      {/* The threat union can cover most of a map, so it is painted as ONE
          path filled once rather than a node per square - the trick FogLayer
          uses. A Rect each would be thousands of Konva nodes. */}
      {threatSquares.length > 0 && (
        <Shape
          listening={false}
          sceneFunc={(context) => {
            const ctx = context._context;
            ctx.beginPath();
            for (const [x, y] of threatSquares) {
              const point = gridToPixel({ x, y }, grid);
              // Half a pixel of bleed, or adjacent squares show hairline seams.
              ctx.rect(point.x - 0.5, point.y - 0.5, grid.gridSize + 1, grid.gridSize + 1);
            }
            ctx.fillStyle = DISPOSITION_COLOR.hostile;
            ctx.globalAlpha = 0.14;
            ctx.fill();
            ctx.globalAlpha = 1;
          }}
        />
      )}

      {/* One token's reach is small - a 30ft speed is 169 squares at most - so
          the simpler per-square Rect is fine, and it layers over the union to
          pick a single enemy out of it. */}
      {moveSquares.map(([x, y]) => {
        const point = gridToPixel({ x, y }, grid);
        return (
          <Rect
            key={`${x}:${y}`}
            x={point.x}
            y={point.y}
            width={grid.gridSize}
            height={grid.gridSize}
            fill={DISPOSITION_COLOR[moveDisposition]}
            opacity={moveDisposition === 'hostile' ? 0.26 : 0.18}
          />
        );
      })}
    </Group>
  );
}

import { Group, Rect } from 'react-konva';
import { gridToPixel, type TerrainCells } from '@dnd/shared';

/**
 * The ground the DM has painted, drawn for the DM alone.
 *
 * Players are never sent this. It is a map of the dungeon in the same way wall
 * geometry is, and the map art already shows the chasm - what a player gets is
 * a movement overlay that stops at it and a drag that is refused, both decided
 * on the server.
 *
 * Deliberately faint. This sits over artwork the DM chose, and a bright wash
 * across half a battle map makes it unreadable for the sake of information only
 * one person needs.
 */

/**
 * Drawn cheapest first, so that where two washes meet the dearer ground is the
 * one on top. Blocked is last and darkest because it is the one that stops a
 * move outright rather than costing for it.
 */
const PAINT = [
  { kind: 'water', fill: '#38bdf8', opacity: 0.14 },
  { kind: 'mud', fill: '#a16207', opacity: 0.2 },
] as const;

export function TerrainLayer({
  grid,
  terrain,
}: {
  grid: Parameters<typeof gridToPixel>[1];
  terrain: TerrainCells;
}) {
  if (terrain.blocked.length === 0 && terrain.mud.length === 0 && terrain.water.length === 0) {
    return null;
  }

  return (
    <Group listening={false}>
      {PAINT.map(({ kind, fill, opacity }) =>
        terrain[kind].map(([x, y]) => {
          const point = gridToPixel({ x, y }, grid);
          return (
            <Rect
              key={`${kind}${x}:${y}`}
              x={point.x}
              y={point.y}
              width={grid.gridSize}
              height={grid.gridSize}
              fill={fill}
              opacity={opacity}
            />
          );
        }),
      )}

      {terrain.blocked.map(([x, y]) => {
        const point = gridToPixel({ x, y }, grid);
        return (
          <Rect
            key={`b${x}:${y}`}
            x={point.x}
            y={point.y}
            width={grid.gridSize}
            height={grid.gridSize}
            fill="#0f172a"
            opacity={0.5}
            stroke="#ef4444"
            strokeWidth={1}
            dash={[4, 4]}
          />
        );
      })}
    </Group>
  );
}

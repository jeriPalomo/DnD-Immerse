import { Group, Rect } from 'react-konva';
import { gridToPixel } from '@dnd/shared';

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
export function TerrainLayer({
  grid,
  blocked,
  difficult,
}: {
  grid: Parameters<typeof gridToPixel>[1];
  blocked: [number, number][];
  difficult: [number, number][];
}) {
  if (blocked.length === 0 && difficult.length === 0) return null;

  return (
    <Group listening={false}>
      {difficult.map(([x, y]) => {
        const point = gridToPixel({ x, y }, grid);
        return (
          <Rect
            key={`d${x}:${y}`}
            x={point.x}
            y={point.y}
            width={grid.gridSize}
            height={grid.gridSize}
            fill="#f59e0b"
            opacity={0.16}
          />
        );
      })}

      {blocked.map(([x, y]) => {
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

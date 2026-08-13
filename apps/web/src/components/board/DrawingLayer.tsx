import { Arrow, Group, Line, Text } from 'react-konva';
import { gridToPixel } from '@dnd/shared';
import type { WireDrawing } from '@dnd/shared';

/**
 * Freehand annotation, arrows and labels.
 *
 * Points are stored in grid units like everything else on the board, so a
 * drawing stays where it was put when the grid is recalibrated.
 */
export function DrawingLayer({
  drawings,
  grid,
  pending,
  pendingColor,
  onErase,
  canErase,
}: {
  drawings: WireDrawing[];
  grid: { gridSize: number; offsetX: number; offsetY: number };
  /** The stroke being drawn right now, before it is committed. */
  pending: number[] | null;
  pendingColor: string;
  onErase: (drawingId: string) => void;
  canErase: (drawing: WireDrawing) => boolean;
}) {
  /** Grid-unit pairs to the flat pixel array Konva wants. */
  function toPixels(points: number[]): number[] {
    const out: number[] = [];
    for (let i = 0; i + 1 < points.length; i += 2) {
      const point = gridToPixel({ x: points[i], y: points[i + 1] }, grid);
      out.push(point.x, point.y);
    }
    return out;
  }

  return (
    <Group>
      {drawings.map((drawing) => {
        const points = toPixels(drawing.points);
        const erasable = canErase(drawing);
        const common = {
          stroke: drawing.color,
          strokeWidth: drawing.width,
          lineCap: 'round' as const,
          lineJoin: 'round' as const,
          // Alt-click erases, matching how walls and pins already work.
          onClick: (e: { evt: MouseEvent; cancelBubble: boolean }) => {
            if (!erasable || !e.evt.altKey) return;
            e.cancelBubble = true;
            onErase(drawing.id);
          },
        };

        if (drawing.kind === 'text') {
          return (
            <Text
              key={drawing.id}
              x={points[0]}
              y={points[1]}
              text={drawing.text}
              fontSize={grid.gridSize * 0.3}
              fill={drawing.color}
              onClick={common.onClick}
            />
          );
        }

        if (drawing.kind === 'arrow') {
          return <Arrow key={drawing.id} points={points} fill={drawing.color} {...common} />;
        }

        return <Line key={drawing.id} points={points} {...common} tension={0.3} />;
      })}

      {/* The in-progress stroke, drawn locally so it follows the cursor with
          no round trip. */}
      {pending && pending.length >= 4 && (
        <Line
          points={toPixels(pending)}
          stroke={pendingColor}
          strokeWidth={3}
          lineCap="round"
          lineJoin="round"
          tension={0.3}
          opacity={0.8}
          listening={false}
        />
      )}
    </Group>
  );
}

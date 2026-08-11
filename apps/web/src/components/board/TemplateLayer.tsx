import { Circle, Group, Line, Rect } from 'react-konva';
import { CONE_ANGLE_DEGREES, coveredSquares, gridToPixel } from '@dnd/shared';
import type { WireTemplate } from '@dnd/shared';

/**
 * Area-of-effect outlines.
 *
 * Drawn from the same numbers `templateCovers` uses to decide who is caught,
 * so the outline a player aims by and the list of targets can never disagree.
 */
export function TemplateLayer({
  templates,
  grid,
  feetPerSquare,
  onClear,
}: {
  templates: WireTemplate[];
  grid: { gridSize: number; offsetX: number; offsetY: number };
  feetPerSquare: number;
  onClear: (templateId: string) => void;
}) {
  return (
    <Group>
      {templates.map((template) => {
        const origin = gridToPixel({ x: template.x, y: template.y }, grid);

        // The squares actually affected, drawn under the outline. A smooth
        // circle is pretty; the squares are what people count at the table.
        const squares = coveredSquares(
          {
            shape: template.shape,
            x: template.x,
            y: template.y,
            distance: template.distance,
            direction: template.direction,
            width: template.width,
          },
          { feetPerSquare },
        );
        const reach = (template.distance / feetPerSquare) * grid.gridSize;
        const common = {
          stroke: template.color,
          strokeWidth: 2,
          fill: template.color,
          opacity: 0.22,
          onClick: (e: { cancelBubble: boolean }) => {
            e.cancelBubble = true;
            onClear(template.id);
          },
        };

        const highlight = (
          <Group key={`${template.id}-squares`} listening={false}>
            {squares.map(([cx, cy]) => {
              const point = gridToPixel({ x: cx, y: cy }, grid);
              return (
                <Rect
                  key={`${cx}:${cy}`}
                  x={point.x}
                  y={point.y}
                  width={grid.gridSize}
                  height={grid.gridSize}
                  fill={template.color}
                  opacity={0.16}
                />
              );
            })}
          </Group>
        );

        if (template.shape === 'circle') {
          return (
            <Group key={template.id}>
              {highlight}
              <Circle x={origin.x} y={origin.y} radius={reach} {...common} />
            </Group>
          );
        }

        if (template.shape === 'rect') {
          return (
            <Group key={template.id}>
              {highlight}
              <Rect x={origin.x} y={origin.y} width={reach} height={reach} {...common} />
            </Group>
          );
        }

        const radians = (template.direction * Math.PI) / 180;

        if (template.shape === 'ray') {
          const halfWidth = ((template.width || 5) / feetPerSquare / 2) * grid.gridSize;
          // Corners of the rectangle running along the ray's axis.
          const ax = Math.cos(radians);
          const ay = Math.sin(radians);
          const px = -ay * halfWidth;
          const py = ax * halfWidth;

          return (
            <Group key={template.id}>
              {highlight}
            <Line
              points={[
                origin.x + px, origin.y + py,
                origin.x + ax * reach + px, origin.y + ay * reach + py,
                origin.x + ax * reach - px, origin.y + ay * reach - py,
                origin.x - px, origin.y - py,
              ]}
              closed
              {...common}
            />
            </Group>
          );
        }

        // Cone: a wedge of CONE_ANGLE_DEGREES centred on the direction.
        const half = (CONE_ANGLE_DEGREES / 2) * (Math.PI / 180);
        const points = [origin.x, origin.y];
        const steps = 12;
        for (let i = 0; i <= steps; i++) {
          const angle = radians - half + (i / steps) * half * 2;
          points.push(origin.x + Math.cos(angle) * reach, origin.y + Math.sin(angle) * reach);
        }

        return (
          <Group key={template.id}>
            {highlight}
            <Line points={points} closed {...common} />
          </Group>
        );
      })}
    </Group>
  );
}

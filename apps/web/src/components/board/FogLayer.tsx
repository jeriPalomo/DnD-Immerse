import { Circle, Group, Line, Rect, Shape, Text } from 'react-konva';
import type Konva from 'konva';
import { DOOR_LOCKED, DOOR_OPEN, SECRET_DOOR, gridToPixel } from '@dnd/shared';
import type { WireScene, WireVision } from '@dnd/shared';

/**
 * Three-state fog, which is most of why an explored map reads as explored:
 *
 *   black   never seen
 *   dimmed  explored, but not currently in view — you remember the room's
 *           shape, not who is standing in it now
 *   clear   currently visible
 *
 * The polygons arrive from the server already computed. This layer only draws
 * them; it has no wall data to reason about, which is the point.
 */
export function FogLayer({
  scene,
  vision,
  grid,
  own = [],
}: {
  scene: WireScene;
  vision: WireVision;
  grid: { gridSize: number; offsetX: number; offsetY: number };
  /**
   * Footprints of the tokens this viewer controls, in grid units.
   *
   * Always clear, because you know where you are standing. Normally they sit
   * inside your own sight polygon anyway and this changes nothing - it matters
   * when the polygon is empty, which is exactly what being blinded produces.
   * Without it a blinded player gets an unbroken black rectangle and cannot
   * tell where they are, or that they still have a token at all.
   */
  own?: { x: number; y: number; w: number; h: number }[];
}) {
  const width = scene.mapWidth || 1400;
  const height = scene.mapHeight || 900;

  /** Adds each controlled token's square to the current path. */
  const punchOwn = (ctx: CanvasRenderingContext2D) => {
    for (const token of own) {
      const point = gridToPixel({ x: token.x, y: token.y }, grid);
      ctx.rect(point.x, point.y, token.w * grid.gridSize, token.h * grid.gridSize);
    }
  };

  /**
   * Drawn as one custom shape against the raw 2D context rather than as a
   * stack of Konva nodes with `globalCompositeOperation`. Compositing between
   * sibling nodes depends on layer draw order in ways that are easy to get
   * subtly wrong; here the fill and the holes are unambiguously one operation.
   */
  const paint = (context: Konva.Context) => {
    const ctx = context._context;

    // Pass 1: solid black everywhere never explored. Explored squares are
    // punched out, so remembered ground is not pitch black.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, width, height);
    for (const [cx, cy] of vision.explored) {
      const point = gridToPixel({ x: cx, y: cy }, grid);
      // Half a pixel of bleed stops hairline seams between adjacent squares.
      ctx.rect(point.x - 0.5, point.y - 0.5, grid.gridSize + 1, grid.gridSize + 1);
    }
    punchOwn(ctx);
    ctx.fillStyle = '#05040a';
    ctx.fill('evenodd');
    ctx.restore();

    // Pass 2: a dim veil over everything outside current sight. Explored but
    // unseen ground keeps its shape while hiding who is standing on it.
    ctx.save();
    ctx.fillStyle = 'rgba(5, 4, 10, 0.62)';
    ctx.fillRect(0, 0, width, height);
    ctx.globalCompositeOperation = 'destination-out';
    for (const polygon of vision.polygons) {
      if (polygon.length < 3) continue;
      ctx.beginPath();
      polygon.forEach((p, index) => {
        const point = gridToPixel(p, grid);
        if (index === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      });
      ctx.closePath();
      ctx.fill();
    }
    ctx.beginPath();
    punchOwn(ctx);
    ctx.fill();
    ctx.restore();
  };

  return (
    <Shape
      listening={false}
      // Keyed on the payload so Konva repaints when sight changes.
      key={`${vision.polygons.length}:${vision.explored.length}:${own.map((t) => `${t.x},${t.y}`).join('|')}`}
      sceneFunc={paint}
    />
  );
}

/**
 * Doors, drawn for everyone. A door is a thing you can see and open; the walls
 * around it are not sent to players at all.
 */
export function DoorLayer({
  doors,
  grid,
  isDM = false,
  onToggle,
  onReveal,
  onLock,
}: {
  doors: { id: string; x1: number; y1: number; x2: number; y2: number; door: number; doorState: number }[];
  grid: { gridSize: number; offsetX: number; offsetY: number };
  isDM?: boolean;
  onToggle: (wallId: string) => void;
  /** DM only: a secret door becomes an ordinary one the party can see. */
  onReveal?: (wallId: string) => void;
  /** DM only: lock or unlock. */
  onLock?: (wallId: string, locked: boolean) => void;
}) {
  return (
    <Group>
      {doors.map((door) => {
        const a = gridToPixel({ x: door.x1, y: door.y1 }, grid);
        const b = gridToPixel({ x: door.x2, y: door.y2 }, grid);

        const open = door.doorState === DOOR_OPEN;
        const locked = door.doorState === DOOR_LOCKED;
        // Only the DM ever receives one of these; the server does not send a
        // secret door to a player at all.
        const secret = door.door === SECRET_DOOR;

        return (
          <Line
            key={door.id}
            points={[a.x, a.y, b.x, b.y]}
            stroke={secret ? '#8b7bf0' : locked ? '#f87171' : open ? '#34d399' : '#e8853f'}
            strokeWidth={Math.max(6, grid.gridSize * 0.14)}
            // Drawn as a dotted purple seam so the DM can tell at a glance
            // which walls the party has not found yet.
            dash={secret ? [4, 8] : open ? [10, 10] : undefined}
            opacity={secret ? 0.75 : 1}
            lineCap="round"
            // A fat invisible hit area, so a door is easy to click.
            hitStrokeWidth={Math.max(18, grid.gridSize * 0.4)}
            onClick={(e) => {
              e.cancelBubble = true;

              // Alt is the established "administer this thing" modifier on the
              // board - it deletes walls and pins too.
              if (isDM && e.evt.altKey) {
                if (secret) onReveal?.(door.id);
                else onLock?.(door.id, !locked);
                return;
              }

              if (!locked || isDM) onToggle(door.id);
            }}
            onMouseEnter={(e) => {
              const stage = e.target.getStage();
              if (stage) stage.container().style.cursor = locked && !isDM ? 'not-allowed' : 'pointer';
            }}
            onMouseLeave={(e) => {
              const stage = e.target.getStage();
              if (stage) stage.container().style.cursor = 'default';
            }}
          />
        );
      })}
    </Group>
  );
}

/** Wall geometry, DM only — this layer never renders for a player. */
export function WallLayer({
  walls,
  grid,
  erasing,
  onDelete,
}: {
  walls: { id: string; x1: number; y1: number; x2: number; y2: number; door: number }[];
  grid: { gridSize: number; offsetX: number; offsetY: number };
  /** The Erase tool is on, so a plain click deletes. */
  erasing: boolean;
  onDelete: (wallId: string) => void;
}) {
  return (
    <Group>
      {walls
        .filter((wall) => wall.door === 0)
        .map((wall) => {
          const a = gridToPixel({ x: wall.x1, y: wall.y1 }, grid);
          const b = gridToPixel({ x: wall.x2, y: wall.y2 }, grid);

          return (
            <Line
              key={wall.id}
              points={[a.x, a.y, b.x, b.y]}
              stroke="#8b7bf0"
              strokeWidth={Math.max(3, grid.gridSize * 0.06)}
              opacity={0.85}
              lineCap="round"
              hitStrokeWidth={Math.max(14, grid.gridSize * 0.3)}
              onClick={(e) => {
                e.cancelBubble = true;
                // A plain click deletes while Erase is the chosen tool. Alt-click
                // still does it from any tool, but a modifier nobody is told
                // about is folklore - "I cannot erase my walls" is what that
                // costs, and the tool button is the affordance that fixes it.
                if (erasing || e.evt.altKey) onDelete(wall.id);
              }}
              onMouseEnter={(e) => {
                const stage = e.target.getStage();
                if (stage) stage.container().style.cursor = 'pointer';
              }}
              onMouseLeave={(e) => {
                const stage = e.target.getStage();
                if (stage) stage.container().style.cursor = 'default';
              }}
            />
          );
        })}
    </Group>
  );
}

/**
 * Map pins. The DM sees hidden ones at reduced opacity so they can find the
 * secret door they placed; players only ever receive revealed pins.
 */
export function NoteLayer({
  notes,
  grid,
  isDM,
  erasing,
  onToggle,
  onRemove,
}: {
  notes: { id: string; label: string; x: number; y: number; hidden: boolean }[];
  grid: { gridSize: number; offsetX: number; offsetY: number };
  isDM: boolean;
  /** The Erase tool is on, so a plain click deletes rather than reveals. */
  erasing: boolean;
  onToggle: (noteId: string, hidden: boolean) => void;
  onRemove: (noteId: string) => void;
}) {
  return (
    <Group>
      {notes.map((note) => {
        const point = gridToPixel({ x: note.x, y: note.y }, grid);
        const radius = grid.gridSize * 0.22;

        return (
          <Group
            key={note.id}
            x={point.x}
            y={point.y}
            opacity={note.hidden ? 0.5 : 1}
            onClick={(e) => {
              e.cancelBubble = true;
              if (!isDM) return;
              // Erase deletes on a plain click; otherwise a click reveals or
              // hides the pin and alt-click still removes it.
              if (erasing || e.evt.altKey) onRemove(note.id);
              else onToggle(note.id, !note.hidden);
            }}
            onMouseEnter={(e) => {
              const stage = e.target.getStage();
              if (stage && isDM) stage.container().style.cursor = 'pointer';
            }}
            onMouseLeave={(e) => {
              const stage = e.target.getStage();
              if (stage) stage.container().style.cursor = 'default';
            }}
          >
            <Circle
              radius={radius}
              fill={note.hidden ? '#3a3547' : '#e8853f'}
              stroke={note.hidden ? '#7d7794' : '#f2a86b'}
              strokeWidth={2}
              dash={note.hidden ? [4, 3] : undefined}
            />
            <Text
              x={-radius}
              y={-radius * 0.45}
              width={radius * 2}
              text="i"
              fontSize={radius * 1.1}
              fontStyle="bold"
              fill="#0b0a0f"
              align="center"
            />
            {note.label && (
              <Text
                x={-grid.gridSize}
                y={radius + 2}
                width={grid.gridSize * 2}
                text={note.label}
                fontSize={grid.gridSize * 0.2}
                fill="#f2a86b"
                align="center"
              />
            )}
          </Group>
        );
      })}
    </Group>
  );
}

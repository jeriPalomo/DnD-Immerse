import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Circle, Group, Image as KonvaImage, Layer, Line, Rect, Stage, Text } from 'react-konva';
import {
  COST_NORMAL,
  DISPOSITION_COLOR,
  DM_COLOR,
  TERRAIN_BRUSHES,
  TERRAIN_COST,
  TERRAIN_LABEL,
  TOKEN_MOVE_THROTTLE_MS,
  actorColor,
  gridToPixel,
  isDown,
  pixelToGrid,
  snapTokenPosition,
  tokenBadges,
  tokenDistanceInFeet,
} from '@dnd/shared';
import type Konva from 'konva';
import type { TerrainBrush, WireScene, WireToken } from '@dnd/shared';
import { DoorLayer, FogLayer, NoteLayer, WallLayer } from './FogLayer.js';
import { DrawingLayer } from './DrawingLayer.js';
import { TerrainLayer } from './TerrainLayer.js';
import { MovementLayer } from './MovementLayer.js';
import { TemplateLayer } from './TemplateLayer.js';
import { LightLayer, WeatherLayer } from './AtmosphereLayer.js';
import { useTable } from '../../store/table.js';
import { useAuth } from '../../store/auth.js';
import { getPref, setPref } from '../../lib/prefs.js';

/**
 * A dragged ping is sampled every mousemove, so a slow hand over a big map can
 * produce thousands of points. Trimmed to the schema's cap before sending.
 */
const PING_STROKE_LIMIT = 600;

/** Grid-unit pairs to the flat pixel array Konva wants. */
function toPixelPath(
  points: number[],
  grid: { gridSize: number; offsetX: number; offsetY: number },
): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < points.length; i += 2) {
    const point = gridToPixel({ x: points[i], y: points[i + 1] }, grid);
    out.push(point.x, point.y);
  }
  return out;
}

/**
 * A ghost of the next click.
 *
 * Drawn from the same snapping the click handler applies, not an approximation
 * of it - a preview that rounded differently from the thing it previews would
 * be worse than none. Wall corners round to whole squares, pins to halves, and
 * a brush fills the square the pointer is inside.
 */
function SnapPreview({
  point,
  tool,
  grid,
  from,
}: {
  point: { x: number; y: number };
  tool: string;
  grid: { gridSize: number; offsetX: number; offsetY: number };
  from: { x: number; y: number } | null;
}) {
  const isWall = tool === 'wall' || tool === 'door' || tool === 'secret';
  const isBrush = TERRAIN_BRUSHES.includes(tool as TerrainBrush);

  if (isWall) {
    const corner = gridToPixel({ x: Math.round(point.x), y: Math.round(point.y) }, grid);
    const start = from ? gridToPixel(from, grid) : null;
    const colour = tool === 'secret' ? '#a78bfa' : tool === 'door' ? '#e8853f' : '#7dd3fc';

    return (
      <Group>
        {/* The run so far, so a corner is aimed rather than clicked and checked. */}
        {start && (
          <Line
            points={[start.x, start.y, corner.x, corner.y]}
            stroke={colour}
            strokeWidth={3}
            dash={[8, 6]}
            opacity={0.8}
          />
        )}
        <Circle x={corner.x} y={corner.y} radius={6} fill={colour} opacity={0.9} />
        <Circle x={corner.x} y={corner.y} radius={11} stroke={colour} strokeWidth={1.5} opacity={0.5} />
      </Group>
    );
  }

  if (tool === 'note') {
    // Halves, matching `Math.round(p * 2) / 2` in the click handler.
    const spot = gridToPixel(
      { x: Math.round(point.x * 2) / 2, y: Math.round(point.y * 2) / 2 },
      grid,
    );
    return <Circle x={spot.x} y={spot.y} radius={9} stroke="#fbbf24" strokeWidth={2} opacity={0.85} />;
  }

  if (isBrush) {
    const cell = gridToPixel({ x: Math.floor(point.x), y: Math.floor(point.y) }, grid);
    const colour =
      tool === 'clear' ? '#94a3b8' : tool === 'water' ? '#38bdf8' : tool === 'mud' ? '#a16207' : '#ef4444';

    return (
      <Rect
        x={cell.x}
        y={cell.y}
        width={grid.gridSize}
        height={grid.gridSize}
        fill={colour}
        opacity={0.28}
        stroke={colour}
        strokeWidth={2}
      />
    );
  }

  // Erase, pen and arrow all act where the pointer is rather than on a snap, so
  // a crosshair is the honest preview: it promises no rounding that is not
  // happening.
  const here = gridToPixel(point, grid);
  const arm = grid.gridSize * 0.22;
  return (
    <Group opacity={0.7}>
      <Line points={[here.x - arm, here.y, here.x + arm, here.y]} stroke="#e2e8f0" strokeWidth={1.5} />
      <Line points={[here.x, here.y - arm, here.x, here.y + arm]} stroke="#e2e8f0" strokeWidth={1.5} />
    </Group>
  );
}

/** Loads an image for Konva, re-resolving when the URL changes. */
function useImage(url: string | null): HTMLImageElement | null {
  const [image, setImage] = useState<HTMLImageElement | null>(null);

  useEffect(() => {
    if (!url) {
      setImage(null);
      return;
    }
    const element = new window.Image();
    element.src = url;
    element.onload = () => setImage(element);
    return () => {
      element.onload = null;
    };
  }, [url]);

  return image;
}

/**
 * What a brush is called on the board's status line, and what it costs.
 *
 * Both read from the shared tables rather than written out here, so the line
 * cannot end up claiming a rate the movement search does not charge - the whole
 * reason `TERRAIN_LABEL` sits beside `TERRAIN_COST` in the first place.
 */
function groundHint(brush: TerrainBrush): string {
  if (brush === 'clear') return 'drag to wipe painted ground back to open floor';
  if (brush === 'blocked') {
    return `painting ${TERRAIN_LABEL.blocked.toLowerCase()} ground — drag over squares; players never see the paint`;
  }

  const times = TERRAIN_COST[brush] / COST_NORMAL;
  return `painting ${TERRAIN_LABEL[brush].toLowerCase()}, at ${times}× cost — drag over squares; players never see the paint`;
}

export function BattleMap({
  isDM,
  focused = false,
  onToggleFocus,
}: {
  isDM: boolean;
  focused?: boolean;
  onToggleFocus?: () => void;
}) {
  const {
    scene, tokens, selectedTokenId, targetTokenId, pings, vision, doors, walls, wallTool, templates, notes,
    drawings, encounter, activeActorId, moveRange, threatRange, showThreat, queryMovement, toggleThreat,
    select, target, moveToken, commitToken, pingMap, createWall, deleteWall, updateWall, toggleDoor, clearTemplate,
    placeNote, toggleNote, removeNote, addDrawing, eraseDrawing, terrain, paintTerrain,
  } = useTable();

  // Whose turn it is, so the board can say so without anyone reading the
  // tracker.
  const activeTokenId = encounter?.entries[encounter.activeIndex]?.tokenId ?? null;


  // Where the DM clicked first while drawing a wall segment.
  const [wallStart, setWallStart] = useState<{ x: number; y: number } | null>(null);
  /**
   * Where the cursor is, in grid units, while a tool is out.
   *
   * Only for the snap preview: everything else reads the pointer at the moment
   * it acts. Null when no tool is out, so an ordinary game never pays for it.
   */
  const [snapAt, setSnapAt] = useState<{ x: number; y: number } | null>(null);
  const { user } = useAuth();

  // The stroke in progress, kept local so it tracks the cursor with no round
  // trip; it is sent once on release.
  const [stroke, setStroke] = useState<number[] | null>(null);
  // The same, for an alt-drag ping - which is never persisted.
  const [pingStroke, setPingStroke] = useState<number[] | null>(null);
  // Remembered across reloads: it is a hint, not a setting worth re-making.
  const [hints, setHints] = useState(() => getPref('board-hints', true));
  // Read by the drag guard below, which fires before React has re-rendered with
  // the state above, so the state would still be null there.
  const pinging = useRef(false);
  const myColor = isDM ? DM_COLOR : actorColor(activeActorId ?? user?.id ?? '');
  const drawingMode = wallTool === 'draw' || wallTool === 'arrow';
  /** Painting ground is a drag over squares, so it suspends panning too. */
  /** Click a wall or a pin to delete it, with no modifier to know about. */
  const erasing = wallTool === 'erase';
  const groundBrush: TerrainBrush | null = TERRAIN_BRUSHES.includes(wallTool as TerrainBrush)
    ? (wallTool as TerrainBrush)
    : null;

  const painting = useRef(false);
  /**
   * Squares touched by the current run, flushed on release.
   *
   * Buffered in a ref rather than sent per mousemove: a drag across a lake is
   * hundreds of moves, and one stroke should be one write and one broadcast.
   * A ref rather than state for the same reason the drawing stroke uses
   * updaters - mouse moves outrun React, and a closed-over array loses most of
   * them.
   */
  const paintBuffer = useRef(new Map<string, [number, number]>());

  /** One entry per grid cell touched, deduplicated as the pointer wanders. */
  function paintSquare(point: { x: number; y: number }) {
    const cell: [number, number] = [Math.floor(point.x), Math.floor(point.y)];
    paintBuffer.current.set(`${cell[0]}:${cell[1]}`, cell);
  }

  function flushPaint() {
    const cells = [...paintBuffer.current.values()];
    paintBuffer.current.clear();
    if (scene && groundBrush && cells.length > 0) paintTerrain(scene.id, groundBrush, cells);
  }

  const observerRef = useRef<ResizeObserver | null>(null);
  // Zero until the container is measured; fitting against a placeholder size
  // leaves the map stuck off-centre.
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const [hovered, setHovered] = useState<WireToken | null>(null);

  const mapImage = useImage(scene?.mapImageUrl ?? null);

  /**
   * Attached as a callback ref rather than in an effect.
   *
   * The container is not rendered while there is no active scene, so a
   * mount-time effect would find a null ref and never observe anything - the
   * stage would then sit at zero size forever once the scene did arrive.
   */
  const setContainer = useCallback((node: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!node) return;

    const observer = new ResizeObserver(([entry]) => {
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(node);
    observerRef.current = observer;

    // Measure once immediately; the observer only fires on later changes.
    const rect = node.getBoundingClientRect();
    setSize({ width: rect.width, height: rect.height });
  }, []);

  useEffect(() => () => observerRef.current?.disconnect(), []);

  // Selecting a token asks the server where it can go. Reachability needs walls
  // and players do not have them, so this cannot be worked out locally.
  useEffect(() => {
    queryMovement(selectedTokenId);
  }, [selectedTokenId, queryMovement]);

  /** Centres the whole map in the viewport. Shared by the button and the F key. */
  const fitToMap = useCallback(() => {
    if (!scene?.mapWidth || !scene.mapHeight || !size.width || !size.height) return;
    const scale = Math.min(size.width / scene.mapWidth, size.height / scene.mapHeight, 1);
    setView({
      scale,
      x: (size.width - scene.mapWidth * scale) / 2,
      y: (size.height - scene.mapHeight * scale) / 2,
    });
  }, [scene?.mapWidth, scene?.mapHeight, size.width, size.height]);

  /**
   * Fit once per scene, and never again on its own.
   *
   * This used to list `fitToMap` as a dependency, and `fitToMap` is rebuilt
   * whenever `size` changes - so *every* container resize threw the view away
   * and refitted. Resizing the window, toggling focus mode, opening a panel:
   * a DM who had zoomed into one corner lost it, which is precisely what the
   * comment on the focus-mode refit below says must not happen.
   *
   * It could not simply leave the array either. `size` starts at zero and the
   * ResizeObserver fills it a frame later, so `fitToMap` returns early on the
   * first run and the initial fit only ever happened *because* the effect
   * re-ran. Hence the ref: fit when the scene id changes, and once more when a
   * real size arrives for that scene. Every later resize is somebody's window,
   * not a new map, and leaves the view alone.
   */
  const fittedScene = useRef<string | null>(null);
  useEffect(() => {
    if (!scene?.id || !size.width || !size.height) return;
    if (fittedScene.current === scene.id) return;
    fittedScene.current = scene.id;
    fitToMap();
  }, [scene?.id, size.width, size.height, fitToMap]);

  /*
   * Refit when focus mode toggles, since the board has just changed width by a
   * large factor. Deliberately not on every container resize: that would pull
   * the view away from a DM who has zoomed into a corner on purpose.
   */
  /*
   * Bring the active combatant into view when the turn changes - but only if
   * it is actually off-screen. Always recentring would fight a DM who has
   * deliberately framed one corner of the map.
   */
  useEffect(() => {
    if (!activeTokenId || !size.width || !size.height) return;

    const token = tokens.find((candidate) => candidate.id === activeTokenId);
    if (!token) return;

    const point = gridToPixel({ x: token.x + token.w / 2, y: token.y + token.h / 2 }, grid);
    const screenX = point.x * view.scale + view.x;
    const screenY = point.y * view.scale + view.y;

    const margin = 40;
    const visible =
      screenX > margin &&
      screenY > margin &&
      screenX < size.width - margin &&
      screenY < size.height - margin;
    if (visible) return;

    setView((current) => ({
      ...current,
      x: size.width / 2 - point.x * current.scale,
      y: size.height / 2 - point.y * current.scale,
    }));
    // Only when the turn moves, not on every pan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTokenId]);

  const firstFocusRender = useRef(true);
  useEffect(() => {
    if (firstFocusRender.current) {
      firstFocusRender.current = false;
      return;
    }
    // After the layout has settled at its new width.
    const timer = setTimeout(fitToMap, 60);
    return () => clearTimeout(timer);
  }, [focused]);

  // Easy to get lost after zooming into a corner.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const el = event.target as HTMLElement | null;
      if (el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return;
      if (event.key === 'f' || event.key === 'F') fitToMap();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fitToMap]);

  /** Pointer position in grid units, or null if it is off-stage. */
  function pointerGrid(event: Konva.KonvaEventObject<MouseEvent>) {
    const stage = event.target.getStage();
    const pointer = stage?.getPointerPosition();
    if (!stage || !pointer) return null;

    return pixelToGrid(
      { x: (pointer.x - stage.x()) / stage.scaleX(), y: (pointer.y - stage.y()) / stage.scaleY() },
      grid,
    );
  }

  const onWheel = useCallback((event: Konva.KonvaEventObject<WheelEvent>) => {
    event.evt.preventDefault();
    const stage = event.target.getStage();
    const pointer = stage?.getPointerPosition();
    if (!stage || !pointer) return;

    const oldScale = stage.scaleX();
    // Zoom toward the cursor rather than the origin.
    const mousePoint = {
      x: (pointer.x - stage.x()) / oldScale,
      y: (pointer.y - stage.y()) / oldScale,
    };
    const direction = event.evt.deltaY > 0 ? -1 : 1;
    const scale = Math.max(0.1, Math.min(5, oldScale * (direction > 0 ? 1.1 : 1 / 1.1)));

    setView({
      scale,
      x: pointer.x - mousePoint.x * scale,
      y: pointer.y - mousePoint.y * scale,
    });
  }, []);

  if (!scene) {
    return (
      <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-ink-700 bg-ink-900">
        <p className="max-w-xs text-center text-sm text-ink-500">
          {isDM
            ? 'No active scene. Create one and upload a map to get started.'
            : 'The DM has not opened a map yet.'}
        </p>
      </div>
    );
  }

  const grid = { gridSize: scene.gridSize, offsetX: scene.gridOffsetX, offsetY: scene.gridOffsetY };
  const selected = tokens.find((t) => t.id === selectedTokenId) ?? null;
  const targeted = tokens.find((t) => t.id === targetTokenId) ?? null;
  // Mirrors the server's rule, so a player is not offered a gesture that will
  // be silently dropped. The server decides; this only avoids the dead click.
  const canPoint = isDM || scene.playerDrawing;

  return (
    <div
      ref={setContainer}
      className={`relative h-full overflow-hidden rounded-xl border border-ink-700 bg-ink-950 ${
        wallTool === 'off' ? '' : 'cursor-crosshair'
      }`}
    >
      {/* Not before the container has been measured. Konva draws each layer by
          handing its canvas to `drawImage`, and a canvas of zero width throws
          InvalidStateError - which it did on every board mount, filling the
          console with an error that has nothing to do with whatever you are
          actually debugging. The observer fires on the same frame. */}
      {size.width > 0 && size.height > 0 && (
      <Stage
        width={size.width}
        height={size.height}
        scaleX={view.scale}
        scaleY={view.scale}
        x={view.x}
        y={view.y}
        // Panning is suspended while drawing, or the map slides under the pen.
        draggable={!drawingMode && !groundBrush}
        // A ping is decided at mousedown, by which time Konva has already armed
        // a stage drag - and a dragging stage swallows the mousemoves the
        // stroke is made of, so the line came out as a stub near the release
        // point. Cancelling the drag here is what makes alt-drag draw at all.
        onDragStart={(e) => {
          // Same reason as the ping stroke: a dragging stage swallows the
          // mousemoves a painted run is made of.
          if (pinging.current || painting.current) e.target.stopDrag();
        }}
        onWheel={onWheel}
        onMouseDown={(e) => {
          // Alt-drag points at something without leaving anything behind.
          if (e.evt.altKey && !drawingMode && canPoint) {
            const point = pointerGrid(e);
            if (point) {
              pinging.current = true;
              setPingStroke([point.x, point.y]);
            }
            return;
          }
          if (groundBrush && isDM) {
            const point = pointerGrid(e);
            if (point) {
              painting.current = true;
              paintSquare(point);
            }
            return;
          }
          if (!drawingMode) return;
          const point = pointerGrid(e);
          if (point) setStroke([point.x, point.y]);
        }}
        onMouseMove={(e) => {
          // Appended through the updater, never from the rendered value: mouse
          // moves arrive faster than React re-renders, and reading the closed
          // -over array meant each batch of moves overwrote the last, leaving a
          // stub of a stroke instead of the line that was drawn.
          if (pingStroke) {
            const point = pointerGrid(e);
            if (point) setPingStroke((current) => (current ? [...current, point.x, point.y] : current));
            return;
          }
          if (painting.current) {
            const point = pointerGrid(e);
            if (point) paintSquare(point);
            return;
          }

          // Track the cursor for the preview whenever a tool is out. Before the
          // drawing branch below, which returns early on every move that is not
          // extending a stroke - and a wall run is exactly that.
          if (wallTool !== 'off') setSnapAt(pointerGrid(e));

          if (!drawingMode || !stroke) return;
          const point = pointerGrid(e);
          if (!point) return;

          // An arrow only ever needs its two ends.
          if (wallTool === 'arrow') setStroke((current) => (current ? [current[0], current[1], point.x, point.y] : current));
          else setStroke((current) => (current ? [...current, point.x, point.y] : current));
        }}
        onMouseLeave={() => setSnapAt(null)}
        onMouseUp={() => {
          if (pingStroke) {
            // A drag draws; a click without one falls through to the plain dot
            // the click handler already sends.
            if (pingStroke.length >= 4) {
              pingMap(pingStroke[0], pingStroke[1], pingStroke.slice(0, PING_STROKE_LIMIT));
            }
            pinging.current = false;
            setPingStroke(null);
            return;
          }
          if (painting.current) {
            painting.current = false;
            flushPaint();
            return;
          }
          if (!drawingMode || !stroke) return;
          if (stroke.length >= 4) {
            addDrawing(wallTool === 'arrow' ? 'arrow' : 'freehand', stroke, myColor);
          }
          setStroke(null);
        }}
        // Guarded like onClick below, and for the same reason: Konva bubbles
        // drag events, so a token's dragend arrives here with the TOKEN as
        // target. Unguarded, dropping a token wrote the token's pixel position
        // into the map's pan origin and the whole scene jumped.
        onDragEnd={(e) => {
          if (e.target !== e.target.getStage()) return;
          setView((v) => ({ ...v, x: e.target.x(), y: e.target.y() }));
        }}
        onClick={(e) => {
          if (e.target !== e.target.getStage() && e.target.name() !== 'map') return;

          const stage = e.target.getStage();
          const pointer = stage?.getPointerPosition();
          if (!stage || !pointer) return;

          const point = pixelToGrid(
            { x: (pointer.x - stage.x()) / stage.scaleX(), y: (pointer.y - stage.y()) / stage.scaleY() },
            grid,
          );

          // Pins and walls are the DM's. Reachable today only because the tool
          // buttons live in a DM-only panel, and the server rejects both anyway
          // - but `wallTool` sits in the shared store, so "no button" is not a
          // permission check.
          if (wallTool === 'note') {
            if (isDM) void placeNote(Math.round(point.x * 2) / 2, Math.round(point.y * 2) / 2);
            return;
          }

          // Named, not "anything but off". Every tool that is not a wall was
          // laying wall points as well as doing its own job: a paint stroke ends
          // in a click, so dragging mud across a lake quietly dropped a wall
          // corner, and the stroke after it joined the two into a real wall.
          // Two walls appeared on a scene where nothing but ground was painted.
          if ((wallTool === 'wall' || wallTool === 'door' || wallTool === 'secret') && isDM) {
            // Walls snap to grid corners so they line up with the map's own
            // architecture rather than landing at arbitrary fractions.
            const snapped = { x: Math.round(point.x), y: Math.round(point.y) };
            if (!wallStart) {
              setWallStart(snapped);
            } else {
              createWall(wallStart.x, wallStart.y, snapped.x, snapped.y, wallTool === 'door' ? 'door' : wallTool === 'secret' ? 'secret' : 'wall');
              // Chain from the end point, so drawing a room is a run of clicks.
              setWallStart(snapped);
            }
            return;
          }

          if (e.evt.altKey) {
            if (canPoint) pingMap(point.x, point.y);
          } else {
            select(null);
            target(null);
          }
        }}
        onDblClick={() => setWallStart(null)}
      >
        <Layer>
          {mapImage && (
            <KonvaImage image={mapImage} name="map" width={scene.mapWidth} height={scene.mapHeight} />
          )}
          {!mapImage && (
            // `name="map"` matters as much here as on the image: the stage's
            // click handler accepts the stage itself or the map, and this Rect
            // covers the whole board. Without the name it was neither, so on a
            // scene with no map uploaded *every* tool silently did nothing -
            // walls, pins, pings and click-to-deselect alike. A grid-only scene
            // is a perfectly ordinary way to run a fight, and this made it look
            // like the board was broken.
            <Rect
              name="map"
              width={scene.mapWidth || 1400}
              height={scene.mapHeight || 900}
              fill="#121017"
            />
          )}
        </Layer>

        {scene.gridVisible && (
          <Layer listening={false}>
            <GridLines scene={scene} />
          </Layer>
        )}

        {/*
          Where the next click will actually land.
          Each tool snaps to a different increment - a wall to the grid corner, a
          pin to the half square, a brush to the whole square - and until now the
          only clue was the text under the board naming the tool. Aiming a run of
          walls meant clicking and looking.
        */}
        {snapAt && wallTool !== 'off' && (
          <Layer listening={false}>
            <SnapPreview point={snapAt} tool={wallTool} grid={grid} from={wallStart} />
          </Layer>
        )}

        {isDM && (
          <Layer>
            <WallLayer walls={walls} grid={grid} erasing={erasing} onDelete={deleteWall} />
          </Layer>
        )}

        <Layer>
          <DoorLayer
            doors={doors}
            grid={grid}
            isDM={isDM}
            onToggle={toggleDoor}
            onReveal={(wallId) => updateWall(wallId, { door: 1 })}
            onLock={(wallId, locked) => updateWall(wallId, { doorState: locked ? 2 : 0 })}
          />
          <NoteLayer
            notes={notes}
            grid={grid}
            isDM={isDM}
            erasing={erasing}
            onToggle={(id, hidden) => void toggleNote(id, hidden)}
            onRemove={(id) => void removeNote(id)}
          />
        </Layer>

        {/* Light sits under the tokens and over the map, like light does. */}
        <Layer listening={false}>
          <LightLayer
            tokens={tokens}
            grid={grid}
            feetPerSquare={scene.feetPerSquare}
            darkness={scene.darkness}
          />
        </Layer>

        <Layer>
          <DrawingLayer
            drawings={drawings}
            grid={grid}
            pending={stroke}
            pendingColor={myColor}
            onErase={eraseDrawing}
            canErase={(drawing) => isDM || drawing.ownerUserId === user?.id}
          />
        </Layer>

        {/* Below the tokens, so an outline never hides who is standing in it. */}
        <Layer>
          <TemplateLayer
            templates={templates}
            grid={grid}
            feetPerSquare={scene.feetPerSquare}
            onClear={clearTemplate}
          />
        </Layer>

        {/* Under the tokens too, and under the fog - which draws above them -
            so a player's range is covered wherever their sight is. */}
        {/* DM only, and above the map but under the tokens: it describes the
            ground, not what is standing on it. */}
        {isDM && (
          <Layer listening={false}>
            <TerrainLayer grid={grid} terrain={terrain} />
          </Layer>
        )}

        <Layer listening={false}>
          <MovementLayer
            grid={grid}
            moveSquares={moveRange.tokenId === selectedTokenId ? moveRange.squares : []}
            moveDisposition={selected?.disposition ?? 'friendly'}
            threatSquares={showThreat ? threatRange : []}
          />
        </Layer>

        <Layer>
          {tokens
            .filter((t) => t.layer !== 'gm' || isDM)
            .map((token) => (
              <TokenShape
                active={token.id === activeTokenId}
                onHover={setHovered}
                key={token.id}
                token={token}
                grid={grid}
                selected={token.id === selectedTokenId}
                targeted={token.id === targetTokenId}
                // A player may drag only their own tokens; the DM drags anything.
                draggable={isDM || (token.ownerUserId === user?.id && !token.locked)}
                onSelect={(withShift) => {
                  if (withShift) target(token.id === targetTokenId ? null : token.id);
                  else select(token.id);
                }}
                onMove={moveToken}
                onCommit={commitToken}
              />
            ))}
        </Layer>

        {/* Fog sits above the tokens so anything outside sight is covered, and
            below the overlay so pings and rulers stay readable. */}
        {vision && (
          <Layer listening={false}>
            <FogLayer
              scene={scene}
              vision={vision}
              grid={grid}
              own={tokens.filter((t) => t.ownerUserId === user?.id)}
            />
          </Layer>
        )}

        <Layer listening={false}>
          {/* Reach readout while a target is chosen. */}
          {selected && targeted && selected.id !== targeted.id && (
            <ReachLine from={selected} to={targeted} scene={scene} grid={grid} />
          )}
          {/* A dragged ping is a line in the pointer's own colour; a clicked
              one is still a ring. Both expire on their own - neither is a
              drawing, and neither is ever written down. */}
          {pings.map((ping) =>
            ping.points.length >= 4 ? (
              <Line
                key={ping.id}
                points={toPixelPath(ping.points, grid)}
                stroke={ping.color}
                strokeWidth={4}
                lineCap="round"
                lineJoin="round"
                tension={0.3}
                opacity={0.85}
              />
            ) : (
              <PingPulse key={ping.id} ping={ping} grid={grid} gridSize={scene.gridSize} />
            ),
          )}
          {/* The local drag, before release - so it tracks the cursor with no
              round trip. */}
          {pingStroke && pingStroke.length >= 4 && (
            <Line
              points={toPixelPath(pingStroke, grid)}
              stroke={myColor}
              strokeWidth={4}
              lineCap="round"
              lineJoin="round"
              tension={0.3}
              opacity={0.6}
            />
          )}
        </Layer>
        {/* Weather is drawn last, in view space, so panning does not drag the
            rain sideways with the terrain. */}
        <Layer
          listening={false}
          x={-view.x / view.scale}
          y={-view.y / view.scale}
          scaleX={1 / view.scale}
          scaleY={1 / view.scale}
        >
          <WeatherLayer
            weather={scene.weather}
            intensity={scene.weatherIntensity}
            width={size.width}
            height={size.height}
          />
        </Layer>
      </Stage>
      )}

      {hovered && (
        <div
          className="pointer-events-none absolute top-2 left-2 rounded border border-ink-700 bg-ink-950/90 px-2 py-1"
          // HTML rather than a Konva label, so it stays sharp however far the
          // board is zoomed out.
        >
          <div className="text-xs text-ink-100">{hovered.name || 'Token'}</div>
          <div className="text-[10px] text-ink-500">
            {hovered.maxHp !== null ? `${hovered.hp}/${hovered.maxHp} HP` : 'no hit points'}
            {hovered.ac !== null ? ` · AC ${hovered.ac}` : ''}
            {hovered.conditions.length > 0 ? ` · ${hovered.conditions.join(', ')}` : ''}
          </div>
        </div>
      )}

      <div className="absolute top-2 right-2 flex gap-1">
        {onToggleFocus && (
          <button
            onClick={onToggleFocus}
            title="Hide the side panels and give the board the whole window (backslash)"
            className={`rounded border px-2 py-1 text-[10px] transition-colors ${
              focused
                ? 'border-ember-500 bg-ember-500/20 text-ember-300'
                : 'border-ink-700 bg-ink-950/85 text-ink-400 hover:border-ember-500 hover:text-ember-300'
            }`}
          >
            {focused ? 'Exit focus' : 'Focus'}
          </button>
        )}
        <button
          onClick={toggleThreat}
          title="Show how far every enemy you can see could move (R)"
          className={`rounded border px-2 py-1 text-[10px] transition-colors ${
            showThreat
              ? 'border-red-500 bg-red-500/20 text-red-300'
              : 'border-ink-700 bg-ink-950/85 text-ink-400 hover:border-red-500 hover:text-red-300'
          }`}
        >
          Threat
        </button>
        <button
          onClick={fitToMap}
          title="Fit the map to the window (F)"
          className="rounded border border-ink-700 bg-ink-950/85 px-2 py-1 text-[10px] text-ink-400 transition-colors hover:border-ember-500 hover:text-ember-300"
        >
          Fit
        </button>
      </div>

      {/* Collapsed to a corner button by default: the hint is worth reading
          once and then in the way of the map for every session after. Tool
          hints stay visible, because those change under you. */}
      <div className="absolute bottom-2 left-2 flex items-end gap-1.5">
        <button
          onClick={() => {
            setHints(!hints);
            setPref('board-hints', !hints);
          }}
          title={hints ? 'Hide the shortcut hints' : 'Show the shortcut hints'}
          className="rounded bg-ink-950/80 px-1.5 py-1 text-[10px] text-ink-500 transition-colors hover:text-ink-200"
        >
          {hints ? '×' : '?'}
        </button>
        {(hints || wallTool !== 'off') && (
          <div className="pointer-events-none rounded bg-ink-950/80 px-2 py-1 text-[10px] text-ink-500">
            {wallTool !== 'off'
              ? wallTool === 'note'
                ? 'click to drop a pin — click a pin to reveal it, alt-click to delete'
                : wallTool === 'secret'
                  ? 'drawing a secret passage — players are never sent it; alt-click a dotted seam to reveal it'
                  : // Ground is painted by dragging over squares, not by placing
                    // a run of points, so it needs its own line - this one read
                    // "drawing waters — click to place points", which describes
                    // the wall tool and nothing the brush actually does.
                    erasing
                    ? 'click a wall or a pin to delete it'
                    : groundBrush
                    ? groundHint(groundBrush)
                    : `drawing ${wallTool}s — click to place points, double-click to finish, alt-click a wall to delete`
              : isDM
                ? 'scroll to zoom · drag to pan · alt-click a door to lock it · shift-click a token to target · ? for keys'
                : 'scroll to zoom · drag to pan · alt-click to ping, alt-drag to draw one · shift-click a token to target · ? for keys'}
          </div>
        )}
      </div>

      {wallStart && (
        <div className="pointer-events-none absolute top-2 left-2 rounded bg-arcane-500/20 px-2 py-1 text-[10px] text-arcane-400">
          from ({wallStart.x}, {wallStart.y})
        </div>
      )}
    </div>
  );
}

/**
 * A ping, as a ring that expands and fades a few times.
 *
 * A static circle was easy to miss on a busy board - the whole point of a ping
 * is to pull eyes to a spot. Animated with `requestAnimationFrame` and a tick,
 * the same approach `AtmosphereLayer` already uses; Konva's own tweens would
 * mean reaching around react-konva to mutate nodes directly.
 */
function PingPulse({
  ping,
  grid,
  gridSize,
}: {
  ping: { x: number; y: number; color: string };
  grid: { gridSize: number; offsetX: number; offsetY: number };
  gridSize: number;
}) {
  const start = useRef(Date.now());
  const [, setTick] = useState(0);

  useEffect(() => {
    let frame = 0;
    const step = () => {
      setTick((t) => (t + 1) % 1000);
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, []);

  const PERIOD = 900;
  // Where we are within the current pulse, 0..1.
  const phase = ((Date.now() - start.current) % PERIOD) / PERIOD;
  const point = gridToPixel({ x: ping.x, y: ping.y }, grid);

  // Grows from a third of a square to about 1.2, fading as it goes - big
  // enough to catch the eye, small enough not to cover the board.
  const radius = gridSize * (0.35 + phase * 0.85);
  const opacity = 0.9 * (1 - phase);

  return (
    <>
      <Circle x={point.x} y={point.y} radius={radius} stroke={ping.color} strokeWidth={3} opacity={opacity} />
      {/* A steady dot underneath, so the mark is readable between pulses. */}
      <Circle x={point.x} y={point.y} radius={gridSize * 0.12} fill={ping.color} opacity={0.85} />
    </>
  );
}

function GridLines({ scene }: { scene: WireScene }) {
  const lines = useMemo(() => {
    const width = scene.mapWidth || 1400;
    const height = scene.mapHeight || 900;
    const out: number[][] = [];

    for (let x = scene.gridOffsetX; x <= width; x += scene.gridSize) out.push([x, 0, x, height]);
    for (let y = scene.gridOffsetY; y <= height; y += scene.gridSize) out.push([0, y, width, y]);
    return out;
  }, [scene.mapWidth, scene.mapHeight, scene.gridSize, scene.gridOffsetX, scene.gridOffsetY]);

  return (
    <>
      {lines.map((points, index) => (
        <Line key={index} points={points} stroke="#ffffff" strokeWidth={1} opacity={0.12} />
      ))}
    </>
  );
}

function ReachLine({
  from,
  to,
  scene,
  grid,
}: {
  from: WireToken;
  to: WireToken;
  scene: WireScene;
  grid: { gridSize: number; offsetX: number; offsetY: number };
}) {
  // Footprint to footprint, so a Gargantuan target reads its true reach.
  const feet = tokenDistanceInFeet(from, to, 'standard', scene.feetPerSquare);

  const a = gridToPixel({ x: from.x + from.w / 2, y: from.y + from.h / 2 }, grid);
  const b = gridToPixel({ x: to.x + to.w / 2, y: to.y + to.h / 2 }, grid);

  return (
    <>
      <Line points={[a.x, a.y, b.x, b.y]} stroke="#e8853f" strokeWidth={2} dash={[8, 6]} opacity={0.8} />
      <Text
        x={(a.x + b.x) / 2}
        y={(a.y + b.y) / 2 - scene.gridSize * 0.35}
        text={`${feet} ft`}
        fontSize={scene.gridSize * 0.32}
        fill="#f2a86b"
        align="center"
      />
    </>
  );
}

function TokenShape({
  token,
  grid,
  selected,
  targeted,
  draggable,
  onSelect,
  onMove,
  onCommit,
  onHover,
  active,
}: {
  token: WireToken;
  grid: { gridSize: number; offsetX: number; offsetY: number };
  selected: boolean;
  targeted: boolean;
  draggable: boolean;
  onSelect: (withShift: boolean) => void;
  onMove: (id: string, x: number, y: number) => void;
  onCommit: (id: string, x: number, y: number) => void;
  onHover: (token: WireToken | null) => void;
  active: boolean;
}) {
  const image = useImage(token.imageUrl);
  const lastEmit = useRef(0);

  const position = gridToPixel({ x: token.x, y: token.y }, grid);
  const width = token.w * grid.gridSize;
  const height = token.h * grid.gridSize;
  /**
   * A chosen ring wins over the allegiance one.
   *
   * Only ever set on a token somebody owns, and the palette holds no red or
   * green - so hostile and neutral still read as themselves, while four party
   * members stop being four identical blue circles.
   */
  const ring = token.ringColor ?? DISPOSITION_COLOR[token.disposition] ?? '#a9a3bd';

  const hpPercent = token.maxHp && token.maxHp > 0 ? Math.max(0, (token.hp ?? 0) / token.maxHp) : null;

  // Conditions read off the board rather than out of a panel.
  const badges = tokenBadges(token.conditions);
  const down = isDown(token.hp, token.maxHp);

  return (
    <Group
      x={position.x}
      y={position.y}
      onMouseEnter={() => onHover(token)}
      onMouseLeave={() => onHover(null)}
      draggable={draggable}
      opacity={token.hidden ? 0.45 : 1}
      onClick={(e) => {
        e.cancelBubble = true;
        onSelect(e.evt.shiftKey);
      }}
      onMouseDown={(e) => {
        // A token you cannot drag registers no drag listener of its own, so the
        // mousedown reached the Stage and started a pan - the map slid away
        // under a player trying to move someone else's token. Alt still passes
        // through, because pinging over a token is fair.
        if (!draggable && !e.evt.altKey) e.cancelBubble = true;
      }}
      onDragMove={(e) => {
        // Konva bubbles drag events up to the Stage, which pans on them.
        // Moving a token is not panning, so stop it here as well as guarding
        // the Stage's own handler.
        e.cancelBubble = true;

        // Throttled to ~30Hz: the wire carries position only, and the server
        // rebroadcasts without touching the database.
        const now = Date.now();
        if (now - lastEmit.current < TOKEN_MOVE_THROTTLE_MS) return;
        lastEmit.current = now;

        const point = pixelToGrid({ x: e.target.x(), y: e.target.y() }, grid);
        onMove(token.id, point.x, point.y);
      }}
      onDragEnd={(e) => {
        e.cancelBubble = true;
        const raw = pixelToGrid({ x: e.target.x(), y: e.target.y() }, grid);
        const snapped = snapTokenPosition(raw, token.w, token.h);
        // Settle locally on the snapped position so it does not visibly jump
        // when the server's authoritative value arrives.
        const pixel = gridToPixel(snapped, grid);
        e.target.position(pixel);
        onCommit(token.id, snapped.x, snapped.y);
      }}
    >
      {image ? (
        <KonvaImage image={image} width={width} height={height} cornerRadius={width / 2} />
      ) : (
        <Circle
          x={width / 2}
          y={height / 2}
          radius={Math.min(width, height) / 2 - 2}
          fill="#2a2635"
          stroke={ring}
          strokeWidth={2}
        />
      )}

      {active && (
        <Circle
          x={width / 2}
          y={height / 2}
          radius={Math.min(width, height) / 2 + Math.max(3, grid.gridSize * 0.08)}
          stroke="#f2a86b"
          strokeWidth={Math.max(2, grid.gridSize * 0.045)}
          dash={[grid.gridSize * 0.12, grid.gridSize * 0.09]}
          shadowColor="#e8853f"
          shadowBlur={grid.gridSize * 0.18}
          listening={false}
        />
      )}

      <Circle
        x={width / 2}
        y={height / 2}
        radius={Math.min(width, height) / 2 - 1}
        stroke={down ? '#7d1d1d' : targeted ? '#e8853f' : selected ? '#8b7bf0' : ring}
        strokeWidth={targeted || selected ? 3.5 : 2}
        dash={targeted ? [6, 4] : undefined}
      />

      {/* Allegiance, in a corner where nothing else competes for the colour.
          The ring is last in precedence behind down/targeted/selected, so it
          disappears exactly when you are working with a token - and it only
          ever reached the placeholder circle on tokens with no art. */}
      <Circle
        x={width - Math.min(width, height) * 0.14}
        y={Math.min(width, height) * 0.14}
        radius={Math.max(3, Math.min(width, height) * 0.09)}
        fill={ring}
        stroke="#0b0a10"
        strokeWidth={1.5}
      />

      {/* Down: dimmed and struck through, so it is obvious at a glance which
          bodies on the board are still a threat. */}
      {down && (
        <>
          <Circle
            x={width / 2}
            y={height / 2}
            radius={Math.min(width, height) / 2 - 1}
            fill="#0b0a0f"
            opacity={0.55}
            listening={false}
          />
          <Line
            points={[width * 0.2, height * 0.2, width * 0.8, height * 0.8]}
            stroke="#e05252"
            strokeWidth={Math.max(2, grid.gridSize * 0.05)}
            listening={false}
          />
          <Line
            points={[width * 0.8, height * 0.2, width * 0.2, height * 0.8]}
            stroke="#e05252"
            strokeWidth={Math.max(2, grid.gridSize * 0.05)}
            listening={false}
          />
        </>
      )}

      {!image && (
        <Text
          width={width}
          y={height / 2 - grid.gridSize * 0.16}
          text={token.name.slice(0, 2).toUpperCase()}
          fontSize={grid.gridSize * 0.32}
          fill="#cec9dd"
          align="center"
        />
      )}

      {hpPercent !== null && (
        <>
          <Rect y={height - 6} width={width} height={5} fill="#0b0a0f" opacity={0.75} cornerRadius={2} />
          <Rect
            y={height - 6}
            width={width * hpPercent}
            height={5}
            fill={hpPercent <= 0.5 ? '#d9691f' : '#059669'}
            cornerRadius={2}
          />
        </>
      )}

      {/* Ringed across the top edge, where they do not cover the art. */}
      {badges.glyphs.map((badge, index) => {
        const size = Math.max(9, grid.gridSize * 0.2);
        const step = size * 1.15;
        const count = badges.glyphs.length + (badges.overflow > 0 ? 1 : 0);
        const startX = width / 2 - ((count - 1) * step) / 2;

        return (
          <Group key={badge.condition} x={startX + index * step} y={-size * 0.55}>
            <Circle radius={size * 0.62} fill="#12101ad9" stroke="#6d5ce7" strokeWidth={1} />
            <Text
              x={-size * 0.62}
              y={-size * 0.42}
              width={size * 1.24}
              text={badge.glyph}
              fontSize={size * 0.78}
              fill="#cec9dd"
              align="center"
              listening={false}
            />
          </Group>
        );
      })}

      {badges.overflow > 0 && (
        <Group
          x={
            width / 2 +
            ((badges.glyphs.length + 1 - 1) * Math.max(9, grid.gridSize * 0.2) * 1.15) / 2
          }
          y={-Math.max(9, grid.gridSize * 0.2) * 0.55}
        >
          <Circle
            radius={Math.max(9, grid.gridSize * 0.2) * 0.62}
            fill="#12101ad9"
            stroke="#6d5ce7"
            strokeWidth={1}
          />
          <Text
            x={-Math.max(9, grid.gridSize * 0.2) * 0.62}
            y={-Math.max(9, grid.gridSize * 0.2) * 0.4}
            width={Math.max(9, grid.gridSize * 0.2) * 1.24}
            text={`+${badges.overflow}`}
            fontSize={Math.max(9, grid.gridSize * 0.2) * 0.62}
            fill="#a9a3bd"
            align="center"
            listening={false}
          />
        </Group>
      )}

      {token.hidden && (
        <Text
          width={width}
          y={-grid.gridSize * 0.28}
          text="hidden"
          fontSize={grid.gridSize * 0.2}
          fill="#7d7794"
          align="center"
        />
      )}
    </Group>
  );
}

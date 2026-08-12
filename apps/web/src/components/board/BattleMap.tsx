import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Circle, Group, Image as KonvaImage, Layer, Line, Rect, Stage, Text } from 'react-konva';
import {
  TOKEN_MOVE_THROTTLE_MS,
  gridToPixel,
  pixelToGrid,
  snapTokenPosition,
  tokenDistanceInFeet,
} from '@dnd/shared';
import type Konva from 'konva';
import type { WireScene, WireToken } from '@dnd/shared';
import { DoorLayer, FogLayer, NoteLayer, WallLayer } from './FogLayer.js';
import { DrawingLayer, colorForUser } from './DrawingLayer.js';
import { TemplateLayer } from './TemplateLayer.js';
import { LightLayer, WeatherLayer } from './AtmosphereLayer.js';
import { useTable } from '../../store/table.js';
import { useAuth } from '../../store/auth.js';

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

const DISPOSITION_COLOR: Record<string, string> = {
  friendly: '#34d399',
  neutral: '#a9a3bd',
  hostile: '#f87171',
};

export function BattleMap({ isDM }: { isDM: boolean }) {
  const {
    scene, tokens, selectedTokenId, targetTokenId, pings, vision, doors, walls, wallTool, templates, notes,
    drawings,
    select, target, moveToken, commitToken, pingMap, createWall, deleteWall, toggleDoor, clearTemplate,
    placeNote, toggleNote, removeNote, addDrawing, eraseDrawing,
  } = useTable();


  // Where the DM clicked first while drawing a wall segment.
  const [wallStart, setWallStart] = useState<{ x: number; y: number } | null>(null);
  const { user } = useAuth();

  // The stroke in progress, kept local so it tracks the cursor with no round
  // trip; it is sent once on release.
  const [stroke, setStroke] = useState<number[] | null>(null);
  const myColor = colorForUser(user?.id ?? '');
  const drawingMode = wallTool === 'draw' || wallTool === 'arrow';

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

  // Fit when the map first loads or the scene changes.
  useEffect(() => {
    fitToMap();
  }, [scene?.id, fitToMap]);

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

  return (
    <div
      ref={setContainer}
      className={`relative h-full overflow-hidden rounded-xl border border-ink-700 bg-ink-950 ${
        wallTool === 'off' ? '' : 'cursor-crosshair'
      }`}
    >
      <Stage
        width={size.width}
        height={size.height}
        scaleX={view.scale}
        scaleY={view.scale}
        x={view.x}
        y={view.y}
        // Panning is suspended while drawing, or the map slides under the pen.
        draggable={!drawingMode}
        onWheel={onWheel}
        onMouseDown={(e) => {
          if (!drawingMode) return;
          const point = pointerGrid(e);
          if (point) setStroke([point.x, point.y]);
        }}
        onMouseMove={(e) => {
          if (!drawingMode || !stroke) return;
          const point = pointerGrid(e);
          if (!point) return;

          // An arrow only ever needs its two ends.
          if (wallTool === 'arrow') setStroke([stroke[0], stroke[1], point.x, point.y]);
          else setStroke([...stroke, point.x, point.y]);
        }}
        onMouseUp={() => {
          if (!drawingMode || !stroke) return;
          if (stroke.length >= 4) {
            addDrawing(wallTool === 'arrow' ? 'arrow' : 'freehand', stroke, myColor);
          }
          setStroke(null);
        }}
        onDragEnd={(e) => setView((v) => ({ ...v, x: e.target.x(), y: e.target.y() }))}
        onClick={(e) => {
          if (e.target !== e.target.getStage() && e.target.name() !== 'map') return;

          const stage = e.target.getStage();
          const pointer = stage?.getPointerPosition();
          if (!stage || !pointer) return;

          const point = pixelToGrid(
            { x: (pointer.x - stage.x()) / stage.scaleX(), y: (pointer.y - stage.y()) / stage.scaleY() },
            grid,
          );

          if (wallTool === 'note') {
            void placeNote(Math.round(point.x * 2) / 2, Math.round(point.y * 2) / 2);
            return;
          }

          if (wallTool !== 'off') {
            // Walls snap to grid corners so they line up with the map's own
            // architecture rather than landing at arbitrary fractions.
            const snapped = { x: Math.round(point.x), y: Math.round(point.y) };
            if (!wallStart) {
              setWallStart(snapped);
            } else {
              createWall(wallStart.x, wallStart.y, snapped.x, snapped.y, wallTool === 'door');
              // Chain from the end point, so drawing a room is a run of clicks.
              setWallStart(snapped);
            }
            return;
          }

          if (e.evt.altKey) {
            pingMap(point.x, point.y);
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
            <Rect width={scene.mapWidth || 1400} height={scene.mapHeight || 900} fill="#121017" />
          )}
        </Layer>

        {scene.gridVisible && (
          <Layer listening={false}>
            <GridLines scene={scene} />
          </Layer>
        )}

        {isDM && (
          <Layer>
            <WallLayer walls={walls} grid={grid} onDelete={deleteWall} />
          </Layer>
        )}

        <Layer>
          <DoorLayer doors={doors} grid={grid} onToggle={toggleDoor} />
          <NoteLayer
            notes={notes}
            grid={grid}
            isDM={isDM}
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

        <Layer>
          {tokens
            .filter((t) => t.layer !== 'gm' || isDM)
            .map((token) => (
              <TokenShape
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
            <FogLayer scene={scene} vision={vision} grid={grid} />
          </Layer>
        )}

        <Layer listening={false}>
          {/* Reach readout while a target is chosen. */}
          {selected && targeted && selected.id !== targeted.id && (
            <ReachLine from={selected} to={targeted} scene={scene} grid={grid} />
          )}
          {pings.map((ping) => {
            const point = gridToPixel({ x: ping.x, y: ping.y }, grid);
            return (
              <Circle
                key={ping.id}
                x={point.x}
                y={point.y}
                radius={scene.gridSize * 0.6}
                stroke={ping.color}
                strokeWidth={3}
                opacity={0.9}
              />
            );
          })}
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

      <button
        onClick={fitToMap}
        title="Fit the map to the window (F)"
        className="absolute top-2 right-2 rounded border border-ink-700 bg-ink-950/85 px-2 py-1 text-[10px] text-ink-400 transition-colors hover:border-ember-500 hover:text-ember-300"
      >
        Fit
      </button>

      <div className="pointer-events-none absolute bottom-2 left-2 rounded bg-ink-950/80 px-2 py-1 text-[10px] text-ink-500">
        {wallTool !== 'off'
          ? wallTool === 'note'
            ? 'click to drop a pin — click a pin to reveal it, alt-click to delete'
            : `drawing ${wallTool}s — click to place points, double-click to finish, alt-click a wall to delete`
          : 'scroll to zoom · drag to pan · alt-click to ping · shift-click a token to target · ? for keys'}
      </div>

      {wallStart && (
        <div className="pointer-events-none absolute top-2 left-2 rounded bg-arcane-500/20 px-2 py-1 text-[10px] text-arcane-400">
          from ({wallStart.x}, {wallStart.y})
        </div>
      )}
    </div>
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
}) {
  const image = useImage(token.imageUrl);
  const lastEmit = useRef(0);

  const position = gridToPixel({ x: token.x, y: token.y }, grid);
  const width = token.w * grid.gridSize;
  const height = token.h * grid.gridSize;
  const ring = DISPOSITION_COLOR[token.disposition] ?? '#a9a3bd';

  const hpPercent = token.maxHp && token.maxHp > 0 ? Math.max(0, (token.hp ?? 0) / token.maxHp) : null;

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
      onDragMove={(e) => {
        // Throttled to ~30Hz: the wire carries position only, and the server
        // rebroadcasts without touching the database.
        const now = Date.now();
        if (now - lastEmit.current < TOKEN_MOVE_THROTTLE_MS) return;
        lastEmit.current = now;

        const point = pixelToGrid({ x: e.target.x(), y: e.target.y() }, grid);
        onMove(token.id, point.x, point.y);
      }}
      onDragEnd={(e) => {
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

      <Circle
        x={width / 2}
        y={height / 2}
        radius={Math.min(width, height) / 2 - 1}
        stroke={targeted ? '#e8853f' : selected ? '#8b7bf0' : ring}
        strokeWidth={targeted || selected ? 3.5 : 2}
        dash={targeted ? [6, 4] : undefined}
      />

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

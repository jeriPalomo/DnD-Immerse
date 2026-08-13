import { and, eq } from 'drizzle-orm';
import {
  combinedVisibility,
  decodeFog,
  encodeFog,
  exploredCells,
  markVisible,
  pointInAnyPolygon,
  sightRadiusFeet,
  tokenCenter,
} from '@dnd/shared';
import type { Polygon, WireDoor, WireVision, WireWall } from '@dnd/shared';
import { db } from '../db/index.js';
import { fogExploration, walls as wallsTable } from '../db/schema.js';
import type { Scene, Token, Wall } from '../db/schema.js';

/**
 * Server-side line of sight.
 *
 * The whole point of computing this here rather than in the browser: a player
 * receives their visibility polygon and the tokens inside it, and nothing else.
 * The walls that produced the polygon stay with the DM, because wall geometry
 * is a readable map of the dungeon.
 */

/** Default sight when a token has none configured, in feet. */
const DEFAULT_VISION_FEET = 60;

/**
 * Fog extent for a scene with no map uploaded yet. Without a fallback the
 * bitmap has zero cells and exploration silently records nothing, which looks
 * exactly like fog being broken.
 */
const DEFAULT_GRID_EXTENT = 100;

function gridExtent(scene: Scene): { gridWidth: number; gridHeight: number } {
  if (scene.gridSize <= 0 || scene.mapWidth <= 0 || scene.mapHeight <= 0) {
    return { gridWidth: DEFAULT_GRID_EXTENT, gridHeight: DEFAULT_GRID_EXTENT };
  }
  return {
    gridWidth: Math.ceil(scene.mapWidth / scene.gridSize),
    gridHeight: Math.ceil(scene.mapHeight / scene.gridSize),
  };
}

export function toWireWall(wall: Wall): WireWall {
  return {
    id: wall.id,
    sceneId: wall.sceneId,
    x1: wall.x1,
    y1: wall.y1,
    x2: wall.x2,
    y2: wall.y2,
    blocksMovement: wall.blocksMovement,
    blocksSight: wall.blocksSight,
    door: wall.door,
    doorState: wall.doorState,
  };
}

/**
 * Doors are sent to players, walls are not.
 *
 * A door is a thing you can see and interact with; withholding it would make
 * the map unusable. The rest of the wall network stays hidden.
 */
export function toWireDoor(wall: Wall): WireDoor {
  return {
    id: wall.id,
    x1: wall.x1,
    y1: wall.y1,
    x2: wall.x2,
    y2: wall.y2,
    door: wall.door,
    doorState: wall.doorState,
  };
}

export async function wallsOf(sceneId: string): Promise<Wall[]> {
  return db.select().from(wallsTable).where(eq(wallsTable.sceneId, sceneId));
}

/**
 * The tokens a given user controls, which are the origins of their sight.
 *
 * With global illumination off, a token sees only as far as its own darkvision
 * or the light it carries - which is what makes turning daylight off actually
 * change the board rather than just flipping a stored flag.
 */
function sightSources(tokens: Token[], userId: string, scene: Scene) {
  return tokens
    .filter((token) => token.ownerUserId === userId && token.layer !== 'gm')
    .map((token) => ({
      point: tokenCenter(token),
      // Vision is configured in feet; the geometry works in grid units.
      radius:
        sightRadiusFeet(
          token,
          scene.globalIllumination,
          DEFAULT_VISION_FEET,
          scene.feetPerSquare,
          scene.darkness,
        ) / scene.feetPerSquare,
    }));
}

/**
 * Sight polygons only, with no database access at all.
 *
 * Used on every drag frame, where persisting fog would mean thousands of
 * writes per combat. The bitmap catches up on drop, via computePlayerView.
 */
export function computeLivePolygons(scene: Scene, walls: Wall[], tokens: Token[], userId: string): Polygon[] {
  if (!scene.visionEnabled) return [];
  return combinedVisibility(sightSources(tokens, userId, scene), walls);
}

export interface PlayerView {
  polygons: Polygon[];
  vision: WireVision;
}

/**
 * Computes what one player can currently see, and folds it into their
 * persistent fog record.
 */
export async function computePlayerView(
  scene: Scene,
  walls: Wall[],
  tokens: Token[],
  userId: string,
): Promise<PlayerView | null> {
  if (!scene.visionEnabled) return null;

  const { gridWidth, gridHeight } = gridExtent(scene);

  const sources = sightSources(tokens, userId, scene);
  const polygons = combinedVisibility(sources, walls);

  // Load, extend and persist this player's exploration.
  const existing = await db
    .select()
    .from(fogExploration)
    .where(and(eq(fogExploration.sceneId, scene.id), eq(fogExploration.userId, userId)))
    .limit(1);

  const fog = decodeFog(existing[0]?.exploredBitmap ?? '', gridWidth, gridHeight);
  const newlySeen = markVisible(fog, polygons);

  if (newlySeen > 0 || existing.length === 0) {
    await db
      .insert(fogExploration)
      .values({
        sceneId: scene.id,
        userId,
        gridWidth,
        gridHeight,
        exploredBitmap: encodeFog(fog),
        updatedAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: [fogExploration.sceneId, fogExploration.userId],
        set: { exploredBitmap: encodeFog(fog), gridWidth, gridHeight, updatedAt: Date.now() },
      });
  }

  return {
    polygons,
    vision: {
      polygons,
      explored: exploredCells(fog),
      gridWidth,
      gridHeight,
    },
  };
}

/**
 * Removes tokens the viewer cannot see.
 *
 * A token is visible when any part of its footprint falls inside the current
 * sight polygons. Previously-explored ground shows the remembered terrain but
 * NOT who is standing on it now — which is exactly why tokens are filtered
 * against `polygons` rather than against the fog bitmap.
 */
export function visibleTokens(tokens: Token[], polygons: Polygon[], userId: string): Token[] {
  if (polygons.length === 0) return tokens.filter((t) => t.ownerUserId === userId);

  return tokens.filter((token) => {
    // You always see your own tokens, even standing in the dark.
    if (token.ownerUserId === userId) return true;

    const corners = [
      { x: token.x, y: token.y },
      { x: token.x + token.w, y: token.y },
      { x: token.x, y: token.y + token.h },
      { x: token.x + token.w, y: token.y + token.h },
      tokenCenter(token),
    ];
    // Any corner inside is enough, so a Gargantuan creature poking out of a
    // doorway is not invisible.
    return corners.some((corner) => pointInAnyPolygon(corner, polygons));
  });
}

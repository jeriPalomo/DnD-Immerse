import { createFog, decodeFog, encodeFog, isExplored, markExplored, type FogBitmap } from './fog.js';

/**
 * Ground the DM has painted: squares nobody may enter, and squares that cost
 * double to cross.
 *
 * Built on the bitmaps in `fog.ts`, which are one bit per grid square and only
 * fog-shaped by name and history. A second implementation of the same thing
 * would be a second place for the `y * width + x` indexing to drift.
 *
 * A pillar is four wall segments and drawing it that way is fine. A lake, a
 * rubble field or a cave's ragged edge is not, which is what this is for.
 */
export interface TerrainMap {
  width: number;
  height: number;
  blocked: FogBitmap;
  difficult: FogBitmap;
}

export type TerrainBrush = 'blocked' | 'difficult' | 'clear';

/** Difficult ground costs double, which is the whole of the 5e rule. */
export const DIFFICULT_COST = 2;
export const NORMAL_COST = 1;

export function createTerrain(width: number, height: number): TerrainMap {
  return {
    width,
    height,
    blocked: createFog(width, height),
    difficult: createFog(width, height),
  };
}

/**
 * A stored pair of bitmaps, but only if they still describe this grid.
 *
 * The same rule fog follows, for the same reason: bits are indexed by width, so
 * reading them at another width shifts every row and paints a lake diagonally
 * across the map. A recalibrated grid is a different map.
 *
 * Unlike fog this is the DM's hand work rather than something re-earned by
 * walking, so callers are expected to *say* it no longer matches rather than
 * quietly dropping it - see `terrainMatchesGrid`.
 */
export function terrainForGrid(
  stored: { gridWidth: number; gridHeight: number; blockedBitmap: string; difficultBitmap: string } | null | undefined,
  width: number,
  height: number,
): TerrainMap {
  if (!terrainMatchesGrid(stored, width, height)) return createTerrain(width, height);

  return {
    width,
    height,
    blocked: decodeFog(stored!.blockedBitmap, width, height),
    difficult: decodeFog(stored!.difficultBitmap, width, height),
  };
}

/** Whether stored terrain still describes this grid, so a caller can warn. */
export function terrainMatchesGrid(
  stored: { gridWidth: number; gridHeight: number } | null | undefined,
  width: number,
  height: number,
): boolean {
  return Boolean(stored && stored.gridWidth === width && stored.gridHeight === height);
}

export function isBlockedAt(terrain: TerrainMap | null | undefined, x: number, y: number): boolean {
  return Boolean(terrain && isExplored(terrain.blocked, x, y));
}

export function isDifficultAt(terrain: TerrainMap | null | undefined, x: number, y: number): boolean {
  return Boolean(terrain && isExplored(terrain.difficult, x, y));
}

/**
 * What entering a square costs, in squares.
 *
 * Blocked ground has no cost because it is never entered - callers check
 * `isBlockedAt` first and skip it, the way they skip an occupied square.
 */
export function stepCostAt(terrain: TerrainMap | null | undefined, x: number, y: number): number {
  return isDifficultAt(terrain, x, y) ? DIFFICULT_COST : NORMAL_COST;
}

/**
 * Paints one stroke.
 *
 * A square is either blocked or difficult, never both: painting one clears the
 * other, so a lake that becomes a ford does not stay impassable underneath and
 * refuse every step for reasons nothing on screen explains.
 */
export function paintTerrain(
  terrain: TerrainMap,
  cells: readonly (readonly [number, number])[],
  brush: TerrainBrush,
): TerrainMap {
  const next = createTerrain(terrain.width, terrain.height);
  next.blocked.bits.set(terrain.blocked.bits);
  next.difficult.bits.set(terrain.difficult.bits);

  for (const [x, y] of cells) {
    clearAt(next, x, y);
    if (brush === 'blocked') markExplored(next.blocked, x, y);
    if (brush === 'difficult') markExplored(next.difficult, x, y);
  }

  return next;
}

/** There is no "unset one bit" primitive, so a cleared square is rebuilt. */
function clearAt(terrain: TerrainMap, x: number, y: number): void {
  for (const map of [terrain.blocked, terrain.difficult]) {
    if (!isExplored(map, x, y)) continue;
    const i = y * map.width + x;
    map.bits[i >> 3] &= ~(1 << (i & 7));
  }
}

export function encodeTerrain(terrain: TerrainMap): { blockedBitmap: string; difficultBitmap: string } {
  return {
    blockedBitmap: encodeFog(terrain.blocked),
    difficultBitmap: encodeFog(terrain.difficult),
  };
}

/** The painted squares, for the DM's overlay. Players are never sent these. */
export function paintedCells(terrain: TerrainMap): { blocked: [number, number][]; difficult: [number, number][] } {
  const blocked: [number, number][] = [];
  const difficult: [number, number][] = [];

  for (let y = 0; y < terrain.height; y++) {
    for (let x = 0; x < terrain.width; x++) {
      if (isExplored(terrain.blocked, x, y)) blocked.push([x, y]);
      else if (isExplored(terrain.difficult, x, y)) difficult.push([x, y]);
    }
  }

  return { blocked, difficult };
}

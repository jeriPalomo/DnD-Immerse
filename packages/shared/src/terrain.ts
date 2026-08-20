import { createFog, decodeFog, encodeFog, isExplored, markExplored, type FogBitmap } from './fog.js';

/**
 * Ground the DM has painted: squares nobody may enter, and squares that cost
 * more to cross than open floor.
 *
 * Built on the bitmaps in `fog.ts`, which are one bit per grid square and only
 * fog-shaped by name and history. A second implementation of the same thing
 * would be a second place for the `y * width + x` indexing to drift.
 *
 * A pillar is four wall segments and drawing it that way is fine. A lake, a
 * rubble field or a cave's ragged edge is not, which is what this is for.
 */

/**
 * What a painted square is. One bitmap each, rather than a cost per square,
 * because the DM paints a *kind* of ground - a bog, a ford - and the cost is
 * looked up from that. Storing the number instead would freeze it, the same
 * mistake `active_effects` avoids by naming a condition rather than copying its
 * mechanics: changing what mud costs would then apply only to mud painted
 * afterwards.
 */
export const TERRAIN_KINDS = ['blocked', 'mud', 'water'] as const;
export type TerrainKind = (typeof TERRAIN_KINDS)[number];

/** The brushes, which are the kinds plus a rubber. */
export const TERRAIN_BRUSHES = [...TERRAIN_KINDS, 'clear'] as const;
export type TerrainBrush = (typeof TERRAIN_BRUSHES)[number];

/**
 * Movement is counted in HALF squares, so an ordinary square costs 2.
 *
 * That granularity exists for shallow water. The handbook has one rate only -
 * difficult terrain, which costs double - and whole squares were enough while
 * mud was the only painted ground. Water at one and a half is not expressible
 * in them, and a search that rounded it would make a ford either free or a bog.
 *
 * Everything downstream is in these units: `reachableSquares` multiplies its
 * square budget by `COST_NORMAL` before spending it.
 */
export const COST_NORMAL = 2;

/**
 * Mud is the handbook's difficult terrain, at double. Wading through a bog,
 * deep snow or thick rubble is the case 5e writes the rule for.
 *
 * Shallow water at one and a half is a house rule, deliberately: 5e has no such
 * rate, but a ford that costs the same as a marsh makes the two brushes one
 * brush. Ankle-deep water slows you and is nothing like a bog, and the number
 * says so.
 */
export const TERRAIN_COST: Record<Exclude<TerrainKind, 'blocked'>, number> = {
  mud: 4,
  water: 3,
};

/** For the panel, so the legend cannot drift from the arithmetic. */
export const TERRAIN_LABEL: Record<TerrainKind, string> = {
  blocked: 'Impassable',
  mud: 'Mud',
  water: 'Shallow water',
};

export interface TerrainMap {
  width: number;
  height: number;
  blocked: FogBitmap;
  mud: FogBitmap;
  water: FogBitmap;
}

/** The stored row, named here so the decode and the schema cannot drift. */
export interface StoredTerrain {
  gridWidth: number;
  gridHeight: number;
  blockedBitmap: string;
  mudBitmap: string;
  waterBitmap: string;
}

export function createTerrain(width: number, height: number): TerrainMap {
  return {
    width,
    height,
    blocked: createFog(width, height),
    mud: createFog(width, height),
    water: createFog(width, height),
  };
}

/**
 * A stored set of bitmaps, but only if they still describe this grid.
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
  stored: StoredTerrain | null | undefined,
  width: number,
  height: number,
): TerrainMap {
  if (!terrainMatchesGrid(stored, width, height)) return createTerrain(width, height);

  return {
    width,
    height,
    blocked: decodeFog(stored!.blockedBitmap, width, height),
    mud: decodeFog(stored!.mudBitmap, width, height),
    water: decodeFog(stored!.waterBitmap, width, height),
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

/** What is painted on a square, or null for open floor. */
export function terrainAt(
  terrain: TerrainMap | null | undefined,
  x: number,
  y: number,
): TerrainKind | null {
  if (!terrain) return null;
  for (const kind of TERRAIN_KINDS) {
    if (isExplored(terrain[kind], x, y)) return kind;
  }
  return null;
}

/**
 * What entering a square costs, in half squares.
 *
 * Blocked ground has no cost because it is never entered - callers check
 * `isBlockedAt` first and skip it, the way they skip an occupied square.
 */
export function stepCostAt(terrain: TerrainMap | null | undefined, x: number, y: number): number {
  const kind = terrainAt(terrain, x, y);
  if (!kind || kind === 'blocked') return COST_NORMAL;
  return TERRAIN_COST[kind];
}

/**
 * Paints one stroke.
 *
 * A square carries one kind and no more: painting clears whatever was there
 * first, so a lake that becomes a ford does not stay impassable underneath and
 * refuse every step for reasons nothing on screen explains.
 */
export function paintTerrain(
  terrain: TerrainMap,
  cells: readonly (readonly [number, number])[],
  brush: TerrainBrush,
): TerrainMap {
  const next = createTerrain(terrain.width, terrain.height);
  for (const kind of TERRAIN_KINDS) next[kind].bits.set(terrain[kind].bits);

  for (const [x, y] of cells) {
    clearAt(next, x, y);
    if (brush !== 'clear') markExplored(next[brush], x, y);
  }

  return next;
}

/** There is no "unset one bit" primitive, so a cleared square is rebuilt. */
function clearAt(terrain: TerrainMap, x: number, y: number): void {
  for (const kind of TERRAIN_KINDS) {
    const map = terrain[kind];
    if (!isExplored(map, x, y)) continue;
    const i = y * map.width + x;
    map.bits[i >> 3] &= ~(1 << (i & 7));
  }
}

/**
 * Whether the straight line from one point to another crosses blocked ground.
 *
 * The destination check alone was not enough: it stopped a player *standing* on
 * a chasm but not dragging clean across it in one motion and landing on the far
 * side.
 *
 * This is the cheap first answer and not the final one. A straight line that
 * clips the chasm does not mean there is no way there - `routeExists` then
 * walks the grid to see whether the creature could have gone round, which is
 * what a person dragging a token past a corner means by the gesture.
 *
 * Sampled along the segment rather than traced as a supercover line: the step
 * is a quarter of a square, far finer than the one-square obstacles it has to
 * catch, and it is the same approximation walls make by testing centre to
 * centre.
 *
 * The square the creature starts on is skipped. A DM may place a token on
 * blocked ground deliberately, or paint under one that is already standing
 * there, and neither should leave it unable to walk out.
 */
export function pathBlocked(
  terrain: TerrainMap | null | undefined,
  from: { x: number; y: number },
  to: { x: number; y: number },
): boolean {
  if (!terrain) return false;

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 1e-9) return false;

  const origin = `${Math.floor(from.x)}:${Math.floor(from.y)}`;
  const steps = Math.max(1, Math.ceil(distance / 0.25));

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = Math.floor(from.x + dx * t);
    const y = Math.floor(from.y + dy * t);
    if (`${x}:${y}` === origin) continue;
    if (isBlockedAt(terrain, x, y)) return true;
  }

  return false;
}

export function encodeTerrain(
  terrain: TerrainMap,
): Pick<StoredTerrain, 'blockedBitmap' | 'mudBitmap' | 'waterBitmap'> {
  return {
    blockedBitmap: encodeFog(terrain.blocked),
    mudBitmap: encodeFog(terrain.mud),
    waterBitmap: encodeFog(terrain.water),
  };
}

/** The painted squares, for the DM's overlay. Players are never sent these. */
export function paintedCells(terrain: TerrainMap): Record<TerrainKind, [number, number][]> {
  const out: Record<TerrainKind, [number, number][]> = { blocked: [], mud: [], water: [] };

  for (let y = 0; y < terrain.height; y++) {
    for (let x = 0; x < terrain.width; x++) {
      const kind = terrainAt(terrain, x, y);
      if (kind) out[kind].push([x, y]);
    }
  }

  return out;
}

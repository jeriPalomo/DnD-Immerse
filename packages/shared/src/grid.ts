/**
 * Grid math for the VTT canvas.
 *
 * Token positions are stored in GRID UNITS (floats), never pixels. Pixel
 * position is derived at render time from the scene's gridSize and offset,
 * so recalibrating a map's grid never scrambles the tokens on it.
 */

export interface GridConfig {
  /** Pixel size of one grid square on the source map image. */
  gridSize: number;
  /** Pixel offset of the grid's origin from the image's top-left corner. */
  offsetX: number;
  offsetY: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Grid units -> pixels on the map image. */
export function gridToPixel(p: Point, grid: GridConfig): Point {
  return {
    x: p.x * grid.gridSize + grid.offsetX,
    y: p.y * grid.gridSize + grid.offsetY,
  };
}

/** Pixels on the map image -> grid units. */
export function pixelToGrid(p: Point, grid: GridConfig): Point {
  return {
    x: (p.x - grid.offsetX) / grid.gridSize,
    y: (p.y - grid.offsetY) / grid.gridSize,
  };
}

/**
 * Snaps a grid-unit value to the nearest increment. Default increment of 1
 * aligns to square corners; 0.5 allows half-square placement for tokens
 * squeezed between others.
 */
export function snap(value: number, increment = 1): number {
  if (increment <= 0) return value;
  return Math.round(value / increment) * increment;
}

export type DiagonalRule = 'standard' | 'variant';

/**
 * Distance in grid squares between two points.
 *
 * 'standard' is the 5e PHB default: diagonals cost the same as orthogonal
 * movement, so distance is simply the larger axis (Chebyshev).
 *
 * 'variant' is the DMG optional rule where every second diagonal costs 2,
 * which approximates true Euclidean distance.
 */
export function gridDistance(a: Point, b: Point, rule: DiagonalRule = 'standard'): number {
  const dx = Math.abs(a.x - b.x);
  const dy = Math.abs(a.y - b.y);

  if (rule === 'standard') return Math.max(dx, dy);

  const diagonals = Math.min(dx, dy);
  const straights = Math.max(dx, dy) - diagonals;
  return straights + diagonals + Math.floor(diagonals / 2);
}

export type Polygon = Point[];

/**
 * Ray-casting point-in-polygon test. Used server-side to decide whether a
 * token sits inside a revealed (non-fogged) region before including it in a
 * player's payload.
 */
export function pointInPolygon(point: Point, polygon: Polygon): boolean {
  if (polygon.length < 3) return false;

  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const pi = polygon[i];
    const pj = polygon[j];
    const intersects =
      pi.y > point.y !== pj.y > point.y &&
      point.x < ((pj.x - pi.x) * (point.y - pi.y)) / (pj.y - pi.y) + pi.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function pointInAnyPolygon(point: Point, polygons: Polygon[]): boolean {
  return polygons.some((poly) => pointInPolygon(point, poly));
}

/** Clamps a token so it cannot be dragged off the map entirely. */
export function clampToMap(p: Point, tokenW: number, tokenH: number, mapW: number, mapH: number): Point {
  return {
    x: Math.max(-tokenW / 2, Math.min(mapW - tokenW / 2, p.x)),
    y: Math.max(-tokenH / 2, Math.min(mapH - tokenH / 2, p.y)),
  };
}

/* --------------------------------------------------- token-aware helpers */

export interface TokenRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Vision and AoE origins come from a token's center, not its top-left corner. */
export function tokenCenter(t: TokenRect): Point {
  return { x: t.x + t.w / 2, y: t.y + t.h / 2 };
}

/**
 * Distance between two creatures, measured to the nearest occupied square as
 * 5e requires - NOT center to center.
 *
 * Center-to-center would report a Medium creature standing against the flank
 * of a 4x4 Gargantuan dragon as 25 feet away, refusing melee attacks that are
 * plainly legal. Every reach, range and AoE check must go through this rather
 * than through gridDistance.
 */
export function tokenDistance(a: TokenRect, b: TokenRect, rule: DiagonalRule = 'standard'): number {
  const overlapX = a.x < b.x + b.w && b.x < a.x + a.w;
  const overlapY = a.y < b.y + b.h && b.y < a.y + a.h;
  if (overlapX && overlapY) return 0;

  // Empty squares separating the two footprints; 0 when they are touching.
  const gapX = Math.max(0, b.x - (a.x + a.w), a.x - (b.x + b.w));
  const gapY = Math.max(0, b.y - (a.y + a.h), a.y - (b.y + b.h));

  // +1 because 5e counts the target's own square: adjacent creatures are 5ft
  // apart, not 0ft.
  return gridDistance({ x: 0, y: 0 }, { x: gapX, y: gapY }, rule) + 1;
}

export function tokenDistanceInFeet(
  a: TokenRect,
  b: TokenRect,
  rule: DiagonalRule = 'standard',
  feetPerSquare = 5,
): number {
  return tokenDistance(a, b, rule) * feetPerSquare;
}

/**
 * Snaps a token's top-left corner to the grid.
 *
 * Because position is stored as the top-left corner rather than the center,
 * a single integer snap is already correct for every whole-square size: a 1x1
 * lands centered in a square, a 2x2 lands centered on an intersection. That is
 * the same result as Foundry's odd/even center-parity rule, without the
 * special case. Sub-square tokens (Tiny, 0.5) snap to their own size instead so
 * four of them can share one square.
 */
export function snapTokenPosition(p: Point, w: number, h: number): Point {
  return {
    x: snap(p.x, w < 1 ? w : 1),
    y: snap(p.y, h < 1 ? h : 1),
  };
}

/** 5e creature sizes, as token footprints in grid units. */
export const CREATURE_SIZES = {
  tiny: 0.5,
  small: 1,
  medium: 1,
  large: 2,
  huge: 3,
  gargantuan: 4,
} as const;

export type CreatureSize = keyof typeof CREATURE_SIZES;

import type { Point, Polygon } from './grid.js';

/**
 * Line-of-sight geometry.
 *
 * This runs on the SERVER, not the client. Foundry computes vision in the
 * browser, which means every client holds all walls and all tokens and merely
 * declines to draw them - a devtools inspection away from reading the whole
 * dungeon. Here the server computes the polygon and sends the player only that
 * polygon plus the tokens inside it; wall geometry never leaves the DM.
 */

export interface VisionWall {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** 0 none, 1 blocks, 2 terrain (blocks only from beyond one square). */
  blocksSight: number;
  /** 0 none, 1 blocks. */
  blocksMovement: number;
  /** 0 wall, 1 door, 2 secret door. */
  door: number;
  /** 0 closed, 1 open, 2 locked. */
  doorState: number;
}

/** An open door stops blocking; a closed or locked one still does. */
export function blocksSight(wall: VisionWall): boolean {
  if (wall.blocksSight === 0) return false;
  if (wall.door > 0 && wall.doorState === 1) return false;
  return true;
}

const EPSILON = 1e-6;
/** Rays are cast a hair either side of each corner so they can slip past it. */
const CORNER_NUDGE = 1e-4;
/** Rays around the vision circle, so a radius-capped edge reads as curved. */
const BOUNDARY_RAYS = 48;

interface Hit {
  angle: number;
  point: Point;
  distance: number;
}

/**
 * Nearest intersection of a ray with a segment.
 *
 * Solves origin + t·direction = a + u·(b − a) via the 2D cross product, then
 * keeps the hit only when it is ahead of the origin (t ≥ 0) and actually on the
 * segment (0 ≤ u ≤ 1).
 */
function rayHitsSegment(
  origin: Point,
  dx: number,
  dy: number,
  a: Point,
  b: Point,
): number | null {
  const sx = b.x - a.x;
  const sy = b.y - a.y;

  const denominator = dx * sy - dy * sx;
  if (Math.abs(denominator) < EPSILON) return null; // Parallel.

  const ox = a.x - origin.x;
  const oy = a.y - origin.y;

  const t = (ox * sy - oy * sx) / denominator;
  const u = (ox * dy - oy * dx) / denominator;

  if (t < 0 || u < -EPSILON || u > 1 + EPSILON) return null;
  return t;
}

/**
 * The polygon visible from `origin`, bounded by `radius`.
 *
 * Standard angular sweep: cast a ray at every wall corner (plus one either
 * side of it, which is what lets sight slip past a corner and strike the wall
 * behind), take the nearest hit along each, then join the hits in angular
 * order.
 *
 * Cost is O(rays × walls). At 300 walls that is roughly 500k intersection
 * tests - low single-digit milliseconds - so it is recomputed on token move
 * (throttled), door toggle and light change rather than cached.
 */
export function computeVisibility(
  origin: Point,
  walls: VisionWall[],
  radius: number,
): Polygon {
  const blocking = walls.filter(blocksSight);

  const angles: number[] = [];

  for (const wall of blocking) {
    for (const corner of [
      { x: wall.x1, y: wall.y1 },
      { x: wall.x2, y: wall.y2 },
    ]) {
      const angle = Math.atan2(corner.y - origin.y, corner.x - origin.x);
      angles.push(angle - CORNER_NUDGE, angle, angle + CORNER_NUDGE);
    }
  }

  // Always sample the full circle so an unobstructed view is still a closed
  // polygon rather than a handful of spokes.
  for (let i = 0; i < BOUNDARY_RAYS; i++) {
    angles.push((i / BOUNDARY_RAYS) * Math.PI * 2 - Math.PI);
  }

  const hits: Hit[] = [];

  for (const angle of angles) {
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);

    let nearest = radius;
    for (const wall of blocking) {
      const t = rayHitsSegment(
        origin,
        dx,
        dy,
        { x: wall.x1, y: wall.y1 },
        { x: wall.x2, y: wall.y2 },
      );
      if (t !== null && t < nearest) nearest = t;
    }

    hits.push({
      angle,
      distance: nearest,
      point: { x: origin.x + dx * nearest, y: origin.y + dy * nearest },
    });
  }

  hits.sort((a, b) => a.angle - b.angle);

  // Collapse rays that landed on effectively the same spot, which happens in
  // bulk along the unobstructed boundary.
  const polygon: Polygon = [];
  for (const hit of hits) {
    const previous = polygon[polygon.length - 1];
    if (previous && Math.abs(previous.x - hit.point.x) < 1e-3 && Math.abs(previous.y - hit.point.y) < 1e-3) {
      continue;
    }
    polygon.push(hit.point);
  }

  return polygon;
}

/**
 * Combined view for a player who controls several tokens. Returned as separate
 * polygons rather than a union: point-in-any-polygon is the only test needed,
 * and a real polygon union is expensive and fiddly.
 */
export function combinedVisibility(
  origins: { point: Point; radius: number }[],
  walls: VisionWall[],
): Polygon[] {
  return origins
    .filter((o) => o.radius > 0)
    .map((o) => computeVisibility(o.point, walls, o.radius));
}

/* ------------------------------------------------------------- movement */

/** An open door lets you through; a closed or locked one does not. */
export function blocksMovement(wall: VisionWall): boolean {
  if (!wall.blocksMovement) return false;
  if (wall.door > 0 && wall.doorState === 1) return false;
  return true;
}

/**
 * Whether a straight move from a to b crosses a movement-blocking wall.
 *
 * Tested against `blocksMovement`, not `blocksSight`: a railing blocks movement
 * without blocking sight, and a curtain does the reverse.
 */
export function movementBlocked(a: Point, b: Point, walls: VisionWall[]): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length < EPSILON) return false;

  for (const wall of walls) {
    if (!blocksMovement(wall)) continue;

    const t = rayHitsSegment(
      a,
      dx / length,
      dy / length,
      { x: wall.x1, y: wall.y1 },
      { x: wall.x2, y: wall.y2 },
    );
    if (t !== null && t <= length) return true;
  }

  return false;
}

/* ------------------------------------------------------------ lighting */

export interface SightConfig {
  /** Feet the token can see in light. 0 falls back to the caller's default. */
  visionRange: number;
  /** Feet the token can see in darkness. */
  darkvisionRange: number;
  /** Feet the token's own light illuminates. */
  lightBright: number;
}

/**
 * How far a token can actually see, in feet.
 *
 * Under global illumination (daylight) that is simply its vision range. In an
 * unlit scene it is limited to what the token can supply for itself: darkvision
 * or the light it carries. A creature with neither still sees its own square,
 * so a player is never left with a completely black screen and no explanation.
 */
export function sightRadiusFeet(
  token: SightConfig,
  globalIllumination: boolean,
  defaultVisionFeet: number,
  feetPerSquare = 5,
  /** 0 full daylight, 1 pitch dark. Dims sight between the two extremes. */
  darkness = 0,
): number {
  const lit = token.visionRange > 0 ? token.visionRange : defaultVisionFeet;
  const unlit = Math.max(token.darkvisionRange, token.lightBright);

  if (globalIllumination) {
    // Gloom shades continuously from full sight down to what the token can
    // supply for itself, so a DM can dim a scene without going pitch black.
    const level = Math.max(0, Math.min(1, darkness));
    if (level === 0) return lit;
    const floor = unlit > 0 ? Math.min(unlit, lit) : feetPerSquare;
    return Math.max(floor, lit - (lit - floor) * level);
  }

  // One square, so an unlit token is not blind - it just cannot see far.
  return unlit > 0 ? Math.min(unlit, lit) : feetPerSquare;
}

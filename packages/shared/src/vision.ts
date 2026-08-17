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

/**
 * What a wall is. Named because these were bare integers described only in a
 * comment, and `door: 2` sat unread for long enough that secret doors were
 * being drawn and sent to players like ordinary ones.
 */
export const PLAIN_WALL = 0;
export const DOOR = 1;
export const SECRET_DOOR = 2;

/** Door states. */
export const DOOR_CLOSED = 0;
export const DOOR_OPEN = 1;
export const DOOR_LOCKED = 2;

export interface VisionWall {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** 0 none, 1 blocks. (A `2` was once documented as terrain and never read.) */
  blocksSight: number;
  /** 0 none, 1 blocks. */
  blocksMovement: number;
  /** `PLAIN_WALL` | `DOOR` | `SECRET_DOOR`. */
  door: number;
  /** `DOOR_CLOSED` | `DOOR_OPEN` | `DOOR_LOCKED`. */
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

/** Shortest distance from a point to a segment, for radius culling. */
function distanceToSegment(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared < EPSILON) return Math.hypot(point.x - a.x, point.y - a.y);

  // Project the point onto the segment, clamped to its ends.
  const t = Math.max(
    0,
    Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared),
  );
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
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
  // Walls beyond the vision radius cannot occlude anything inside it, and
  // dropping them early matters a great deal: the sweep casts three rays per
  // wall corner and tests each against every wall, so cost grows with the
  // SQUARE of the wall count. Culling to the local neighbourhood keeps a big
  // dungeon as cheap as a small room.
  const blocking = walls.filter(
    (wall) =>
      blocksSight(wall) &&
      distanceToSegment(origin, { x: wall.x1, y: wall.y1 }, { x: wall.x2, y: wall.y2 }) <= radius,
  );

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
  /** Feet the token's own light brightly illuminates. */
  lightBright: number;
  /**
   * Feet of dim light beyond the bright radius. You can still see in dim
   * light - it costs you disadvantage on Perception, not your eyes - so it
   * extends how far a torchbearer sees, past where it is bright.
   */
  lightDim?: number;
  /**
   * Set by the `blinded`, `unconscious` and `petrified` conditions. Overrides
   * every other source: a torch does not help a creature that cannot see.
   */
  blinded?: boolean;
}

/**
 * How far a token can actually see, in feet.
 *
 * Under global illumination (daylight) that is simply its vision range. In an
 * unlit scene it is limited to what the token can supply for itself: darkvision
 * or the light it carries. A creature with neither still sees its own square,
 * so a player is never left with a completely black screen and no explanation.
 *
 * The one exception is blindness, which returns 0 and *is* meant to be a black
 * screen - the explanation being the condition badge on their own token. Both
 * callers downstream already cope: `combinedVisibility` drops zero-radius
 * sources, and `visibleTokens` falls back to the tokens you control, so a
 * blinded player keeps their own token and the grey memory of explored ground.
 */
export function sightRadiusFeet(
  token: SightConfig,
  globalIllumination: boolean,
  defaultVisionFeet: number,
  feetPerSquare = 5,
  /** 0 full daylight, 1 pitch dark. Dims sight between the two extremes. */
  darkness = 0,
): number {
  if (token.blinded) return 0;

  const lit = token.visionRange > 0 ? token.visionRange : defaultVisionFeet;
  const unlit = Math.max(token.darkvisionRange, token.lightBright, token.lightDim ?? 0);

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

import type { Point, TokenRect } from './grid.js';
import { movementBlocked, type VisionWall } from './vision.js';

/**
 * Where a creature can actually get to.
 *
 * A flood fill outward from a token, stopped by its speed, by walls, and by
 * other creatures standing in the way. This is what draws the movement overlay
 * - select a unit and see its reach before committing to a drag, the way a
 * tactics game has always done it.
 *
 * It runs on the SERVER, for the same reason vision does: players are never
 * sent wall geometry, so a browser cannot work out what a wall stops. The
 * answer travels as a list of squares.
 *
 * Note this is a genuinely different question from the one `token:commit` asks.
 * That tests a single centre-to-centre segment across the whole move, which
 * both under-blocks (a long drag cuts the corner of a wall stub) and
 * over-blocks. Stepping one square at a time is the honest version.
 */

export interface ReachableInput {
  /** Where the creature is now, in grid units. */
  origin: TokenRect;
  speedFeet: number;
  feetPerSquare: number;
  walls: VisionWall[];
  /** Other creatures. A square any of them covers cannot be entered. */
  occupied: TokenRect[];
  /** Map extent in squares. */
  bounds: { width: number; height: number };
}

/**
 * Only the standard 5e rule, where a diagonal costs the same as a straight
 * step, and deliberately so.
 *
 * The DMG's optional rule - every SECOND diagonal costs double - is
 * path-dependent: one diagonal costs 1 either way, and the difference only
 * appears on the next one. A per-step cost cannot express that without carrying
 * diagonal parity through the search state, and a `rule` parameter that quietly
 * behaved as `standard` would be worse than not offering one.
 */

/** The centre of a footprint placed with its top-left at (x, y). */
function centreOf(x: number, y: number, w: number, h: number): Point {
  return { x: x + w / 2, y: y + h / 2 };
}

/** Whether two footprints overlap at all. */
function overlaps(a: TokenRect, b: TokenRect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

const NEIGHBOURS = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
] as const;

/**
 * Squares the token can reach, as `[x, y]` top-left positions for its
 * footprint - the same shape `coveredSquares` and the fog's explored list use.
 *
 * The origin square is included: standing still is a legal move, and the
 * overlay reads wrong without it.
 */
export function reachableSquares(input: ReachableInput): [number, number][] {
  const { origin, speedFeet, feetPerSquare, walls, occupied, bounds } = input;

  const w = Math.max(1, Math.round(origin.w));
  const h = Math.max(1, Math.round(origin.h));
  const start: [number, number] = [Math.round(origin.x), Math.round(origin.y)];

  if (speedFeet <= 0 || feetPerSquare <= 0) return [start];

  /** Every step costs the same, so this is a plain square budget. */
  const budget = Math.floor(speedFeet / feetPerSquare);
  if (budget <= 0) return [start];

  /** A footprint at (x, y) fits if it is on the map and nothing is standing there. */
  const fits = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x + w > bounds.width || y + h > bounds.height) return false;
    const rect: TokenRect = { x, y, w, h };
    // The creature does not block itself: `occupied` is everyone else.
    return !occupied.some((other) => overlaps(rect, other));
  };

  const key = (x: number, y: number) => `${x}:${y}`;
  const seen = new Set<string>([key(start[0], start[1])]);
  const found: [number, number][] = [start];

  // A breadth-first search is exact here because every step costs the same, so
  // the first time a square is reached is also the cheapest way to reach it.
  let frontier: [number, number][] = [start];

  for (let step = 0; step < budget; step += 1) {
    const next: [number, number][] = [];

    for (const [cx, cy] of frontier) {
      for (const [dx, dy] of NEIGHBOURS) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (seen.has(key(nx, ny))) continue;
        if (!fits(nx, ny)) continue;

        // One square at a time, centre to centre - the segment a wall can
        // actually be said to sit across.
        if (movementBlocked(centreOf(cx, cy, w, h), centreOf(nx, ny, w, h), walls)) continue;

        seen.add(key(nx, ny));
        found.push([nx, ny]);
        next.push([nx, ny]);
      }
    }

    if (next.length === 0) break;
    frontier = next;
  }

  return found;
}

/**
 * The union of several creatures' reach, deduplicated - the threat range of a
 * whole side at once.
 */
export function unionOfReach(ranges: [number, number][][]): [number, number][] {
  const seen = new Set<string>();
  const out: [number, number][] = [];

  for (const range of ranges) {
    for (const [x, y] of range) {
      const k = `${x}:${y}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push([x, y]);
    }
  }

  return out;
}

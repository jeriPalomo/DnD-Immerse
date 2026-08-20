import type { Point, TokenRect } from './grid.js';
import { movementBlocked, type VisionWall } from './vision.js';
import { COST_NORMAL, isBlockedAt, stepCostAt, type TerrainMap } from './terrain.js';

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
  /** Ground the DM has painted. Blocked squares are never entered; mud and water cost more. */
  terrain?: TerrainMap | null;
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
  return [...reachableCosts(input).values()].map(({ x, y }) => [x, y]);
}

/**
 * The same search, keeping what each square cost to reach.
 *
 * `token:commit` needs the price of the square a token was dropped on, and the
 * overlay needs the set of squares that are affordable at all. Two searches
 * would be two chances to disagree about whether a drop is legal - which is
 * exactly the disagreement between the overlay and the old straight-line check
 * that made a drag round a corner illegal. Keyed `x:y`, and the cost is in half
 * squares like everything else below the conversion.
 */
export function reachableCosts(
  input: ReachableInput,
): Map<string, { x: number; y: number; cost: number }> {
  const { origin, speedFeet, feetPerSquare, walls, occupied, bounds, terrain } = input;

  const w = Math.max(1, Math.round(origin.w));
  const h = Math.max(1, Math.round(origin.h));
  const start: [number, number] = [Math.round(origin.x), Math.round(origin.y)];
  const standingStill = new Map([
    [`${start[0]}:${start[1]}`, { x: start[0], y: start[1], cost: 0 }],
  ]);

  if (speedFeet <= 0 || feetPerSquare <= 0) return standingStill;

  /**
   * In half squares, because shallow water costs one and a half of them. The
   * budget is converted once, here, and every cost below is in the same unit -
   * mixing the two is how a ford would end up free.
   *
   * Rounded down in HALF squares, not in whole ones. Flooring the division
   * first threw away any half square the budget had left, which cost a creature
   * movement for pausing: 30 ft crosses four squares of shallow water in one
   * drag, but stopping on the first spends 7.5 ft and leaves 22.5 - four and a
   * half squares, floored to four, and the same creature then managed only
   * three more. Moving in two goes is the same distance as moving in one.
   */
  const budget = Math.floor((speedFeet / feetPerSquare) * COST_NORMAL);
  if (budget <= 0) return standingStill;

  /**
   * A footprint at (x, y) fits if it is on the map, nothing is standing there,
   * and no part of it lands on ground the DM has painted impassable.
   *
   * Terrain is tested across the whole footprint rather than at the corner: an
   * ogre is 2x2, and half of it standing in the chasm is still in the chasm.
   */
  const fits = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x + w > bounds.width || y + h > bounds.height) return false;
    const rect: TokenRect = { x, y, w, h };
    // The creature does not block itself: `occupied` is everyone else.
    if (occupied.some((other) => overlaps(rect, other))) return false;
    return !footprintBlocked(terrain, x, y, w, h);
  };

  /** What it costs to stand here: the dearest square the footprint covers. */
  const costOf = (x: number, y: number): number => {
    let cost = COST_NORMAL;
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) cost = Math.max(cost, stepCostAt(terrain, x + dx, y + dy));
    }
    return cost;
  };

  const key = (x: number, y: number) => `${x}:${y}`;
  const spent = new Map<string, number>([[key(start[0], start[1]), 0]]);
  const found = new Map<string, { x: number; y: number; cost: number }>(standingStill);

  /**
   * Cheapest-first, because a step no longer always costs the same.
   *
   * Breadth-first was exact while every square cost one, so the first arrival
   * was also the cheapest. Difficult ground breaks that: a square reached early
   * through the rubble may be reachable later for less by going round, and a
   * plain queue would record the dearer route and stop short.
   *
   * Costs are 2, 3 or 4 and the grid is at most a few thousand squares, so a
   * bucket per cost is enough - no heap, and the buckets are walked in order.
   */
  const buckets: [number, number][][] = [];
  const push = (cell: [number, number], cost: number) => {
    (buckets[cost] ??= []).push(cell);
  };
  push(start, 0);

  for (let cost = 0; cost <= budget; cost++) {
    const bucket = buckets[cost];
    if (!bucket) continue;

    for (const [cx, cy] of bucket) {
      // A cheaper route to this square was found after it was queued here.
      if ((spent.get(key(cx, cy)) ?? Infinity) < cost) continue;

      for (const [dx, dy] of NEIGHBOURS) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (!fits(nx, ny)) continue;

        const next = cost + costOf(nx, ny);
        if (next > budget) continue;
        if ((spent.get(key(nx, ny)) ?? Infinity) <= next) continue;

        // One square at a time, centre to centre - the segment a wall can
        // actually be said to sit across.
        if (movementBlocked(centreOf(cx, cy, w, h), centreOf(nx, ny, w, h), walls)) continue;

        spent.set(key(nx, ny), next);
        found.set(key(nx, ny), { x: nx, y: ny, cost: next });
        push([nx, ny], next);
      }
    }
  }

  return found;
}

/**
 * What one square of ground costs a creature, in feet.
 *
 * The search counts in half squares so shallow water can cost one and a half of
 * them; a turn's movement is counted in feet, because that is the unit a speed
 * is written in and a scene is not always five feet to the square.
 */
export function costToFeet(cost: number, feetPerSquare: number): number {
  return (cost / COST_NORMAL) * feetPerSquare;
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

/**
 * Whether any square a footprint covers is painted impassable.
 *
 * Shared by the movement overlay and by `token:commit`, so what the overlay
 * promises and what the server allows are the same answer.
 */
export function footprintBlocked(
  terrain: TerrainMap | null | undefined,
  x: number,
  y: number,
  w: number,
  h: number,
): boolean {
  if (!terrain) return false;
  const width = Math.max(1, Math.round(w));
  const height = Math.max(1, Math.round(h));

  for (let dy = 0; dy < height; dy++) {
    for (let dx = 0; dx < width; dx++) {
      if (isBlockedAt(terrain, Math.round(x) + dx, Math.round(y) + dy)) return true;
    }
  }
  return false;
}

/**
 * Whether there is any legal way from where a creature stands to where it was
 * dropped, going round obstacles rather than through them.
 *
 * `token:commit` used to answer this with a straight line - one segment from
 * centre to centre, tested against walls and painted ground. That is wrong in
 * the obvious way: dragging a token round a corner, or along the shore of a
 * lake, traces a line that clips the thing you were avoiding, and the move was
 * refused even though the creature could plainly walk it. The overlay, which is
 * a flood fill, had been drawing those squares as reachable the whole time, so
 * the board offered a square and the server then bounced you off it.
 *
 * A route, not a budget: this asks "could you get there at all", never "how
 * far is it". What a turn can afford is a separate question, asked by
 * `reachableCosts` in `token:commit` and only while a fight is running - out of
 * combat nothing spends movement at all.
 *
 * Occupancy is deliberately ignored. A creature ringed by its own party would
 * otherwise be unable to move at all, and 5e lets you pass through an ally's
 * square freely; the destination overlapping someone is a separate question
 * this has never asked.
 *
 * **Bounded, and refusing when it runs out.** A legal route the long way round
 * a lake can be arbitrarily long, and this runs on every drop. The search stops
 * at a few times the direct distance and at a fixed number of squares, which
 * means a genuinely legal but enormous detour is refused - the player drags it
 * in two hops, and the alternative is a handler that can be made to walk the
 * whole map by dropping a token on the far side of a wall.
 */
export interface RouteInput {
  origin: TokenRect;
  /** Top-left of the destination footprint, in squares. */
  destination: { x: number; y: number };
  walls: VisionWall[];
  bounds: { width: number; height: number };
  terrain?: TerrainMap | null;
}

/** Beyond this many squares of path, a drop is refused rather than searched. */
const MAX_ROUTE_STEPS = 60;
/** And beyond this many squares visited, whatever the path length allows. */
const MAX_ROUTE_EXPLORED = 2000;

export function routeExists(input: RouteInput): boolean {
  const { origin, destination, walls, bounds, terrain } = input;

  const w = Math.max(1, Math.round(origin.w));
  const h = Math.max(1, Math.round(origin.h));
  const start: [number, number] = [Math.round(origin.x), Math.round(origin.y)];
  const goal: [number, number] = [Math.round(destination.x), Math.round(destination.y)];

  if (start[0] === goal[0] && start[1] === goal[1]) return true;
  if (goal[0] < 0 || goal[1] < 0 || goal[0] + w > bounds.width || goal[1] + h > bounds.height) {
    return false;
  }
  // Standing there is impossible however you got there, so do not search.
  if (footprintBlocked(terrain, goal[0], goal[1], w, h)) return false;

  const direct = Math.max(Math.abs(goal[0] - start[0]), Math.abs(goal[1] - start[1]));
  /**
   * How far round the creature may go to justify this move.
   *
   * Proportional, with **no constant added**. A constant is what let a step of
   * one square detour eleven, which meant a player could step straight through
   * a closed door: the straight line was refused, and then a three-step walk
   * round the end of the door justified it. The door appeared to do nothing.
   *
   * A single step therefore gets two, which is enough to cut a corner past the
   * end of a wall - genuinely one L-shaped step - and not enough to go around
   * anything. Longer drags still get plenty: the point of this search is a
   * token dragged past a jetty, and eight squares of travel allow sixteen.
   */
  const maxSteps = Math.min(MAX_ROUTE_STEPS, Math.max(2, direct * 2));

  /**
   * Only the walls that could possibly be crossed, for the reason the vision
   * sweep culls: `movementBlocked` walks every wall on every step, so an
   * unculled 300-wall scene turns a 2000-square search into 5 million segment
   * tests. The box is the whole region the search can reach, so nothing that
   * could be crossed is dropped.
   */
  const pad = maxSteps + Math.max(w, h) + 1;
  const minX = Math.min(start[0], goal[0]) - pad;
  const maxX = Math.max(start[0], goal[0]) + w + pad;
  const minY = Math.min(start[1], goal[1]) - pad;
  const maxY = Math.max(start[1], goal[1]) + h + pad;
  const near = walls.filter(
    (wall) =>
      Math.max(wall.x1, wall.x2) >= minX &&
      Math.min(wall.x1, wall.x2) <= maxX &&
      Math.max(wall.y1, wall.y2) >= minY &&
      Math.min(wall.y1, wall.y2) <= maxY,
  );

  const key = (x: number, y: number) => `${x}:${y}`;
  const seen = new Set<string>([key(start[0], start[1])]);
  let frontier: [number, number][] = [start];

  for (let step = 0; step < maxSteps && frontier.length > 0; step++) {
    const next: [number, number][] = [];

    for (const [cx, cy] of frontier) {
      for (const [dx, dy] of NEIGHBOURS) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx + w > bounds.width || ny + h > bounds.height) continue;
        if (seen.has(key(nx, ny))) continue;
        if (footprintBlocked(terrain, nx, ny, w, h)) continue;
        if (movementBlocked(centreOf(cx, cy, w, h), centreOf(nx, ny, w, h), near)) continue;

        if (nx === goal[0] && ny === goal[1]) return true;

        seen.add(key(nx, ny));
        if (seen.size > MAX_ROUTE_EXPLORED) return false;
        next.push([nx, ny]);
      }
    }

    frontier = next;
  }

  return false;
}

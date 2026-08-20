import { describe, expect, it } from 'vitest';
import { routeExists } from './movement.js';
import { createTerrain, paintTerrain } from './terrain.js';
import type { VisionWall } from './vision.js';

const wall = (x1: number, y1: number, x2: number, y2: number): VisionWall => ({
  x1,
  y1,
  x2,
  y2,
  blocksSight: 1,
  blocksMovement: 1,
  door: 0,
  doorState: 0,
});

const base = {
  origin: { x: 2, y: 5, w: 1, h: 1 },
  walls: [] as VisionWall[],
  bounds: { width: 20, height: 20 },
};

/** Blocked squares at x = 5, from y = 0 to 7 - a jetty with open water past it. */
const jetty = () => {
  const cells: [number, number][] = [];
  for (let y = 0; y <= 7; y++) cells.push([5, y]);
  return paintTerrain(createTerrain(20, 20), cells, 'blocked');
};

describe('finding a way round', () => {
  it('allows a drop the straight line could never have reached', () => {
    // The whole point. Dragging past the end of a jetty traces a segment that
    // clips it, and testing that segment alone refused a move the creature can
    // plainly walk - while the movement overlay had been drawing those very
    // squares as reachable.
    expect(routeExists({ ...base, destination: { x: 8, y: 5 }, terrain: jetty() })).toBe(true);
  });

  it('refuses when the blockage goes all the way across', () => {
    const cells: [number, number][] = [];
    for (let y = 0; y < 20; y++) cells.push([5, y]);
    const terrain = paintTerrain(createTerrain(20, 20), cells, 'blocked');
    expect(routeExists({ ...base, destination: { x: 8, y: 5 }, terrain })).toBe(false);
  });

  it('refuses a destination that is itself blocked, however you got there', () => {
    expect(routeExists({ ...base, destination: { x: 5, y: 3 }, terrain: jetty() })).toBe(false);
  });

  it('goes round a wall stub the same way', () => {
    // Walls had this problem first, and for longer: a centre-to-centre segment
    // refuses every drag round a corner.
    const walls = [wall(5, 0, 5, 7)];
    expect(routeExists({ ...base, destination: { x: 8, y: 5 }, walls })).toBe(true);
  });

  it('refuses when a wall runs the full height', () => {
    const walls = [wall(5, -1, 5, 21)];
    expect(routeExists({ ...base, destination: { x: 8, y: 5 }, walls })).toBe(false);
  });

  it('lets an open door through and a closed one not', () => {
    const shut = [wall(5, -1, 5, 21)];
    const open = [{ ...wall(5, -1, 5, 21), door: 1, doorState: 1 }];
    expect(routeExists({ ...base, destination: { x: 8, y: 5 }, walls: shut })).toBe(false);
    expect(routeExists({ ...base, destination: { x: 8, y: 5 }, walls: open })).toBe(true);
  });

  it('ignores ground that only costs, since this asks whether, not how far', () => {
    // Out of combat nothing spends movement, so a bog is not a barrier. Its
    // cost is the movement overlay's business.
    const cells: [number, number][] = [];
    for (let y = 0; y < 20; y++) cells.push([5, y]);
    const terrain = paintTerrain(createTerrain(20, 20), cells, 'mud');
    expect(routeExists({ ...base, destination: { x: 18, y: 5 }, terrain })).toBe(true);
  });

  it('says yes to standing still', () => {
    expect(routeExists({ ...base, destination: { x: 2, y: 5 }, terrain: jetty() })).toBe(true);
  });

  it('refuses a destination off the map', () => {
    expect(routeExists({ ...base, destination: { x: 20, y: 5 } })).toBe(false);
    expect(routeExists({ ...base, destination: { x: -1, y: 5 } })).toBe(false);
  });

  it('walks a large creature round by its whole footprint, not its corner', () => {
    // A 2x2 ogre cannot slip through a one-square gap a Medium creature can.
    const cells: [number, number][] = [];
    for (let y = 0; y < 20; y++) {
      if (y === 9) continue;
      cells.push([5, y]);
    }
    const terrain = paintTerrain(createTerrain(20, 20), cells, 'blocked');

    expect(routeExists({ ...base, destination: { x: 8, y: 5 }, terrain })).toBe(true);
    expect(
      routeExists({
        ...base,
        origin: { x: 2, y: 5, w: 2, h: 2 },
        destination: { x: 8, y: 5 },
        terrain,
      }),
    ).toBe(false);
  });

  it('lets a creature standing on blocked ground walk out of it', () => {
    // The DM may paint under a token, or place one on a chasm deliberately.
    const terrain = paintTerrain(createTerrain(20, 20), [[2, 5]], 'blocked');
    expect(routeExists({ ...base, destination: { x: 3, y: 5 }, terrain })).toBe(true);
  });

  it('refuses rather than searching the whole map for a huge detour', () => {
    // Bounded on purpose: this runs on every drop, and a spiral is otherwise a
    // way to make one handler walk thousands of squares. The player drags it in
    // two hops instead.
    const cells: [number, number][] = [];
    for (let y = 0; y < 199; y++) cells.push([100, y]);
    const terrain = paintTerrain(createTerrain(200, 200), cells, 'blocked');

    expect(
      routeExists({
        origin: { x: 99, y: 5, w: 1, h: 1 },
        destination: { x: 101, y: 5 },
        walls: [],
        bounds: { width: 200, height: 200 },
        terrain,
      }),
    ).toBe(false);
  });

  it('stays quick on a scene thick with walls', () => {
    // `movementBlocked` walks every wall on every step, so an unculled search
    // is quadratic in the same way the vision sweep was before culling.
    const walls: VisionWall[] = [];
    for (let i = 0; i < 300; i++) walls.push(wall(60 + i * 0.1, 60, 60 + i * 0.1, 70));
    walls.push(wall(5, 0, 5, 7));

    const started = performance.now();
    expect(routeExists({ ...base, destination: { x: 8, y: 5 }, walls })).toBe(true);
    expect(performance.now() - started).toBeLessThan(50);
  });
});

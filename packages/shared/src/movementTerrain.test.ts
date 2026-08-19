import { describe, expect, it } from 'vitest';
import { reachableSquares } from './movement.js';
import { createTerrain, paintTerrain } from './terrain.js';

const base = {
  origin: { x: 5, y: 5, w: 1, h: 1 },
  speedFeet: 30,
  feetPerSquare: 5,
  walls: [],
  occupied: [],
  bounds: { width: 20, height: 20 },
};

const has = (cells: [number, number][], x: number, y: number) =>
  cells.some(([cx, cy]) => cx === x && cy === y);

describe('movement over painted terrain', () => {
  it('reaches six squares on open ground', () => {
    const cells = reachableSquares(base);
    expect(has(cells, 11, 5)).toBe(true);
    expect(has(cells, 12, 5)).toBe(false);
  });

  it('never enters a blocked square', () => {
    const terrain = paintTerrain(createTerrain(20, 20), [[6, 5]], 'blocked');
    const cells = reachableSquares({ ...base, terrain });
    expect(has(cells, 6, 5)).toBe(false);
  });

  it('goes around a blockage rather than treating it as a wall', () => {
    // One painted square is an obstacle, not a barrier: the ground beyond is
    // still reachable by stepping round it.
    const terrain = paintTerrain(createTerrain(20, 20), [[6, 5]], 'blocked');
    const cells = reachableSquares({ ...base, terrain });
    expect(has(cells, 7, 5)).toBe(true);
  });

  it('halves how far you get across difficult ground', () => {
    // A band with no way round it. Painting a single row instead lets the
    // creature detour along clean ground and step in once, which is genuinely
    // cheaper and reaches further - correct behaviour, and not what this test
    // is trying to measure.
    const difficult: [number, number][] = [];
    for (let x = 6; x <= 15; x++) {
      for (let y = 0; y < 20; y++) difficult.push([x, y]);
    }
    const terrain = paintTerrain(createTerrain(20, 20), difficult, 'difficult');

    // Six squares of budget, two per square: three squares into the rubble.
    const cells = reachableSquares({ ...base, terrain });
    expect(has(cells, 8, 5)).toBe(true);
    expect(has(cells, 9, 5)).toBe(false);
  });

  it('takes the cheaper way round when rubble is dearer than a detour', () => {
    // A plain queue records the first arrival, which through the rubble is the
    // dear one, and then stops short of ground that is genuinely reachable.
    const terrain = paintTerrain(createTerrain(20, 20), [[6, 5], [6, 4], [6, 6]], 'difficult');
    const cells = reachableSquares({ ...base, terrain });

    // Round the top: 5,5 -> 5,3 -> 6,3 -> ... costs one per square.
    expect(has(cells, 6, 3)).toBe(true);
    expect(has(cells, 9, 5)).toBe(true);
  });

  it('blocks on any square a large creature would cover, not just its corner', () => {
    // An ogre is 2x2, and half of it in the chasm is still in the chasm.
    const terrain = paintTerrain(createTerrain(20, 20), [[8, 6]], 'blocked');
    const cells = reachableSquares({ ...base, origin: { x: 5, y: 5, w: 2, h: 2 }, terrain });
    expect(has(cells, 7, 5)).toBe(false);
    expect(has(cells, 8, 6)).toBe(false);
  });

  it('is unchanged when no terrain is painted', () => {
    const plain = reachableSquares(base);
    const empty = reachableSquares({ ...base, terrain: createTerrain(20, 20) });
    expect(empty.length).toBe(plain.length);
  });

  it('still includes the square you are standing on', () => {
    const terrain = paintTerrain(createTerrain(20, 20), [[5, 5]], 'difficult');
    expect(has(reachableSquares({ ...base, terrain }), 5, 5)).toBe(true);
  });
});

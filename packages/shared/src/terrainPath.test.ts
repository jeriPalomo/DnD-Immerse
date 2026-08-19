import { describe, expect, it } from 'vitest';
import { createTerrain, paintTerrain, pathBlocked } from './terrain.js';

/** A column of blocked squares at x = 4, from y = 0 to 9. */
const band = () => {
  const cells: [number, number][] = [];
  for (let y = 0; y < 10; y++) cells.push([4, y]);
  return paintTerrain(createTerrain(12, 12), cells, 'blocked');
};

describe('crossing blocked ground', () => {
  it('refuses a drag straight through it', () => {
    // The whole point: landing clear on the far side is not enough if the line
    // went through the chasm.
    expect(pathBlocked(band(), { x: 1.5, y: 5.5 }, { x: 8.5, y: 5.5 })).toBe(true);
  });

  it('allows a move that never touches it', () => {
    expect(pathBlocked(band(), { x: 1.5, y: 5.5 }, { x: 3.5, y: 5.5 })).toBe(false);
    expect(pathBlocked(band(), { x: 6.5, y: 5.5 }, { x: 8.5, y: 5.5 })).toBe(false);
  });

  it('refuses a diagonal that clips it', () => {
    expect(pathBlocked(band(), { x: 2.5, y: 2.5 }, { x: 6.5, y: 6.5 })).toBe(true);
  });

  it('lets a creature standing on blocked ground walk out of it', () => {
    // The DM may place a token on a chasm deliberately, or paint under one that
    // is already there; neither should strand it.
    expect(pathBlocked(band(), { x: 4.5, y: 5.5 }, { x: 3.5, y: 5.5 })).toBe(false);
  });

  it('still refuses moving from blocked ground deeper into it', () => {
    expect(pathBlocked(band(), { x: 4.5, y: 5.5 }, { x: 4.5, y: 8.5 })).toBe(true);
  });

  it('is not fooled by a long jump over a one-square gap', () => {
    // A coarse sample could step straight over a single blocked square.
    const spot = paintTerrain(createTerrain(40, 40), [[20, 20]], 'blocked');
    expect(pathBlocked(spot, { x: 2.5, y: 20.5 }, { x: 38.5, y: 20.5 })).toBe(true);
  });

  it('ignores rough ground, which costs but never blocks', () => {
    const rough = paintTerrain(createTerrain(12, 12), [[4, 5], [5, 5]], 'difficult');
    expect(pathBlocked(rough, { x: 1.5, y: 5.5 }, { x: 8.5, y: 5.5 })).toBe(false);
  });

  it('says no when there is no terrain at all, or no movement', () => {
    expect(pathBlocked(null, { x: 0, y: 0 }, { x: 9, y: 9 })).toBe(false);
    expect(pathBlocked(band(), { x: 1.5, y: 1.5 }, { x: 1.5, y: 1.5 })).toBe(false);
  });
});

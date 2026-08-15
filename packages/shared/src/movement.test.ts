import { describe, expect, it } from 'vitest';
import { reachableSquares, unionOfReach } from './movement.js';
import type { VisionWall } from './vision.js';

/**
 * The movement overlay is only worth drawing if it tells the truth. A range
 * that ignores a wall invites a player to plan a move the server will then
 * refuse, which is worse than showing nothing at all.
 */

const OPEN: { width: number; height: number } = { width: 20, height: 20 };

function wall(x1: number, y1: number, x2: number, y2: number, extra: Partial<VisionWall> = {}): VisionWall {
  return { x1, y1, x2, y2, blocksSight: 1, blocksMovement: 1, door: 0, doorState: 0, ...extra };
}

function reach(over: Partial<Parameters<typeof reachableSquares>[0]> = {}) {
  return reachableSquares({
    // Far enough from the edge that a 30 ft range is not clipped by the map.
    origin: { x: 6, y: 6, w: 1, h: 1 },
    speedFeet: 30,
    feetPerSquare: 5,
    walls: [],
    occupied: [],
    bounds: OPEN,
    ...over,
  });
}

const has = (squares: [number, number][], x: number, y: number) =>
  squares.some(([sx, sy]) => sx === x && sy === y);

describe('reachableSquares', () => {
  it('reaches exactly as far as the speed allows', () => {
    const squares = reach();

    // 30 ft at 5 ft a square is 6 squares, and a diagonal costs the same as a
    // straight step - so the reachable area is a 13x13 block centred on (6,6).
    expect(has(squares, 12, 6)).toBe(true);
    expect(has(squares, 13, 6)).toBe(false);
    expect(has(squares, 12, 12)).toBe(true);
    expect(squares).toHaveLength(13 * 13);
  });

  it('includes the square it is standing on', () => {
    // Standing still is a legal move, and the overlay looks broken without it.
    expect(has(reach(), 6, 6)).toBe(true);
  });

  it('is clipped by the edge of the map', () => {
    const squares = reachableSquares({
      origin: { x: 0, y: 0, w: 1, h: 1 },
      speedFeet: 30,
      feetPerSquare: 5,
      walls: [],
      occupied: [],
      bounds: { width: 4, height: 4 },
    });

    expect(squares).toHaveLength(16);
    expect(has(squares, 3, 3)).toBe(true);
    expect(has(squares, 4, 0)).toBe(false);
  });

  it('stops at a wall', () => {
    // A full-height wall down x=8, so nothing east of it is reachable.
    const squares = reach({ walls: [wall(8, 0, 8, 20)] });

    expect(has(squares, 7, 6)).toBe(true);
    expect(has(squares, 9, 6)).toBe(false);
    expect(has(squares, 9, 12)).toBe(false);
  });

  it('makes you walk around a wall, and that detour costs range', () => {
    // A wall down x=8 as far as y=10. The square straight through it is three
    // steps away in open ground and out of reach once you have to go round the
    // bottom - while the square by the wall's end stays reachable.
    const walls = [wall(8, 0, 8, 10)];

    expect(has(reach(), 9, 6)).toBe(true);
    expect(has(reach({ walls }), 9, 6)).toBe(false);
    expect(has(reach({ walls }), 9, 10)).toBe(true);
  });

  it('treats a closed door as a wall and an open one as a gap', () => {
    const shut = reach({ walls: [wall(8, 0, 8, 20, { door: 1, doorState: 0 })] });
    expect(has(shut, 9, 6)).toBe(false);

    const open = reach({ walls: [wall(8, 0, 8, 20, { door: 1, doorState: 1 })] });
    expect(has(open, 9, 6)).toBe(true);
  });

  it('treats a locked door as shut', () => {
    const locked = reach({ walls: [wall(8, 0, 8, 20, { door: 1, doorState: 2 })] });
    expect(has(locked, 9, 6)).toBe(false);
  });

  it('will not walk through another creature', () => {
    // A body filling the only gap in an otherwise sealed wall.
    const squares = reach({
      walls: [wall(8, 0, 8, 6), wall(8, 7, 8, 20)],
      occupied: [{ x: 8, y: 6, w: 1, h: 1 }],
    });

    expect(has(squares, 8, 6)).toBe(false);
    expect(has(squares, 9, 6)).toBe(false);
  });

  it('refuses a gap a large creature cannot fit through', () => {
    // A one-square gap at y=6. A Medium creature walks it; a Large one cannot.
    const walls = [wall(8, 0, 8, 6), wall(8, 7, 8, 20)];

    expect(has(reach({ walls }), 9, 6)).toBe(true);

    const large = reach({ origin: { x: 5, y: 5, w: 2, h: 2 }, walls });
    expect(has(large, 9, 5)).toBe(false);
    expect(has(large, 9, 6)).toBe(false);
  });

  it('keeps a footprint on the map', () => {
    // A 2x2 at the very corner cannot hang off the edge.
    const squares = reach({
      origin: { x: 0, y: 0, w: 2, h: 2 },
      bounds: { width: 6, height: 6 },
    });

    expect(has(squares, 0, 0)).toBe(true);
    expect(has(squares, 4, 4)).toBe(true);
    // Would put half the creature past the edge.
    expect(has(squares, 5, 5)).toBe(false);
  });

  it('gives a creature that cannot move only the square it stands on', () => {
    // Grappled and restrained both drive speed to zero.
    expect(reach({ speedFeet: 0 })).toEqual([[6, 6]]);
  });

  it('does not round a part-square of speed up into a whole one', () => {
    // 20 ft of speed on 15 ft squares is one square and change, not two.
    const squares = reach({ speedFeet: 20, feetPerSquare: 15 });
    expect(has(squares, 7, 6)).toBe(true);
    expect(has(squares, 8, 6)).toBe(false);
  });
});

describe('unionOfReach', () => {
  it('merges overlapping ranges without repeating a square', () => {
    const a: [number, number][] = [[1, 1], [1, 2]];
    const b: [number, number][] = [[1, 2], [1, 3]];

    const union = unionOfReach([a, b]);
    expect(union).toHaveLength(3);
    expect(has(union, 1, 2)).toBe(true);
  });

  it('is empty when nothing threatens', () => {
    expect(unionOfReach([])).toEqual([]);
  });
});

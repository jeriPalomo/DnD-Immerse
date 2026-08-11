import { describe, expect, it } from 'vitest';
import { blocksSight, computeVisibility, movementBlocked, type VisionWall } from './vision.js';
import { pointInPolygon } from './grid.js';
import {
  createFog,
  decodeFog,
  encodeFog,
  exploredCount,
  isExplored,
  markVisible,
  mergeFog,
} from './fog.js';

function wall(x1: number, y1: number, x2: number, y2: number, over: Partial<VisionWall> = {}): VisionWall {
  return { x1, y1, x2, y2, blocksSight: 1, door: 0, doorState: 0, ...over };
}

/** A closed 10x10 room with a doorway on the east side at y 4..6. */
function sealedRoom(doorState = 0): VisionWall[] {
  return [
    wall(0, 0, 10, 0),
    wall(0, 10, 10, 10),
    wall(0, 0, 0, 10),
    wall(10, 0, 10, 4),
    wall(10, 6, 10, 10),
    wall(10, 4, 10, 6, { door: 1, doorState }),
  ];
}

describe('blocksSight', () => {
  it('blocks for a plain wall', () => {
    expect(blocksSight(wall(0, 0, 1, 0))).toBe(true);
  });

  it('stops blocking once a door is opened', () => {
    expect(blocksSight(wall(0, 0, 1, 0, { door: 1, doorState: 0 }))).toBe(true);
    expect(blocksSight(wall(0, 0, 1, 0, { door: 1, doorState: 1 }))).toBe(false);
    // A locked door is still shut.
    expect(blocksSight(wall(0, 0, 1, 0, { door: 1, doorState: 2 }))).toBe(true);
  });

  it('ignores walls that do not block sight at all', () => {
    expect(blocksSight(wall(0, 0, 1, 0, { blocksSight: 0 }))).toBe(false);
  });
});

describe('computeVisibility', () => {
  it('produces a closed polygon with no walls at all', () => {
    const polygon = computeVisibility({ x: 0, y: 0 }, [], 10);
    expect(polygon.length).toBeGreaterThan(8);
    // Everything inside the radius is visible.
    expect(pointInPolygon({ x: 5, y: 0 }, polygon)).toBe(true);
  });

  it('confines a token inside a sealed room', () => {
    const polygon = computeVisibility({ x: 5, y: 5 }, sealedRoom(), 100);

    expect(pointInPolygon({ x: 5, y: 5 }, polygon)).toBe(true);
    expect(pointInPolygon({ x: 9, y: 9 }, polygon)).toBe(true);

    // Nothing beyond the walls, in any direction.
    expect(pointInPolygon({ x: 20, y: 5 }, polygon)).toBe(false);
    expect(pointInPolygon({ x: -5, y: 5 }, polygon)).toBe(false);
    expect(pointInPolygon({ x: 5, y: 30 }, polygon)).toBe(false);
  });

  it('does not leak past a wall corner', () => {
    // A single wall between the viewer and a point directly behind it.
    const walls = [wall(5, -5, 5, 5)];
    const polygon = computeVisibility({ x: 0, y: 0 }, walls, 50);

    expect(pointInPolygon({ x: 10, y: 0 }, polygon)).toBe(false);
    // The area past the wall's end is still visible.
    expect(pointInPolygon({ x: 10, y: 20 }, polygon)).toBe(true);
  });

  it('extends the view through an opened door', () => {
    const closed = computeVisibility({ x: 5, y: 5 }, sealedRoom(0), 100);
    const open = computeVisibility({ x: 5, y: 5 }, sealedRoom(1), 100);

    const beyond = { x: 20, y: 5 };
    expect(pointInPolygon(beyond, closed)).toBe(false);
    // Opening the door is the moment the room beyond blooms into view.
    expect(pointInPolygon(beyond, open)).toBe(true);
  });

  it('respects the vision radius', () => {
    const polygon = computeVisibility({ x: 0, y: 0 }, [], 5);
    expect(pointInPolygon({ x: 3, y: 0 }, polygon)).toBe(true);
    expect(pointInPolygon({ x: 8, y: 0 }, polygon)).toBe(false);
  });

  it('stays fast enough to recompute on every drag frame', () => {
    // 300 walls is a dense dungeon; the budget is a few milliseconds.
    const walls = Array.from({ length: 300 }, (_, i) =>
      wall(i % 30, Math.floor(i / 30), (i % 30) + 1, Math.floor(i / 30) + 1),
    );

    const started = performance.now();
    computeVisibility({ x: 15, y: 5 }, walls, 60);
    expect(performance.now() - started).toBeLessThan(150);
  });
});

describe('movementBlocked', () => {
  it('stops a move that crosses a wall', () => {
    expect(movementBlocked({ x: 0, y: 5 }, { x: 20, y: 5 }, sealedRoom())).toBe(true);
  });

  it('allows a move through an open door', () => {
    expect(movementBlocked({ x: 5, y: 5 }, { x: 20, y: 5 }, sealedRoom(1))).toBe(false);
  });

  it('allows a move that stays inside the room', () => {
    expect(movementBlocked({ x: 2, y: 2 }, { x: 8, y: 8 }, sealedRoom())).toBe(false);
  });
});

describe('fog bitmap', () => {
  it('starts entirely unexplored', () => {
    const fog = createFog(20, 20);
    expect(exploredCount(fog)).toBe(0);
    expect(isExplored(fog, 5, 5)).toBe(false);
  });

  it('marks the squares inside a visible polygon', () => {
    const fog = createFog(20, 20);
    const polygon = computeVisibility({ x: 5.5, y: 5.5 }, [], 3);

    const marked = markVisible(fog, [polygon]);
    expect(marked).toBeGreaterThan(0);
    expect(isExplored(fog, 5, 5)).toBe(true);
    // Well outside the radius.
    expect(isExplored(fog, 15, 15)).toBe(false);
  });

  it('accumulates rather than replacing, so exploration persists', () => {
    const fog = createFog(30, 30);
    markVisible(fog, [computeVisibility({ x: 2.5, y: 2.5 }, [], 2)]);
    const first = exploredCount(fog);

    markVisible(fog, [computeVisibility({ x: 20.5, y: 20.5 }, [], 2)]);

    expect(exploredCount(fog)).toBeGreaterThan(first);
    // The first room is still remembered.
    expect(isExplored(fog, 2, 2)).toBe(true);
  });

  it('round-trips through base64 unchanged', () => {
    const fog = createFog(40, 25);
    markVisible(fog, [computeVisibility({ x: 10.5, y: 10.5 }, [], 4)]);

    const restored = decodeFog(encodeFog(fog), 40, 25);
    expect(exploredCount(restored)).toBe(exploredCount(fog));
    expect(isExplored(restored, 10, 10)).toBe(true);
  });

  it('survives a corrupt payload by starting fresh', () => {
    const fog = decodeFog('!!!not base64!!!', 10, 10);
    expect(fog.width).toBe(10);
    expect(exploredCount(fog)).toBe(0);
  });

  it('merges two players exploration with a bitwise OR', () => {
    const alice = createFog(30, 30);
    const bob = createFog(30, 30);

    markVisible(alice, [computeVisibility({ x: 2.5, y: 2.5 }, [], 2)]);
    markVisible(bob, [computeVisibility({ x: 25.5, y: 25.5 }, [], 2)]);

    mergeFog(alice, bob);
    expect(isExplored(alice, 2, 2)).toBe(true);
    expect(isExplored(alice, 25, 25)).toBe(true);
  });

  it('ignores writes outside the bitmap', () => {
    const fog = createFog(10, 10);
    expect(isExplored(fog, -1, 5)).toBe(false);
    expect(isExplored(fog, 100, 5)).toBe(false);
  });

  it('stays small: a 100x100 scene fits in about 1.25KB', () => {
    const fog = createFog(100, 100);
    expect(fog.bits.length).toBe(1250);
  });
});

import { describe, expect, it } from 'vitest';
import {
  blocksMovement,
  blocksSight,
  combinedVisibility,
  computeVisibility,
  movementBlocked,
  sightRadiusFeet,
  type VisionWall,
} from './vision.js';
import { pointInPolygon } from './grid.js';
import { createFog, decodeFog, encodeFog, isExplored, markVisible } from './fog.js';

function wall(x1: number, y1: number, x2: number, y2: number, over: Partial<VisionWall> = {}): VisionWall {
  return { x1, y1, x2, y2, blocksSight: 1, blocksMovement: 1, door: 0, doorState: 0, ...over };
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

  it('ignores walls beyond the vision radius', () => {
    const near = wall(5, -5, 5, 5);
    const faraway = wall(500, -5, 500, 5);

    // A wall 500 squares away cannot occlude anything within 12, so the
    // polygon must be identical whether or not it is in the list.
    const withFar = computeVisibility({ x: 0, y: 0 }, [near, faraway], 12);
    const without = computeVisibility({ x: 0, y: 0 }, [near], 12);
    expect(withFar).toEqual(without);
  });

  it('costs about the same in a big dungeon as a small one', () => {
    // The sweep casts three rays per corner and tests each against every wall,
    // so without radius culling cost grows with the SQUARE of the wall count -
    // 300 walls measured at 13.8ms before culling, which blows a 30Hz budget
    // several times over once every player is recomputed.
    const build = (count: number) =>
      Array.from({ length: count }, (_, i) =>
        wall((i % 40) * 3, Math.floor(i / 40) * 3, (i % 40) * 3 + 2, Math.floor(i / 40) * 3),
      );

    const time = (walls: VisionWall[]) => {
      for (let i = 0; i < 20; i++) computeVisibility({ x: 5, y: 5 }, walls, 12);
      const started = performance.now();
      for (let i = 0; i < 50; i++) computeVisibility({ x: 5, y: 5 }, walls, 12);
      return (performance.now() - started) / 50;
    };

    const small = time(build(100));
    const large = time(build(1200));

    // Flat rather than quadratic: a twelvefold dungeon must not cost
    // twelvefold, let alone a hundredfold.
    expect(large).toBeLessThan(Math.max(small * 4, 2));
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

    markVisible(fog, [computeVisibility({ x: 20.5, y: 20.5 }, [], 2)]);

    // Both rooms are remembered, not just the most recent.
    expect(isExplored(fog, 2, 2)).toBe(true);
    expect(isExplored(fog, 20, 20)).toBe(true);
  });

  it('round-trips through base64 unchanged', () => {
    const fog = createFog(40, 25);
    markVisible(fog, [computeVisibility({ x: 10.5, y: 10.5 }, [], 4)]);

    const restored = decodeFog(encodeFog(fog), 40, 25);
    expect(isExplored(restored, 10, 10)).toBe(true);
    expect(isExplored(restored, 39, 24)).toBe(false);
  });

  it('survives a corrupt payload by starting fresh', () => {
    const fog = decodeFog('!!!not base64!!!', 10, 10);
    expect(fog.width).toBe(10);
    expect(isExplored(fog, 5, 5)).toBe(false);
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

describe('sight and movement are separate properties', () => {
  it('lets a railing block movement without blocking sight', () => {
    const railing = wall(0, 0, 5, 0, { blocksSight: 0, blocksMovement: 1 });

    expect(blocksSight(railing)).toBe(false);
    expect(blocksMovement(railing)).toBe(true);
    // You can see over it but not walk through it.
    expect(movementBlocked({ x: 2, y: -2 }, { x: 2, y: 2 }, [railing])).toBe(true);
  });

  it('lets a curtain block sight without blocking movement', () => {
    const curtain = wall(0, 0, 5, 0, { blocksSight: 1, blocksMovement: 0 });

    expect(blocksSight(curtain)).toBe(true);
    expect(blocksMovement(curtain)).toBe(false);
    expect(movementBlocked({ x: 2, y: -2 }, { x: 2, y: 2 }, [curtain])).toBe(false);
  });

  it('lets an open door through in both senses', () => {
    const door = wall(0, 0, 5, 0, { door: 1, doorState: 1 });
    expect(blocksSight(door)).toBe(false);
    expect(blocksMovement(door)).toBe(false);
  });
});

describe('sightRadiusFeet', () => {
  const torchbearer = { visionRange: 0, darkvisionRange: 0, lightBright: 20 };
  const dwarf = { visionRange: 0, darkvisionRange: 60, lightBright: 0 };
  const blindfolded = { visionRange: 0, darkvisionRange: 0, lightBright: 0 };

  it('uses the full vision range in daylight', () => {
    expect(sightRadiusFeet(dwarf, true, 60)).toBe(60);
    expect(sightRadiusFeet(torchbearer, true, 60)).toBe(60);
    expect(sightRadiusFeet({ ...dwarf, visionRange: 120 }, true, 60)).toBe(120);
  });

  it('falls back to darkvision when the lights go out', () => {
    // The dwarf keeps 60 ft; the torchbearer sees only as far as the torch.
    expect(sightRadiusFeet(dwarf, false, 60)).toBe(60);
    expect(sightRadiusFeet(torchbearer, false, 60)).toBe(20);
  });

  it('leaves a creature with neither able to see its own square', () => {
    // Not blind - a fully black screen with no explanation is a bug report.
    expect(sightRadiusFeet(blindfolded, false, 60, 5)).toBe(5);
  });

  it('lets dim light extend sight past the bright radius', () => {
    // A torch: 20 ft bright, 20 ft dim beyond it. You can see 40 ft, dimly.
    const torch = { visionRange: 0, darkvisionRange: 0, lightBright: 20, lightDim: 40 };
    expect(sightRadiusFeet(torch, false, 60)).toBe(40);
  });

  it('never lets darkness exceed the lit range', () => {
    const owl = { visionRange: 30, darkvisionRange: 120, lightBright: 0 };
    expect(sightRadiusFeet(owl, false, 60)).toBe(30);
  });

  it('sees nothing at all when blinded, torch or darkvision regardless', () => {
    // The one case that is meant to be a black screen. A torch does not help a
    // creature that cannot see, and neither does daylight.
    expect(sightRadiusFeet({ ...dwarf, blinded: true }, false, 60)).toBe(0);
    expect(sightRadiusFeet({ ...torchbearer, blinded: true }, false, 60)).toBe(0);
    expect(sightRadiusFeet({ ...dwarf, blinded: true }, true, 60)).toBe(0);
  });

  it('contributes no polygon at all for a blinded token', () => {
    // combinedVisibility drops zero-radius sources, which is what stops a
    // blinded player from opening any fog.
    const radius = sightRadiusFeet({ ...dwarf, blinded: true }, true, 60);
    expect(combinedVisibility([{ point: { x: 5, y: 5 }, radius }], [])).toEqual([]);
  });
});

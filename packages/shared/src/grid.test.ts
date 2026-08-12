import { describe, expect, it } from 'vitest';
import {
  CREATURE_SIZES,
  gridDistance,
  gridToPixel,
  pixelToGrid,
  pointInPolygon,
  snapTokenPosition,
  tokenCenter,
  tokenDistance,
  tokenDistanceInFeet,
} from './grid.js';

const GRID = { gridSize: 70, offsetX: 12, offsetY: 8 };

describe('pixel <-> grid conversion', () => {
  it('round-trips exactly', () => {
    const original = { x: 4.5, y: 7.25 };
    expect(pixelToGrid(gridToPixel(original, GRID), GRID)).toEqual(original);
  });

  it('honours the grid offset', () => {
    expect(gridToPixel({ x: 0, y: 0 }, GRID)).toEqual({ x: 12, y: 8 });
    expect(gridToPixel({ x: 1, y: 2 }, GRID)).toEqual({ x: 82, y: 148 });
  });
});

describe('gridDistance', () => {
  it('treats diagonals as one square under the standard rule', () => {
    expect(gridDistance({ x: 0, y: 0 }, { x: 3, y: 3 })).toBe(3);
    expect(gridDistance({ x: 0, y: 0 }, { x: 0, y: 5 })).toBe(5);
  });

  it('charges every second diagonal double under the variant rule', () => {
    // Four diagonal steps: 4 + floor(4/2) = 6.
    expect(gridDistance({ x: 0, y: 0 }, { x: 4, y: 4 }, 'variant')).toBe(6);
    // Straight lines are unaffected by the variant rule.
    expect(gridDistance({ x: 0, y: 0 }, { x: 5, y: 0 }, 'variant')).toBe(5);
  });
});

describe('tokenDistance', () => {
  const medium = (x: number, y: number) => ({ x, y, w: 1, h: 1 });

  it('reports adjacent medium creatures as 5 feet, not 0', () => {
    expect(tokenDistanceInFeet(medium(0, 0), medium(1, 0))).toBe(5);
  });

  it('reports diagonally adjacent creatures as 5 feet', () => {
    expect(tokenDistanceInFeet(medium(0, 0), medium(1, 1))).toBe(5);
  });

  it('counts the gap plus the target square', () => {
    expect(tokenDistanceInFeet(medium(0, 0), medium(2, 0))).toBe(10);
    expect(tokenDistanceInFeet(medium(0, 0), medium(5, 0))).toBe(25);
  });

  it('measures to a Gargantuan dragon’s nearest square, not its center', () => {
    // A 4x4 ancient dragon with a medium PC pressed against its right flank.
    const dragon = { x: 0, y: 0, w: CREATURE_SIZES.gargantuan, h: CREATURE_SIZES.gargantuan };
    const pc = medium(4, 0);

    // Center-to-center would be 25ft and would wrongly refuse a melee attack.
    expect(tokenDistanceInFeet(pc, dragon)).toBe(5);
  });

  it('finds every square along a Gargantuan flank equally adjacent', () => {
    const dragon = { x: 0, y: 0, w: 4, h: 4 };
    for (let y = 0; y < 4; y++) {
      expect(tokenDistanceInFeet({ x: 4, y, w: 1, h: 1 }, dragon)).toBe(5);
    }
  });

  it('is symmetric', () => {
    const huge = { x: 2, y: 2, w: 3, h: 3 };
    const pc = medium(7, 3);
    expect(tokenDistance(pc, huge)).toBe(tokenDistance(huge, pc));
  });

  it('returns 0 for overlapping footprints', () => {
    expect(tokenDistance(medium(1, 1), { x: 0, y: 0, w: 3, h: 3 })).toBe(0);
  });
});

describe('snapTokenPosition', () => {
  it('lands a medium token centered in a square', () => {
    const snapped = snapTokenPosition({ x: 3.4, y: 6.7 }, 1, 1);
    expect(snapped).toEqual({ x: 3, y: 7 });
    expect(tokenCenter({ ...snapped, w: 1, h: 1 })).toEqual({ x: 3.5, y: 7.5 });
  });

  it('lands a large token centered on a grid intersection', () => {
    const snapped = snapTokenPosition({ x: 2.6, y: 4.2 }, 2, 2);
    expect(snapped).toEqual({ x: 3, y: 4 });
    // Whole numbers mean the center sits on a line crossing, as it should.
    expect(tokenCenter({ ...snapped, w: 2, h: 2 })).toEqual({ x: 4, y: 5 });
  });

  it('lets four tiny tokens share one square', () => {
    expect(snapTokenPosition({ x: 3.3, y: 3.3 }, 0.5, 0.5)).toEqual({ x: 3.5, y: 3.5 });
    expect(snapTokenPosition({ x: 3.1, y: 3.1 }, 0.5, 0.5)).toEqual({ x: 3, y: 3 });
  });
});

describe('pointInPolygon', () => {
  const room = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];

  it('detects points inside and outside', () => {
    expect(pointInPolygon({ x: 5, y: 5 }, room)).toBe(true);
    expect(pointInPolygon({ x: 15, y: 5 }, room)).toBe(false);
  });

  it('rejects a degenerate polygon', () => {
    expect(pointInPolygon({ x: 0, y: 0 }, [{ x: 0, y: 0 }])).toBe(false);
  });
});

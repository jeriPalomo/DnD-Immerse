import { describe, expect, it } from 'vitest';
import {
  createTerrain,
  encodeTerrain,
  isBlockedAt,
  paintTerrain,
  paintedCells,
  stepCostAt,
  terrainAt,
  terrainForGrid,
  terrainMatchesGrid,
  COST_NORMAL,
  TERRAIN_BRUSHES,
  TERRAIN_COST,
  TERRAIN_KINDS,
  TERRAIN_LABEL,
} from './terrain.js';

describe('painted terrain', () => {
  it('paints and reads back', () => {
    const t = paintTerrain(createTerrain(10, 10), [[2, 3], [3, 3]], 'blocked');
    expect(isBlockedAt(t, 2, 3)).toBe(true);
    expect(isBlockedAt(t, 3, 3)).toBe(true);
    expect(isBlockedAt(t, 4, 3)).toBe(false);
  });

  it('costs in half squares, so mud is double and a ford half again', () => {
    // Whole squares cannot express one and a half, which is the entire reason
    // the unit is halves: a rounded ford is either free or a bog.
    let t = paintTerrain(createTerrain(6, 6), [[1, 1]], 'mud');
    t = paintTerrain(t, [[2, 1]], 'water');
    expect(stepCostAt(t, 1, 1)).toBe(2 * COST_NORMAL);
    expect(stepCostAt(t, 2, 1)).toBe(1.5 * COST_NORMAL);
    expect(stepCostAt(t, 0, 0)).toBe(COST_NORMAL);
    expect(stepCostAt(null, 1, 1)).toBe(COST_NORMAL);
  });

  it('costs nothing extra for blocked ground, which is never entered', () => {
    // Callers skip it the way they skip an occupied square, so a cost here
    // would be a number nothing reads and everything could disagree about.
    const t = paintTerrain(createTerrain(6, 6), [[1, 1]], 'blocked');
    expect(stepCostAt(t, 1, 1)).toBe(COST_NORMAL);
  });

  it('gives every kind a label, and every passable one a cost above open floor', () => {
    for (const kind of TERRAIN_KINDS) {
      expect(TERRAIN_LABEL[kind]).toBeTruthy();
      if (kind !== 'blocked') expect(TERRAIN_COST[kind]).toBeGreaterThan(COST_NORMAL);
    }
    expect(TERRAIN_BRUSHES).toContain('clear');
  });

  it('never leaves a square carrying two kinds at once', () => {
    // A lake that becomes a ford must not stay impassable underneath, refusing
    // every step for a reason nothing on screen explains.
    let t = paintTerrain(createTerrain(6, 6), [[2, 2]], 'blocked');
    t = paintTerrain(t, [[2, 2]], 'mud');
    expect(isBlockedAt(t, 2, 2)).toBe(false);
    expect(terrainAt(t, 2, 2)).toBe('mud');

    t = paintTerrain(t, [[2, 2]], 'water');
    expect(terrainAt(t, 2, 2)).toBe('water');
    expect(stepCostAt(t, 2, 2)).toBe(TERRAIN_COST.water);
  });

  it('clears a square back to ordinary ground', () => {
    let t = paintTerrain(createTerrain(6, 6), [[4, 4]], 'blocked');
    t = paintTerrain(t, [[4, 4]], 'clear');
    expect(isBlockedAt(t, 4, 4)).toBe(false);
    expect(terrainAt(t, 4, 4)).toBe(null);
    expect(stepCostAt(t, 4, 4)).toBe(COST_NORMAL);
  });

  it('does not mutate the map it was given', () => {
    const before = createTerrain(5, 5);
    const after = paintTerrain(before, [[1, 1]], 'blocked');
    expect(isBlockedAt(before, 1, 1)).toBe(false);
    expect(isBlockedAt(after, 1, 1)).toBe(true);
  });

  it('survives the round trip through storage', () => {
    let t = paintTerrain(createTerrain(12, 9), [[0, 0], [11, 8]], 'blocked');
    t = paintTerrain(t, [[5, 5]], 'mud');
    t = paintTerrain(t, [[6, 5]], 'water');
    const stored = { gridWidth: 12, gridHeight: 9, ...encodeTerrain(t) };
    const back = terrainForGrid(stored, 12, 9);
    expect(isBlockedAt(back, 0, 0)).toBe(true);
    expect(isBlockedAt(back, 11, 8)).toBe(true);
    expect(terrainAt(back, 5, 5)).toBe('mud');
    expect(terrainAt(back, 6, 5)).toBe('water');
  });

  it('drops terrain painted at another grid rather than smearing it', () => {
    // The bits are indexed by width; read at a different width every row shifts
    // and a lake lands diagonally across the map.
    const t = paintTerrain(createTerrain(12, 9), [[3, 3]], 'blocked');
    const stored = { gridWidth: 12, gridHeight: 9, ...encodeTerrain(t) };

    expect(terrainMatchesGrid(stored, 12, 9)).toBe(true);
    expect(terrainMatchesGrid(stored, 20, 9)).toBe(false);
    expect(isBlockedAt(terrainForGrid(stored, 20, 15), 3, 3)).toBe(false);
    expect(paintedCells(terrainForGrid(stored, 20, 15)).blocked).toHaveLength(0);
  });

  it('lists painted squares for the overlay, each in one bucket', () => {
    let t = paintTerrain(createTerrain(8, 8), [[1, 1], [2, 1]], 'blocked');
    t = paintTerrain(t, [[5, 5]], 'mud');
    t = paintTerrain(t, [[6, 6]], 'water');
    const cells = paintedCells(t);
    expect(cells.blocked).toEqual([[1, 1], [2, 1]]);
    expect(cells.mud).toEqual([[5, 5]]);
    expect(cells.water).toEqual([[6, 6]]);
  });

  it('ignores squares off the edge instead of throwing', () => {
    const t = paintTerrain(createTerrain(4, 4), [[9, 9], [-1, 0]], 'blocked');
    expect(paintedCells(t).blocked).toHaveLength(0);
  });
});

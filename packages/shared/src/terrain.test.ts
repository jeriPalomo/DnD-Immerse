import { describe, expect, it } from 'vitest';
import {
  createTerrain,
  encodeTerrain,
  isBlockedAt,
  isDifficultAt,
  paintTerrain,
  paintedCells,
  stepCostAt,
  terrainForGrid,
  terrainMatchesGrid,
} from './terrain.js';

describe('painted terrain', () => {
  it('paints and reads back', () => {
    const t = paintTerrain(createTerrain(10, 10), [[2, 3], [3, 3]], 'blocked');
    expect(isBlockedAt(t, 2, 3)).toBe(true);
    expect(isBlockedAt(t, 3, 3)).toBe(true);
    expect(isBlockedAt(t, 4, 3)).toBe(false);
  });

  it('costs double on difficult ground and one everywhere else', () => {
    const t = paintTerrain(createTerrain(6, 6), [[1, 1]], 'difficult');
    expect(stepCostAt(t, 1, 1)).toBe(2);
    expect(stepCostAt(t, 0, 0)).toBe(1);
    expect(stepCostAt(null, 1, 1)).toBe(1);
  });

  it('never leaves a square both blocked and difficult', () => {
    // A lake that becomes a ford must not stay impassable underneath, refusing
    // every step for a reason nothing on screen explains.
    let t = paintTerrain(createTerrain(6, 6), [[2, 2]], 'blocked');
    t = paintTerrain(t, [[2, 2]], 'difficult');
    expect(isBlockedAt(t, 2, 2)).toBe(false);
    expect(isDifficultAt(t, 2, 2)).toBe(true);
  });

  it('clears a square back to ordinary ground', () => {
    let t = paintTerrain(createTerrain(6, 6), [[4, 4]], 'blocked');
    t = paintTerrain(t, [[4, 4]], 'clear');
    expect(isBlockedAt(t, 4, 4)).toBe(false);
    expect(isDifficultAt(t, 4, 4)).toBe(false);
    expect(stepCostAt(t, 4, 4)).toBe(1);
  });

  it('does not mutate the map it was given', () => {
    const before = createTerrain(5, 5);
    const after = paintTerrain(before, [[1, 1]], 'blocked');
    expect(isBlockedAt(before, 1, 1)).toBe(false);
    expect(isBlockedAt(after, 1, 1)).toBe(true);
  });

  it('survives the round trip through storage', () => {
    const t = paintTerrain(paintTerrain(createTerrain(12, 9), [[0, 0], [11, 8]], 'blocked'), [[5, 5]], 'difficult');
    const stored = { gridWidth: 12, gridHeight: 9, ...encodeTerrain(t) };
    const back = terrainForGrid(stored, 12, 9);
    expect(isBlockedAt(back, 0, 0)).toBe(true);
    expect(isBlockedAt(back, 11, 8)).toBe(true);
    expect(isDifficultAt(back, 5, 5)).toBe(true);
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
    t = paintTerrain(t, [[5, 5]], 'difficult');
    const cells = paintedCells(t);
    expect(cells.blocked).toEqual([[1, 1], [2, 1]]);
    expect(cells.difficult).toEqual([[5, 5]]);
  });

  it('ignores squares off the edge instead of throwing', () => {
    const t = paintTerrain(createTerrain(4, 4), [[9, 9], [-1, 0]], 'blocked');
    expect(paintedCells(t).blocked).toHaveLength(0);
  });
});

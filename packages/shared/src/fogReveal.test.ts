import { describe, expect, it } from 'vitest';
import { createFog, decodeFog, encodeFog, exploredCells, isExplored, revealAll } from './fog.js';

describe('revealing a whole scene', () => {
  it('marks every square, and only squares that exist', () => {
    const fog = revealAll(5, 3);
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 5; x++) expect(isExplored(fog, x, y), `${x},${y}`).toBe(true);
    }
    // 15 squares, not the 16 the last byte has room for. Filling the byte array
    // would report squares past the edge of the map.
    expect(exploredCells(fog)).toHaveLength(15);
  });

  it('claims nothing outside the grid', () => {
    const fog = revealAll(4, 4);
    expect(isExplored(fog, 4, 0)).toBe(false);
    expect(isExplored(fog, 0, 4)).toBe(false);
    expect(isExplored(fog, -1, 0)).toBe(false);
  });

  it('survives the round trip through storage', () => {
    // Fog is stored base64 at a stated width; a revealed scene has to come back
    // revealed or the DM's dramatic door-opening is undone by a reload.
    const fog = revealAll(9, 7);
    const back = decodeFog(encodeFog(fog), 9, 7);
    expect(exploredCells(back)).toHaveLength(63);
  });

  it('is the opposite of a fresh bitmap', () => {
    expect(exploredCells(createFog(6, 6))).toHaveLength(0);
    expect(exploredCells(revealAll(6, 6))).toHaveLength(36);
  });

  it('copes with an empty grid rather than throwing', () => {
    expect(exploredCells(revealAll(0, 0))).toHaveLength(0);
  });
});

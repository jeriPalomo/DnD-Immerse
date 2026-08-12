import { describe, expect, it } from 'vitest';
import {
  MIN_SQUARE_PX,
  bestOffset,
  detectGrid,
  dominantPeriod,
  edgeProfile,
} from './gridDetect.js';

/**
 * Synthetic maps, so the expected answer is known exactly.
 *
 * The important cases are the negative ones: a photograph with no grid must
 * report low confidence rather than an arbitrary number, because a confident
 * wrong guess is worse than admitting it does not know.
 */
function drawGrid(
  width: number,
  height: number,
  square: number,
  offsetX = 0,
  offsetY = 0,
  noise = 0,
): Uint8Array {
  const pixels = new Uint8Array(width * height).fill(200);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const onLine = (x - offsetX) % square === 0 || (y - offsetY) % square === 0;
      let value = onLine ? 40 : 200;
      if (noise > 0) value += Math.round((((x * 7919 + y * 104729) % 100) / 100 - 0.5) * noise);
      pixels[y * width + x] = Math.max(0, Math.min(255, value));
    }
  }

  return pixels;
}

describe('edgeProfile', () => {
  it('spikes where the lines are', () => {
    const gray = drawGrid(120, 120, 30);
    const columns = edgeProfile(gray, 120, 120, 'x');

    // Column 30 is a line, column 15 is empty floor.
    expect(columns[30]).toBeGreaterThan(columns[15]);
  });

  it('is flat for a blank image', () => {
    const blank = new Uint8Array(60 * 60).fill(128);
    const profile = edgeProfile(blank, 60, 60, 'x');
    expect(Math.max(...profile)).toBe(0);
  });
});

describe('dominantPeriod', () => {
  it('finds the pitch of a clean grid', () => {
    const gray = drawGrid(400, 400, 50);
    const { period } = dominantPeriod(edgeProfile(gray, 400, 400, 'x'));
    expect(period).toBe(50);
  });

  it('reports no period for noise alone', () => {
    const noise = new Uint8Array(300 * 300);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 7919) % 255;

    const { strength } = dominantPeriod(edgeProfile(noise, 300, 300, 'x'));
    // Not "no answer", but nothing standing out from the crowd.
    expect(strength).toBeLessThan(4);
  });
});

describe('bestOffset', () => {
  it('locates the first line', () => {
    const gray = drawGrid(300, 300, 40, 12, 0);
    const columns = edgeProfile(gray, 300, 300, 'x');
    expect(bestOffset(columns, 40) % 40).toBe(12);
  });

  it('is zero for a zero period rather than dividing by it', () => {
    expect(bestOffset([1, 2, 3], 0)).toBe(0);
  });
});

describe('detectGrid', () => {
  it('recovers size and offset from a clean map', () => {
    const gray = drawGrid(500, 500, 70, 20, 35);
    const guess = detectGrid(gray, 500, 500);

    expect(guess.size).toBe(70);
    expect(guess.offsetX).toBe(20);
    expect(guess.offsetY).toBe(35);
    expect(guess.confidence).toBeGreaterThan(0.5);
  });

  it('survives a noisy map', () => {
    const gray = drawGrid(500, 500, 60, 0, 0, 60);
    const guess = detectGrid(gray, 500, 500);

    expect(guess.size).toBe(60);
    expect(guess.confidence).toBeGreaterThan(0.2);
  });

  it('handles a non-square offset pair', () => {
    const guess = detectGrid(drawGrid(480, 480, 48, 7, 41), 480, 480);
    expect(guess.size).toBe(48);
    expect(guess.offsetX).toBe(7);
    expect(guess.offsetY).toBe(41);
  });

  it('admits it does not know on an image with no grid', () => {
    // A smooth gradient, like an aerial photograph with no drawn lines.
    const gray = new Uint8Array(300 * 300);
    for (let y = 0; y < 300; y++) {
      for (let x = 0; x < 300; x++) gray[y * 300 + x] = Math.round((x / 300) * 255);
    }

    // A confident wrong answer is worse than a shrug.
    expect(detectGrid(gray, 300, 300).confidence).toBeLessThan(0.35);
  });

  it('reports nothing for a blank image', () => {
    const blank = new Uint8Array(200 * 200).fill(180);
    const guess = detectGrid(blank, 200, 200);

    expect(guess.size).toBe(0);
    expect(guess.confidence).toBe(0);
  });

  it('refuses a pitch too small to be a battle grid', () => {
    // Fine hatching at 8px is texture, not a grid worth snapping tokens to.
    const gray = drawGrid(300, 300, 8);
    expect(detectGrid(gray, 300, 300).size).not.toBe(8);
    expect(MIN_SQUARE_PX).toBeGreaterThan(8);
  });
});

import { describe, expect, it } from 'vitest';
import {
  ACTIVE_FACE_PX,
  FACE_GAP_PX,
  FACE_PX,
  layoutTurnBar,
  stackOpacity,
} from './turnBarLayout.js';

const widthFor = (faces: number) => ACTIVE_FACE_PX + (faces - 1) * (FACE_PX + FACE_GAP_PX);

describe('laying out the turn bar', () => {
  it('leaves everyone standing when they all fit', () => {
    expect(layoutTurnBar(5, widthFor(5)).openCount).toBe(5);
    expect(layoutTurnBar(5, 2000).openCount).toBe(5);
  });

  it('stacks the tail once they do not', () => {
    const { openCount } = layoutTurnBar(20, 600);
    expect(openCount).toBeGreaterThan(0);
    expect(openCount).toBeLessThan(20);
  });

  it('never lets the open row exceed the space it was given', () => {
    for (const width of [200, 350, 600, 900, 1330]) {
      const { openCount } = layoutTurnBar(30, width);
      expect(widthFor(openCount)).toBeLessThanOrEqual(width);
    }
  });

  it('packs a bigger horde tighter rather than growing the bar', () => {
    const few = layoutTurnBar(10, 600);
    const many = layoutTurnBar(40, 600);
    expect(many.stackStep).toBeLessThanOrEqual(few.stackStep);

    // Whatever the count, the fan stays inside its share of the strip.
    const stacked = 40 - many.openCount;
    const fanWidth = FACE_PX + (stacked - 1) * many.stackStep;
    expect(fanWidth).toBeLessThanOrEqual(600 * 0.3 + FACE_PX);
  });

  it('always shows at least the creature that is acting', () => {
    // Even absurdly narrow, the turn in progress is the one thing that must
    // never disappear.
    expect(layoutTurnBar(12, 40).openCount).toBe(1);
    expect(layoutTurnBar(12, 1).openCount).toBe(1);
  });

  it('copes with an empty or unmeasured bar instead of dividing by zero', () => {
    expect(layoutTurnBar(0, 500).openCount).toBe(0);
    expect(layoutTurnBar(6, 0).openCount).toBe(6);
    expect(Number.isFinite(layoutTurnBar(6, 0).stackStep)).toBe(true);
  });

  it('fades along the fan, and never past invisible', () => {
    expect(stackOpacity(0, 5)).toBeGreaterThan(stackOpacity(4, 5));
    for (const n of [1, 2, 9, 30]) {
      for (let i = 0; i < n; i++) {
        const o = stackOpacity(i, n);
        expect(o).toBeGreaterThan(0);
        expect(o).toBeLessThanOrEqual(1);
      }
    }
  });

  it('keeps the gap constant so the arithmetic matches the rendered row', () => {
    expect(FACE_GAP_PX).toBeGreaterThan(0);
    expect(ACTIVE_FACE_PX).toBeGreaterThan(FACE_PX);
  });
});

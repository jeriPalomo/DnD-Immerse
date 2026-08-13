import { describe, expect, it } from 'vitest';
import {
  CONE_ANGLE_DEGREES,
  coveredSquares,
  templateCovers,
  templateForSpell,
  tokensInTemplate,
  type Template,
} from './aoe.js';

const context = { feetPerSquare: 5 };

function template(over: Partial<Template>): Template {
  return { shape: 'circle', x: 0, y: 0, distance: 20, direction: 0, width: 5, ...over };
}

describe('circle templates', () => {
  it('covers its own origin', () => {
    expect(templateCovers(template({}), { x: 0, y: 0 }, context)).toBe(true);
  });

  it('reaches exactly its radius in squares', () => {
    // A 20 ft radius is 4 squares at 5 ft per square.
    const fireball = template({ distance: 20 });
    expect(templateCovers(fireball, { x: 4, y: 0 }, context)).toBe(true);
    expect(templateCovers(fireball, { x: 4.5, y: 0 }, context)).toBe(false);
  });

  it('is round, not square', () => {
    const fireball = template({ distance: 20 });
    // The diagonal corner of the bounding box is outside the circle.
    expect(templateCovers(fireball, { x: 4, y: 4 }, context)).toBe(false);
  });

  it('scales with a different grid scale', () => {
    // At 10 ft per square, a 20 ft radius is only 2 squares.
    expect(templateCovers(template({ distance: 20 }), { x: 3, y: 0 }, { feetPerSquare: 10 })).toBe(false);
    expect(templateCovers(template({ distance: 20 }), { x: 2, y: 0 }, { feetPerSquare: 10 })).toBe(true);
  });
});

describe('cone templates', () => {
  const burningHands = template({ shape: 'cone', distance: 15, direction: 0 });

  it('covers straight ahead', () => {
    expect(templateCovers(burningHands, { x: 2, y: 0 }, context)).toBe(true);
  });

  it('does not reach behind the caster', () => {
    expect(templateCovers(burningHands, { x: -2, y: 0 }, context)).toBe(false);
  });

  it('spreads about as wide as it is long', () => {
    // The 5e cone is roughly 53 degrees total, so half-spread is ~26.5.
    expect(CONE_ANGLE_DEGREES).toBeGreaterThan(50);
    expect(CONE_ANGLE_DEGREES).toBeLessThan(56);

    // Inside both the spread and the length: 2.15 squares out, 21 degrees off.
    expect(templateCovers(burningHands, { x: 2, y: 0.8 }, context)).toBe(true);
    // Within the length but well outside the spread.
    expect(templateCovers(burningHands, { x: 1.5, y: 2 }, context)).toBe(false);
    // Inside the spread but beyond the 3-square length.
    expect(templateCovers(burningHands, { x: 3, y: 1 }, context)).toBe(false);
  });

  it('points where it is aimed', () => {
    const south = template({ shape: 'cone', distance: 15, direction: 90 });
    expect(templateCovers(south, { x: 0, y: 2 }, context)).toBe(true);
    expect(templateCovers(south, { x: 2, y: 0 }, context)).toBe(false);
  });

  it('stops at its length', () => {
    expect(templateCovers(burningHands, { x: 4, y: 0 }, context)).toBe(false);
  });
});

describe('ray templates', () => {
  const lightningBolt = template({ shape: 'ray', distance: 100, direction: 0, width: 5 });

  it('runs along its direction', () => {
    expect(templateCovers(lightningBolt, { x: 10, y: 0 }, context)).toBe(true);
    expect(templateCovers(lightningBolt, { x: 21, y: 0 }, context)).toBe(false);
  });

  it('is only as wide as its width', () => {
    // 5 ft wide is one square, so half a square either side of the axis.
    expect(templateCovers(lightningBolt, { x: 10, y: 0.4 }, context)).toBe(true);
    expect(templateCovers(lightningBolt, { x: 10, y: 1.2 }, context)).toBe(false);
  });

  it('does not extend backwards', () => {
    expect(templateCovers(lightningBolt, { x: -5, y: 0 }, context)).toBe(false);
  });
});

describe('coveredSquares', () => {
  it('returns the squares under a circle', () => {
    const squares = coveredSquares(template({ x: 5.5, y: 5.5, distance: 10 }), context);
    expect(squares.length).toBeGreaterThan(4);
    // Centre square is in.
    expect(squares.some(([x, y]) => x === 5 && y === 5)).toBe(true);
    // Far corner is not.
    expect(squares.some(([x, y]) => x === 20 && y === 20)).toBe(false);
  });

  it('stays inside the map bounds when given them', () => {
    const squares = coveredSquares(
      template({ x: 0, y: 0, distance: 50 }),
      context,
      { width: 5, height: 5 },
    );
    expect(squares.every(([x, y]) => x < 5 && y < 5)).toBe(true);
  });

  it('never returns negative coordinates', () => {
    const squares = coveredSquares(template({ x: 0, y: 0, distance: 30 }), context);
    expect(squares.every(([x, y]) => x >= 0 && y >= 0)).toBe(true);
  });
});

describe('tokensInTemplate', () => {
  const fireball = template({ x: 5, y: 5, distance: 20 });

  it('catches a token at the centre', () => {
    const caught = tokensInTemplate(fireball, [{ id: 'a', x: 5, y: 5, w: 1, h: 1 }], context);
    expect(caught.map((t) => t.id)).toEqual(['a']);
  });

  it('misses a token well outside', () => {
    const caught = tokensInTemplate(fireball, [{ id: 'a', x: 30, y: 30, w: 1, h: 1 }], context);
    expect(caught).toEqual([]);
  });

  it('catches a Gargantuan creature straddling the edge', () => {
    // Only part of the 4x4 dragon overlaps, which is enough - and matches what
    // a player sees when the outline clips the token.
    const dragon = { id: 'dragon', x: 7, y: 5, w: 4, h: 4 };
    expect(tokensInTemplate(fireball, [dragon], context).map((t) => t.id)).toEqual(['dragon']);
  });
});

describe('templateForSpell', () => {
  it('builds a circle from a sphere', () => {
    const built = templateForSpell({ shape: 'sphere', size: 20 }, { x: 3, y: 4 });
    expect(built).toMatchObject({ shape: 'circle', distance: 20, x: 3, y: 4 });
  });

  it('maps a line to a ray and a cube to a rect', () => {
    expect(templateForSpell({ shape: 'line', size: 100, width: 5 }, { x: 0, y: 0 })?.shape).toBe('ray');
    expect(templateForSpell({ shape: 'cube', size: 15 }, { x: 0, y: 0 })?.shape).toBe('rect');
  });

  it('returns null for a spell with no area', () => {
    expect(templateForSpell(null, { x: 0, y: 0 })).toBeNull();
    expect(templateForSpell({ shape: 'sphere', size: 0 }, { x: 0, y: 0 })).toBeNull();
  });
});

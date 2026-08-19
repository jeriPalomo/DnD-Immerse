import type { Point } from './grid.js';

/**
 * Area-of-effect template geometry.
 *
 * Everything works in grid units and returns the squares a template covers, so
 * "who is in the fireball?" is answered by the same maths that draws it — the
 * outline and the target list can never disagree.
 */

export type TemplateShape = 'circle' | 'cone' | 'ray' | 'rect';

export interface Template {
  shape: TemplateShape;
  /** Origin in grid units. For a cone or ray this is the point of origin. */
  x: number;
  y: number;
  /** Radius, length or edge — in FEET, as spells are written. */
  distance: number;
  /** Degrees clockwise from east. Cones and rays only. */
  direction: number;
  /** Ray width in feet. */
  width: number;
}

export interface TemplateContext {
  feetPerSquare: number;
}

const DEG_TO_RAD = Math.PI / 180;

/**
 * A 5e cone is as wide at its end as it is long, which works out to roughly
 * 53 degrees of total spread rather than the 60 people often assume.
 */
export const CONE_ANGLE_DEGREES = 53.13;

function toSquares(feet: number, feetPerSquare: number): number {
  return feet / feetPerSquare;
}

/** Shortest angle between two bearings, in degrees. */
function angleDelta(a: number, b: number): number {
  const raw = Math.abs(((a - b) % 360) + 360) % 360;
  return raw > 180 ? 360 - raw : raw;
}

/**
 * Whether a template covers a point.
 *
 * Square centres are tested rather than corners: a square with only a corner
 * clipped is not "in" the fireball at any table I have played at.
 */
export function templateCovers(template: Template, point: Point, context: TemplateContext): boolean {
  const reach = toSquares(template.distance, context.feetPerSquare);
  const dx = point.x - template.x;
  const dy = point.y - template.y;

  switch (template.shape) {
    case 'circle': {
      return Math.hypot(dx, dy) <= reach;
    }

    case 'cone': {
      const distance = Math.hypot(dx, dy);
      if (distance > reach || distance === 0) return distance === 0;

      const bearing = Math.atan2(dy, dx) / DEG_TO_RAD;
      return angleDelta(bearing, template.direction) <= CONE_ANGLE_DEGREES / 2;
    }

    case 'ray': {
      const halfWidth = toSquares(template.width || 5, context.feetPerSquare) / 2;
      const radians = template.direction * DEG_TO_RAD;

      // Project onto the ray's axis and its perpendicular.
      const along = dx * Math.cos(radians) + dy * Math.sin(radians);
      const across = -dx * Math.sin(radians) + dy * Math.cos(radians);

      return along >= 0 && along <= reach && Math.abs(across) <= halfWidth;
    }

    case 'rect': {
      // A cube or square, anchored at its origin corner.
      return dx >= 0 && dy >= 0 && dx <= reach && dy <= reach;
    }
  }
}

/**
 * Every grid square a template covers, for highlighting the board.
 *
 * Bounded by the template's own extent rather than the whole map, so a 20 ft
 * circle never walks a 100x100 grid.
 */
export function coveredSquares(
  template: Template,
  context: TemplateContext,
  bounds?: { width: number; height: number },
): [number, number][] {
  const reach = toSquares(template.distance, context.feetPerSquare);
  const pad = Math.ceil(reach) + 1;

  const minX = Math.max(0, Math.floor(template.x - pad));
  const maxX = Math.ceil(template.x + pad);
  const minY = Math.max(0, Math.floor(template.y - pad));
  const maxY = Math.ceil(template.y + pad);

  const squares: [number, number][] = [];

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (bounds && (x >= bounds.width || y >= bounds.height)) continue;
      if (templateCovers(template, { x: x + 0.5, y: y + 0.5 }, context)) squares.push([x, y]);
    }
  }

  return squares;
}

export interface TemplateTarget {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Tokens caught in a template.
 *
 * A creature is in the area if any square of its footprint is, so a Gargantuan
 * dragon straddling the edge of a fireball is caught by it — which is both the
 * rule and what a player expects when they can see the outline overlapping.
 */
export function tokensInTemplate<T extends TemplateTarget>(
  template: Template,
  tokens: T[],
  context: TemplateContext,
): T[] {
  return tokens.filter((token) => {
    // Sampled across the footprint the token actually has, not in whole squares
    // from its corner. A Tiny creature is half a square, so a fixed +0.5 tested
    // the corner OUTSIDE its own space - which flips the answer at the edge of a
    // fireball, and every Tiny monster in the bestiary is one.
    const width = token.w > 0 ? token.w : 1;
    const height = token.h > 0 ? token.h : 1;
    const columns = Math.max(1, Math.ceil(width));
    const rows = Math.max(1, Math.ceil(height));
    const stepX = width / columns;
    const stepY = height / rows;

    for (let dy = 0; dy < rows; dy++) {
      for (let dx = 0; dx < columns; dx++) {
        const centre = {
          x: token.x + dx * stepX + stepX / 2,
          y: token.y + dy * stepY + stepY / 2,
        };
        if (templateCovers(template, centre, context)) return true;
      }
    }
    return false;
  });
}

/**
 * Builds a template from a spell's own area description, so casting Fireball
 * offers a 20 ft circle without the DM configuring one.
 */
export function templateForSpell(
  area: { shape?: string; size?: number; width?: number | null } | null | undefined,
  origin: Point,
  direction = 0,
): Template | null {
  if (!area?.shape || !area.size) return null;

  const shape: TemplateShape =
    area.shape === 'cone'
      ? 'cone'
      : area.shape === 'line' || area.shape === 'ray'
        ? 'ray'
        : area.shape === 'cube' || area.shape === 'square' || area.shape === 'rect'
          ? 'rect'
          : 'circle';

  return {
    shape,
    x: origin.x,
    y: origin.y,
    distance: area.size,
    direction,
    width: area.width ?? 5,
  };
}

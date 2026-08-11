import { pointInAnyPolygon, type Polygon } from './grid.js';

/**
 * Persistent fog exploration, stored as one bit per grid square.
 *
 * Accumulating the polygons a player has seen grows without bound over a
 * campaign. A bitmap is fixed-size instead: a 100x100 scene is 10,000 bits -
 * about 1.25 KB - merges with a bitwise OR, and serialises to base64.
 *
 * This is what gives the three-state fog that makes a map feel explored:
 *   black   never seen
 *   dimmed  explored, but not currently in view (you remember the room's
 *           shape, not who is standing in it now)
 *   clear   currently visible
 *
 * Tokens are sent only for the clear region.
 */

export interface FogBitmap {
  width: number;
  height: number;
  bits: Uint8Array;
}

export function createFog(width: number, height: number): FogBitmap {
  const cells = Math.max(0, width * height);
  return { width, height, bits: new Uint8Array(Math.ceil(cells / 8)) };
}

function index(fog: FogBitmap, x: number, y: number): number | null {
  if (x < 0 || y < 0 || x >= fog.width || y >= fog.height) return null;
  return y * fog.width + x;
}

export function isExplored(fog: FogBitmap, x: number, y: number): boolean {
  const i = index(fog, x, y);
  if (i === null) return false;
  return (fog.bits[i >> 3] & (1 << (i & 7))) !== 0;
}

export function markExplored(fog: FogBitmap, x: number, y: number): void {
  const i = index(fog, x, y);
  if (i === null) return;
  fog.bits[i >> 3] |= 1 << (i & 7);
}

/**
 * Marks every grid square whose centre falls inside the visible region.
 *
 * Centre sampling rather than corner sampling: a square only half in view
 * would otherwise be recorded as explored, and a player would "remember"
 * geometry they never actually saw.
 */
export function markVisible(fog: FogBitmap, polygons: Polygon[]): number {
  if (polygons.length === 0) return 0;

  let marked = 0;
  for (let y = 0; y < fog.height; y++) {
    for (let x = 0; x < fog.width; x++) {
      if (isExplored(fog, x, y)) continue;
      if (pointInAnyPolygon({ x: x + 0.5, y: y + 0.5 }, polygons)) {
        markExplored(fog, x, y);
        marked++;
      }
    }
  }
  return marked;
}

export function encodeFog(fog: FogBitmap): string {
  // btoa is browser-only and Buffer is Node-only; this works in both.
  let binary = '';
  for (const byte of fog.bits) binary += String.fromCharCode(byte);
  return typeof btoa === 'function'
    ? btoa(binary)
    : Buffer.from(fog.bits).toString('base64');
}

export function decodeFog(encoded: string, width: number, height: number): FogBitmap {
  const fog = createFog(width, height);
  if (!encoded) return fog;

  try {
    if (typeof atob === 'function') {
      const binary = atob(encoded);
      for (let i = 0; i < Math.min(binary.length, fog.bits.length); i++) {
        fog.bits[i] = binary.charCodeAt(i);
      }
    } else {
      const buffer = Buffer.from(encoded, 'base64');
      fog.bits.set(buffer.subarray(0, fog.bits.length));
    }
  } catch {
    // A corrupt bitmap means re-exploring, which is far better than crashing.
    return createFog(width, height);
  }

  return fog;
}

/** Explored squares as [x, y] pairs, for the client to render the dim layer. */
export function exploredCells(fog: FogBitmap): [number, number][] {
  const cells: [number, number][] = [];
  for (let y = 0; y < fog.height; y++) {
    for (let x = 0; x < fog.width; x++) {
      if (isExplored(fog, x, y)) cells.push([x, y]);
    }
  }
  return cells;
}


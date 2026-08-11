/**
 * Generates an example battle map so the board can be exercised without
 * hunting for artwork: a stone chamber on a 70px grid with a corridor.
 *
 *   npx tsx src/lib/examplemap.ts <output.png>
 */
import fs from 'node:fs/promises';
import sharp from 'sharp';

const GRID = 70;
const COLS = 20;
const ROWS = 13;
const WIDTH = COLS * GRID;
const HEIGHT = ROWS * GRID;

function room(x: number, y: number, w: number, h: number, fill: string): string {
  return `<rect x="${x * GRID}" y="${y * GRID}" width="${w * GRID}" height="${h * GRID}" fill="${fill}" />`;
}

export function exampleMapSvg(): string {
  const flagstones: string[] = [];
  // Alternating tones so the floor reads as stone rather than flat colour.
  for (let cy = 0; cy < ROWS; cy++) {
    for (let cx = 0; cx < COLS; cx++) {
      const shade = (cx + cy) % 2 === 0 ? '#3a3630' : '#413c35';
      flagstones.push(
        `<rect x="${cx * GRID}" y="${cy * GRID}" width="${GRID}" height="${GRID}" fill="${shade}" />`,
      );
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="#14120f" />
  <g opacity="0.95">${flagstones.join('')}</g>

  <!-- Walls framing a chamber and a corridor east -->
  ${room(0, 0, COLS, 1, '#1d1a16')}
  ${room(0, ROWS - 1, COLS, 1, '#1d1a16')}
  ${room(0, 0, 1, ROWS, '#1d1a16')}
  ${room(COLS - 1, 0, 1, ROWS, '#1d1a16')}
  ${room(12, 1, 1, 5, '#1d1a16')}
  ${room(12, 8, 1, 4, '#1d1a16')}

  <!-- A dais at the far end -->
  <rect x="${14 * GRID}" y="${5 * GRID}" width="${4 * GRID}" height="${3 * GRID}"
        fill="#4a4137" stroke="#6b5d4a" stroke-width="3" />

  <!-- Braziers -->
  <circle cx="${3 * GRID}" cy="${3 * GRID}" r="16" fill="#d9691f" opacity="0.75" />
  <circle cx="${3 * GRID}" cy="${10 * GRID}" r="16" fill="#d9691f" opacity="0.75" />

  <text x="${GRID / 2}" y="${HEIGHT - GRID / 3}" font-family="serif" font-size="18" fill="#6b5d4a">
    Example map — 70px squares
  </text>
</svg>`;
}

export async function writeExampleMap(target: string): Promise<void> {
  const png = await sharp(Buffer.from(exampleMapSvg())).png().toBuffer();
  await fs.writeFile(target, png);
}

if (process.argv[1]?.includes('examplemap')) {
  const target = process.argv[2] ?? 'example-map.png';
  await writeExampleMap(target);
  console.log(`wrote ${target} (${WIDTH}x${HEIGHT}, ${GRID}px grid)`);
  process.exit(0);
}

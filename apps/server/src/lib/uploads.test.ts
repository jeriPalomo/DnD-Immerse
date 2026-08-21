import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * What happens when somebody picks the wrong file.
 *
 * `storeImage` had a guard for an unreadable image and it could not be reached:
 * sharp *throws* on a text file rather than handing back metadata with no
 * dimensions, so the guard on the next line never ran and the exception escaped
 * as a 500. The person who picked the wrong file was told "Something went
 * wrong", which is the least useful true sentence available.
 */
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dnd-uploads-'));
process.env.DATA_DIR = DATA_DIR;
process.env.NODE_ENV = 'test';

let storeImage: typeof import('./uploads.js').storeImage;
let HttpError: typeof import('../auth/guards.js').HttpError;

/** A one-pixel PNG - the smallest thing that is genuinely an image. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

beforeAll(async () => {
  const { ensureDataDirs } = await import('../env.js');
  ensureDataDirs();
  ({ storeImage } = await import('./uploads.js'));
  ({ HttpError } = await import('../auth/guards.js'));
});

afterAll(() => {
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {
    // Not worth failing a passing suite over.
  }
});

describe('storing an upload', () => {
  it('accepts an actual image and reports its size', async () => {
    const stored = await storeImage(PIXEL, 'avatars');
    expect(stored.url).toMatch(/^\/uploads\/avatars\//);
    expect(stored.width).toBe(1);
    expect(stored.height).toBe(1);
  });

  it('refuses a file that is not an image, and says so', async () => {
    const notAnImage = Buffer.from('Dear diary, today I was not a PNG.');

    await expect(storeImage(notAnImage, 'avatars')).rejects.toBeInstanceOf(HttpError);
    await expect(storeImage(notAnImage, 'avatars')).rejects.toMatchObject({ status: 400 });
  });

  it('refuses an empty file the same way', async () => {
    await expect(storeImage(Buffer.alloc(0), 'avatars')).rejects.toMatchObject({ status: 400 });
  });

  it('refuses something far too large before trying to decode it', async () => {
    // 30MB of nothing. The size check comes first deliberately: decoding a
    // enormous buffer to find out it is too big is the expensive way round.
    const huge = Buffer.alloc(30 * 1024 * 1024);
    await expect(storeImage(huge, 'avatars')).rejects.toMatchObject({ status: 413 });
  });
});

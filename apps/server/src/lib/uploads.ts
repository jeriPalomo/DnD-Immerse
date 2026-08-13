import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { newId } from './id.js';
import { paths } from '../env.js';
import { HttpError } from '../auth/guards.js';

export type UploadKind = 'maps' | 'tokens' | 'avatars' | 'handouts';

/** Maps are large; portraits and tokens are not. Sizes in bytes. */
const MAX_BYTES: Record<UploadKind, number> = {
  maps: 25 * 1024 * 1024,
  tokens: 4 * 1024 * 1024,
  avatars: 4 * 1024 * 1024,
  handouts: 20 * 1024 * 1024,
};

export interface StoredImage {
  url: string;
  width: number;
  height: number;
}

/**
 * Re-encodes every uploaded image through sharp rather than storing the bytes
 * as received. That strips EXIF (which can carry GPS coordinates from a phone
 * photo) and makes polyglot files - a valid image that is also a valid script -
 * impossible, because the output is generated from decoded pixels.
 *
 * Filenames are always generated; a user-supplied name is never used as a path.
 */
export async function storeImage(
  buffer: Buffer,
  kind: UploadKind,
  options: { maxDimension?: number } = {},
): Promise<StoredImage> {
  if (buffer.byteLength > MAX_BYTES[kind]) {
    throw new HttpError(413, `File too large (max ${Math.round(MAX_BYTES[kind] / 1024 / 1024)}MB)`);
  }

  let pipeline = sharp(buffer, { limitInputPixels: 400_000_000 }).rotate();

  const meta = await pipeline.metadata();
  if (!meta.width || !meta.height) throw new HttpError(400, 'Not a readable image');

  const limit = options.maxDimension;
  if (limit && (meta.width > limit || meta.height > limit)) {
    pipeline = pipeline.resize(limit, limit, { fit: 'inside', withoutEnlargement: true });
  }

  // WebP keeps large battle maps small without visible loss.
  const output = await pipeline.webp({ quality: 88 }).toBuffer({ resolveWithObject: true });

  const filename = `${newId()}.webp`;
  await fs.writeFile(path.join(paths.uploads, kind, filename), output.data);

  return {
    url: `/uploads/${kind}/${filename}`,
    width: output.info.width,
    height: output.info.height,
  };
}

/** Deletes a previously stored upload, ignoring anything already gone. */
export async function deleteUpload(url: string | null | undefined): Promise<void> {
  if (!url?.startsWith('/uploads/')) return;

  const relative = url.slice('/uploads/'.length);
  // Refuse anything that could escape the uploads directory.
  const target = path.resolve(paths.uploads, relative);
  if (!target.startsWith(path.resolve(paths.uploads))) return;

  await fs.rm(target, { force: true });
}

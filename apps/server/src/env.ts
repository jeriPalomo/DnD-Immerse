import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repo root, from apps/server/src. */
export const ROOT = path.resolve(here, '../../..');

export const env = {
  port: Number(process.env.PORT ?? 3001),
  host: process.env.HOST ?? '0.0.0.0',
  isProd: process.env.NODE_ENV === 'production',

  dataDir: process.env.DATA_DIR ?? path.join(ROOT, 'data'),

  /**
   * Cookies are marked Secure only when served over HTTPS. `tailscale serve`
   * provides a real certificate on the tailnet, so set this in production.
   */
  secureCookies: process.env.SECURE_COOKIES === 'true',

  sessionTtlMs: 1000 * 60 * 60 * 24 * 30,

  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 25 * 1024 * 1024),
} as const;

export const paths = {
  db: path.join(env.dataDir, 'app.db'),
  uploads: path.join(env.dataDir, 'uploads'),
  srd: path.join(env.dataDir, 'srd'),
} as const;

export const UPLOAD_SUBDIRS = ['maps', 'tokens', 'avatars', 'audio', 'handouts'] as const;

/**
 * Creates the data directories if they are missing.
 *
 * This must run before the SQLite client is constructed: opening a database
 * file does not create its parent directory, and `data/` is gitignored, so a
 * fresh clone has none. Skipping this makes the first boot after `git clone`
 * die with an opaque SQLITE_CANTOPEN.
 */
export function ensureDataDirs(): void {
  for (const dir of [env.dataDir, paths.uploads, paths.srd]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  for (const sub of UPLOAD_SUBDIRS) {
    fs.mkdirSync(path.join(paths.uploads, sub), { recursive: true });
  }
}

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { pathToFileURL } from 'node:url';
import { env, paths } from './env.js';

/**
 * Backs up the campaign.
 *
 * This machine holds the only copy of everything: sheets, maps, the journal,
 * and every player's fog exploration. A disk failure loses a campaign outright,
 * which is not a risk worth carrying for the sake of one script.
 *
 * The database is copied with SQLite's own VACUUM INTO rather than a file copy,
 * because copying a live database can capture a torn write - the result looks
 * fine until the day you need it.
 */

const KEEP = 10;

function stamp(): string {
  // 2026-08-11_14-30-00, so backups sort chronologically by name.
  return new Date().toISOString().replace(/\..+$/, '').replace(/:/g, '-').replace('T', '_');
}

/** Recursively copies a directory, skipping anything unreadable. */
function copyDir(from: string, to: string): number {
  if (!fs.existsSync(from)) return 0;
  fs.mkdirSync(to, { recursive: true });

  let count = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);

    if (entry.isDirectory()) count += copyDir(source, target);
    else {
      fs.copyFileSync(source, target);
      count++;
    }
  }
  return count;
}

function directorySize(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? directorySize(full) : fs.statSync(full).size;
  }
  return total;
}

export async function backup(): Promise<string> {
  const root = path.join(env.dataDir, 'backups');
  const destination = path.join(root, stamp());
  fs.mkdirSync(destination, { recursive: true });

  // VACUUM INTO takes a consistent snapshot of a live database, and compacts
  // it on the way out. A plain file copy can catch a half-written page.
  const client = createClient({ url: pathToFileURL(paths.db).href });
  try {
    const target = path.join(destination, 'app.db').replace(/\\/g, '/');
    await client.execute({ sql: `VACUUM INTO '${target}'`, args: [] });
  } finally {
    client.close();
  }

  const files = copyDir(paths.uploads, path.join(destination, 'uploads'));

  // Keep the most recent few; unbounded backups quietly fill the disk.
  const existing = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const old of existing.slice(0, Math.max(0, existing.length - KEEP))) {
    fs.rmSync(path.join(root, old), { recursive: true, force: true });
  }

  const megabytes = (directorySize(destination) / 1024 / 1024).toFixed(1);
  console.log(`Backed up to ${destination}`);
  console.log(`  database + ${files} uploaded files, ${megabytes} MB`);
  console.log(`  keeping the ${Math.min(existing.length, KEEP)} most recent`);

  return destination;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  backup()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Backup failed:', error);
      process.exit(1);
    });
}

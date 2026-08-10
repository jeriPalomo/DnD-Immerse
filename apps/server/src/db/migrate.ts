import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { db } from './index.js';
import { env, paths } from '../env.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export async function runMigrations(): Promise<void> {
  for (const dir of [env.dataDir, paths.uploads, paths.srd]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  for (const sub of ['maps', 'tokens', 'avatars', 'audio', 'handouts']) {
    fs.mkdirSync(path.join(paths.uploads, sub), { recursive: true });
  }

  await migrate(db, { migrationsFolder: path.resolve(here, '../../drizzle') });
}

// Allow running directly: npm run db:migrate
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runMigrations()
    .then(() => {
      console.log('migrations applied');
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { db } from './index.js';
import { ensureDataDirs } from '../env.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export async function runMigrations(): Promise<void> {
  ensureDataDirs();

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

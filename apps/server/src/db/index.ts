import { pathToFileURL } from 'node:url';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { ensureDataDirs, paths } from '../env.js';
import * as schema from './schema.js';

/**
 * libsql rather than better-sqlite3: the latter has no prebuilt binary for
 * Node 24 and would require a node-gyp toolchain. libsql is SQLite-compatible
 * and ships prebuilt Windows binaries.
 */
// Opening the database does not create missing parent directories, and this
// module runs at import time - before any migration code.
ensureDataDirs();

// pathToFileURL handles Windows drive letters and separators correctly,
// which hand-rolled `file:` string building does not.
const client = createClient({ url: pathToFileURL(paths.db).href });

export const db = drizzle(client, { schema, casing: 'snake_case' });
export { client, schema };

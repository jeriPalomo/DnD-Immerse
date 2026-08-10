import { pathToFileURL } from 'node:url';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { paths } from '../env.js';
import * as schema from './schema.js';

/**
 * libsql rather than better-sqlite3: the latter has no prebuilt binary for
 * Node 24 and would require a node-gyp toolchain. libsql is SQLite-compatible
 * and ships prebuilt Windows binaries.
 */
// pathToFileURL handles Windows drive letters and separators correctly,
// which hand-rolled `file:` string building does not.
const client = createClient({ url: pathToFileURL(paths.db).href });

export const db = drizzle(client, { schema, casing: 'snake_case' });
export { client, schema };

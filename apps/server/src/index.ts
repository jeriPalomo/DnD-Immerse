import { buildApp } from './app.js';
import { runMigrations } from './db/migrate.js';
import { purgeExpiredSessions } from './auth/session.js';
import { env } from './env.js';

async function main() {
  await runMigrations();
  await purgeExpiredSessions();

  const app = await buildApp();
  await app.listen({ port: env.port, host: env.host });

  app.log.info(`DnD Immerse listening on http://${env.host}:${env.port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

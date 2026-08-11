import { buildApp } from './app.js';
import { attachRealtime } from './realtime/index.js';
import { runMigrations } from './db/migrate.js';
import { purgeExpiredSessions } from './auth/session.js';
import { env } from './env.js';

async function main() {
  await runMigrations();
  await purgeExpiredSessions();

  const app = await buildApp();
  // Socket.IO binds to the same HTTP server, so one process serves REST,
  // WebSockets and the built client.
  attachRealtime(app);
  await app.listen({ port: env.port, host: env.host });

  app.log.info(`DnD Immerse listening on http://${env.host}:${env.port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

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

/**
 * A rejection nobody caught should not end the session.
 *
 * Node's default is to exit, which for a game server means everyone at the
 * table is dropped mid-encounter over one bad request. Handlers are wrapped
 * individually in `realtime/index.ts`; this is the net under that, and it logs
 * loudly rather than swallowing quietly - a server that stays up while hiding
 * its own bugs is its own kind of problem.
 */
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection - staying up, but this is a bug:', reason);
});

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import { buildApp } from './app.js';
import { attachRealtime } from './realtime/index.js';
import { runMigrations } from './db/migrate.js';
import { purgeExpiredSessions } from './auth/session.js';
import { env } from './env.js';

/**
 * Things that are fine in development and wrong in production.
 *
 * Said at boot rather than left to be discovered: a cookie that is not marked
 * Secure behind HTTPS is the kind of thing nobody notices until it matters, and
 * the fix is one environment variable.
 *
 * Deliberately a warning and not a default. `Secure` is a *restriction* - the
 * browser then refuses to send the cookie over plain HTTP - so turning it on
 * for a table reached at `http://100.x.y.z:3001` would break every login.
 * Which of the two is right depends on how this is served, and only the person
 * serving it knows.
 */
function warnAboutConfig(log: { warn: (message: string) => void }): void {
  if (!env.isProd) return;

  if (!env.secureCookies) {
    log.warn(
      'SECURE_COOKIES is not set. Set it to "true" if this is reached over HTTPS ' +
        '(tailscale serve, or a reverse proxy) so session cookies are marked Secure. ' +
        'Leave it unset if people connect over plain http:// — Secure cookies are ' +
        'not sent over http at all, and login would stop working.',
    );
  }
}

async function main() {
  await runMigrations();
  await purgeExpiredSessions();

  const app = await buildApp();
  // Socket.IO binds to the same HTTP server, so one process serves REST,
  // WebSockets and the built client.
  attachRealtime(app);
  await app.listen({ port: env.port, host: env.host });

  app.log.info(`DnD Immerse listening on http://${env.host}:${env.port}`);
  warnAboutConfig(app.log);

  /**
   * Shut down without tearing anything.
   *
   * `app.close()` stops accepting connections and lets what is in flight
   * finish, which matters because the last thing a request does is often a
   * write. Killed outright mid-write, SQLite is fine - it is crash-safe - but
   * the client that was talking to it is not, and neither is a half-sent
   * broadcast. The supervisor sends SIGTERM and waits for this.
   */
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (closing) return;
      closing = true;
      app.log.info(`${signal} received, closing`);
      void app
        .close()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    });
  }
}

/**
 * A rejection nobody caught should not end the session.
 *
 * Node's default is to exit, which for a game server means everyone at the
 * table is dropped mid-encounter over one bad request. Handlers are wrapped
 * individually in `realtime/index.ts`; this is the net under that, and it logs
 * loudly rather than swallowing quietly - a server that stays up while hiding
 * its own bugs is its own kind of problem.
 *
 * There is deliberately no `uncaughtException` twin. A rejection is usually one
 * request going wrong; a synchronous throw that reaches the top is the process
 * in a state nobody reasoned about, and carrying on from there is how a table
 * ends up with quietly wrong data. `npm run serve` restarts it in a couple of
 * seconds and every client reconnects on its own, which is the cleaner answer.
 */
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection - staying up, but this is a bug:', reason);
});

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

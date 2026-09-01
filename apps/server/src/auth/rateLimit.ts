import { HttpError } from './guards.js';
import type { FastifyRequest } from 'fastify';

/**
 * A cap on how often one address may try to sign in.
 *
 * Mostly the ordinary reason - guessing at a password should not be free - on
 * the two routes that are reachable without one.
 *
 * The tempting second reason turned out to be half true and is worth writing
 * down so nobody re-derives it wrongly. `argon2id` here spends **19 MiB per
 * attempt**, which reads like a lever: hold enough logins open and the machine
 * runs out of memory. Measured, it is not - 64 concurrent hashes cost 134 MiB,
 * not 64 x 19, because the hashing is async and runs on a bounded thread pool
 * rather than all at once.
 *
 * What that same pool *does* serve is file I/O, and this process reads uploads
 * and the client bundle off disk. So a flood of logins is better thought of as
 * saturating the pool than as exhausting RAM: the plausible damage is the
 * table going unresponsive, not the process dying.
 *
 * In memory, and a plain Map, because this is one process serving one group.
 * A shared store would answer a question this deployment does not have, and
 * losing the counters on restart only means one more burst after a restart
 * nobody asked for.
 */

interface Bucket {
  hits: number;
  /** When this window opened. */
  since: number;
}

const buckets = new Map<string, Bucket>();

/**
 * Sized so a five-person table never meets it and a script does quickly.
 *
 * Thirty rather than ten because everything here shares one address in the
 * suites - `npm run runthrough` alone registers three accounts and logs in
 * six times against 127.0.0.1 in a few seconds - and a limit that fails the
 * tests would be turned off rather than tuned. Thirty a minute is still two
 * orders of magnitude below anything worth calling an attack.
 */
export const LOGIN_WINDOW_MS = 60_000;
export const LOGIN_MAX_ATTEMPTS = 30;

/**
 * Buckets are dropped as they are read rather than on a timer.
 *
 * A `setInterval` here would keep the process alive on shutdown and would be
 * one more thing to reason about at boot; this map only grows with distinct
 * addresses that have tried to log in within the last minute.
 */
function sweep(now: number): void {
  if (buckets.size < 1000) return;
  for (const [key, bucket] of buckets) {
    if (now - bucket.since >= LOGIN_WINDOW_MS) buckets.delete(key);
  }
}

/**
 * Counts one attempt, and throws once the window is full.
 *
 * Keyed on `request.ip`. Behind `tailscale serve` or a reverse proxy that is
 * the proxy's address unless Fastify is configured to trust it - which for a
 * table on a tailnet is the safe direction to be wrong in: it throttles
 * everybody together rather than nobody at all.
 */
export function rateLimitLogin(request: FastifyRequest): void {
  const now = Date.now();
  sweep(now);

  const key = request.ip ?? 'unknown';
  const bucket = buckets.get(key);

  if (!bucket || now - bucket.since >= LOGIN_WINDOW_MS) {
    buckets.set(key, { hits: 1, since: now });
    return;
  }

  bucket.hits += 1;
  if (bucket.hits > LOGIN_MAX_ATTEMPTS) {
    const seconds = Math.ceil((LOGIN_WINDOW_MS - (now - bucket.since)) / 1000);
    // 429 rather than 401: this is not a wrong password, and saying so avoids
    // somebody retyping a password that was right.
    throw new HttpError(429, `Too many attempts. Try again in ${seconds}s.`);
  }
}

/** Exposed for tests, which must not inherit another test's window. */
export function resetRateLimits(): void {
  buckets.clear();
}

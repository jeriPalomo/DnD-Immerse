import { createHash, randomBytes } from 'node:crypto';
import { eq, lt } from 'drizzle-orm';
import { db } from '../db/index.js';
import { sessions, users } from '../db/schema.js';
import { env } from '../env.js';
import type { User } from '../db/schema.js';

export const SESSION_COOKIE = 'dnd_session';

/**
 * The cookie carries a random token; the database stores only its SHA-256.
 * A leaked database backup therefore cannot be used to impersonate anyone.
 */
function tokenToId(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db.insert(sessions).values({
    id: tokenToId(token),
    userId,
    expiresAt: Date.now() + env.sessionTtlMs,
  });
  return token;
}

export async function validateSession(token: string | undefined): Promise<User | null> {
  if (!token) return null;

  const rows = await db
    .select({ user: users, expiresAt: sessions.expiresAt })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.id, tokenToId(token)))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  if (row.expiresAt < Date.now()) {
    await db.delete(sessions).where(eq(sessions.id, tokenToId(token)));
    return null;
  }

  return row.user;
}

export async function destroySession(token: string | undefined): Promise<void> {
  if (!token) return;
  await db.delete(sessions).where(eq(sessions.id, tokenToId(token)));
}

export async function purgeExpiredSessions(): Promise<void> {
  await db.delete(sessions).where(lt(sessions.expiresAt, Date.now()));
}

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: env.secureCookies,
  path: '/',
  maxAge: Math.floor(env.sessionTtlMs / 1000),
} as const;

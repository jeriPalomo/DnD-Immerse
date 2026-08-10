import { eq } from 'drizzle-orm';
import { loginSchema, registerSchema } from '@dnd/shared';
import type { FastifyInstance } from 'fastify';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import {
  SESSION_COOKIE,
  createSession,
  destroySession,
  sessionCookieOptions,
} from '../auth/session.js';
import { HttpError, assertUser, requireAuth } from '../auth/guards.js';
import { newId } from '../lib/id.js';
import { storeImage } from '../lib/uploads.js';
import type { User } from '../db/schema.js';

function publicUser(user: User) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
  };
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/auth/register', async (request, reply) => {
    const input = registerSchema.parse(request.body);
    const email = input.email.toLowerCase().trim();

    const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (existing.length > 0) {
      throw new HttpError(409, 'An account with that email already exists');
    }

    const user: User = {
      id: newId(),
      email,
      displayName: input.displayName,
      passwordHash: await hashPassword(input.password),
      avatarUrl: null,
      createdAt: Date.now(),
    };
    await db.insert(users).values(user);

    const token = await createSession(user.id);
    reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions);
    return { user: publicUser(user) };
  });

  app.post('/api/auth/login', async (request, reply) => {
    const input = loginSchema.parse(request.body);
    const email = input.email.toLowerCase().trim();

    const rows = await db.select().from(users).where(eq(users.email, email)).limit(1);
    const user = rows[0];

    // Verify even when the user is missing, so response timing does not reveal
    // which emails have accounts.
    const digest = user?.passwordHash ?? '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const ok = await verifyPassword(digest, input.password);

    if (!user || !ok) throw new HttpError(401, 'Incorrect email or password');

    const token = await createSession(user.id);
    reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions);
    return { user: publicUser(user) };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    await destroySession(request.cookies?.[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (request) => {
    return { user: request.user ? publicUser(request.user) : null };
  });

  app.patch('/api/auth/me', { preHandler: requireAuth }, async (request) => {
    const user = assertUser(request);
    const body = (request.body ?? {}) as { displayName?: unknown };

    const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : undefined;
    if (displayName !== undefined && (displayName.length < 2 || displayName.length > 40)) {
      throw new HttpError(400, 'Display name must be 2-40 characters');
    }

    if (displayName) {
      await db.update(users).set({ displayName }).where(eq(users.id, user.id));
    }

    const rows = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
    return { user: publicUser(rows[0]) };
  });

  app.post('/api/auth/me/avatar', { preHandler: requireAuth }, async (request) => {
    const user = assertUser(request);
    const file = await request.file();
    if (!file) throw new HttpError(400, 'No file uploaded');

    const stored = await storeImage(await file.toBuffer(), 'avatars', { maxDimension: 512 });
    await db.update(users).set({ avatarUrl: stored.url }).where(eq(users.id, user.id));

    return { avatarUrl: stored.url };
  });
}

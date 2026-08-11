import { Server } from 'socket.io';
import { campaignDmRoom, campaignRoom, userRoom } from '@dnd/shared';
import type { FastifyInstance } from 'fastify';
import type { ClientToServerEvents, ServerToClientEvents, WirePresence } from '@dnd/shared';
import { SESSION_COOKIE, validateSession } from '../auth/session.js';
import { getMembership } from '../auth/guards.js';
import { registerChatHandlers } from './chat.js';
import type { MemberRole } from '@dnd/shared';
import type { User } from '../db/schema.js';

export interface SocketData {
  user: User;
  /** Campaigns this socket has joined, with the role it holds in each. */
  rooms: Map<string, MemberRole>;
}

export type IOServer = Server<ClientToServerEvents, ServerToClientEvents, object, SocketData>;

/**
 * Who is currently connected, per campaign. Counted rather than flagged,
 * because one person with two tabs open should not go offline when they close
 * only one of them.
 */
const presence = new Map<string, Map<string, number>>();

function addPresence(campaignId: string, userId: string): void {
  const campaign = presence.get(campaignId) ?? new Map<string, number>();
  campaign.set(userId, (campaign.get(userId) ?? 0) + 1);
  presence.set(campaignId, campaign);
}

function removePresence(campaignId: string, userId: string): void {
  const campaign = presence.get(campaignId);
  if (!campaign) return;

  const next = (campaign.get(userId) ?? 1) - 1;
  if (next <= 0) campaign.delete(userId);
  else campaign.set(userId, next);

  if (campaign.size === 0) presence.delete(campaignId);
}

export function onlineUserIds(campaignId: string): Set<string> {
  return new Set(presence.get(campaignId)?.keys() ?? []);
}

/** Reads the session cookie off the WebSocket handshake. */
function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

export async function broadcastPresence(io: IOServer, campaignId: string): Promise<void> {
  const { db } = await import('../db/index.js');
  const { campaignMembers, users } = await import('../db/schema.js');
  const { eq } = await import('drizzle-orm');

  const rows = await db
    .select({
      id: users.id,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      role: campaignMembers.role,
    })
    .from(campaignMembers)
    .innerJoin(users, eq(campaignMembers.userId, users.id))
    .where(eq(campaignMembers.campaignId, campaignId));

  const online = onlineUserIds(campaignId);

  const members: WirePresence[] = rows.map((row) => ({
    user: { id: row.id, displayName: row.displayName, avatarUrl: row.avatarUrl },
    role: row.role,
    online: online.has(row.id),
  }));

  io.to(campaignRoom(campaignId)).emit('presence', { members });
}

export function attachRealtime(app: FastifyInstance): IOServer {
  const io: IOServer = new Server(app.server, {
    path: '/socket.io',
    serveClient: false,
    // Same-origin only; the client is served by this process or proxied to it.
    cors: { origin: false },
  });

  // Authenticate once at connection rather than per event.
  io.use(async (socket, next) => {
    try {
      const token = cookieValue(socket.handshake.headers.cookie, SESSION_COOKIE);
      const user = await validateSession(token);
      if (!user) return next(new Error('Not signed in'));

      socket.data.user = user;
      socket.data.rooms = new Map();
      next();
    } catch (err) {
      next(err as Error);
    }
  });

  io.on('connection', (socket) => {
    const user = socket.data.user;

    // Personal room, so whispers can be delivered across all of a user's tabs.
    void socket.join(userRoom(user.id));

    socket.on('campaign:join', async ({ campaignId }) => {
      // Membership is re-checked here rather than trusted from the client.
      const membership = await getMembership(campaignId, user.id);
      if (!membership) {
        socket.emit('error', { message: 'You are not in that campaign', code: 'NOT_A_MEMBER' });
        return;
      }

      await socket.join(campaignRoom(campaignId));
      // The DM room is what makes secrecy structural: players are never joined
      // to it, so DM-only payloads cannot reach them by accident.
      if (membership.isDM) await socket.join(campaignDmRoom(campaignId));

      socket.data.rooms.set(campaignId, membership.role);
      addPresence(campaignId, user.id);

      await broadcastPresence(io, campaignId);
    });

    socket.on('campaign:leave', async ({ campaignId }) => {
      if (!socket.data.rooms.has(campaignId)) return;

      await socket.leave(campaignRoom(campaignId));
      await socket.leave(campaignDmRoom(campaignId));
      socket.data.rooms.delete(campaignId);
      removePresence(campaignId, user.id);

      await broadcastPresence(io, campaignId);
    });

    registerChatHandlers(io, socket);

    socket.on('disconnect', async () => {
      for (const campaignId of socket.data.rooms.keys()) {
        removePresence(campaignId, user.id);
        await broadcastPresence(io, campaignId);
      }
      socket.data.rooms.clear();
    });
  });

  return io;
}

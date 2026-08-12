import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import type { WireChatMessage, WirePresence } from '@dnd/shared';

/**
 * End-to-end realtime tests against a real HTTP + Socket.IO server on a
 * throwaway database.
 *
 * The three tests that matter most are the leak tests: a private message
 * reaching the wrong socket is not a bug anyone notices until a campaign has
 * already been spoiled.
 */

// env.ts reads process.env at import time, so this must be set before any
// application module is loaded.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dnd-test-'));
process.env.DATA_DIR = DATA_DIR;
process.env.NODE_ENV = 'test';

let baseUrl: string;
let close: () => Promise<void>;

interface Account {
  cookie: string;
  userId: string;
}

async function api<T>(method: string, route: string, body?: unknown, cookie?: string): Promise<T> {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = (await response.json()) as { error?: string };
  if (!response.ok) throw new Error(payload.error ?? 'request failed');
  return payload as T;
}

async function register(email: string, name: string): Promise<Account> {
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, displayName: name, password: 'password12345' }),
  });
  const payload = (await response.json()) as { error?: string; user: { id: string } };
  if (!response.ok) throw new Error(payload.error);

  const setCookie = response.headers.get('set-cookie') ?? '';
  return { cookie: setCookie.split(';')[0], userId: payload.user.id };
}

function open(account: Account): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(baseUrl, {
      extraHeaders: { cookie: account.cookie },
      transports: ['websocket'],
      forceNew: true,
    });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
  });
}

/** Waits for one event, or resolves null if it never arrives. */
function next<T>(socket: Socket, event: string, timeoutMs = 1200): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      resolve(null);
    }, timeoutMs);
    const handler = (payload: T) => {
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
}

/** Collects every matching event for a window, to prove absence as well as presence. */
function collect<T>(socket: Socket, event: string, ms = 700): Promise<T[]> {
  const seen: T[] = [];
  const handler = (payload: T) => seen.push(payload);
  socket.on(event, handler);
  return new Promise((resolve) =>
    setTimeout(() => {
      socket.off(event, handler);
      resolve(seen);
    }, ms),
  );
}

let dm: Account;
let alice: Account;
let bob: Account;
let outsider: Account;
let campaignId: string;
let dmSocket: Socket;
let aliceSocket: Socket;
let bobSocket: Socket;

beforeAll(async () => {
  const { buildApp } = await import('../app.js');
  const { runMigrations } = await import('../db/migrate.js');
  const { attachRealtime } = await import('./index.js');

  await runMigrations();
  const app = await buildApp();
  attachRealtime(app);
  await app.listen({ port: 0, host: '127.0.0.1' });

  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
  close = async () => {
    await app.close();
  };

  dm = await register('dm@test.local', 'Dungeon Master');
  alice = await register('alice@test.local', 'Alice');
  bob = await register('bob@test.local', 'Bob');
  outsider = await register('outsider@test.local', 'Outsider');

  const created = await api<{ campaign: { id: string; inviteCode: string } }>(
    'POST', '/api/campaigns', { name: 'Test Table' }, dm.cookie,
  );
  campaignId = created.campaign.id;

  for (const player of [alice, bob]) {
    await api('POST', '/api/campaigns/join', { inviteCode: created.campaign.inviteCode }, player.cookie);
  }

  [dmSocket, aliceSocket, bobSocket] = await Promise.all([open(dm), open(alice), open(bob)]);
  for (const socket of [dmSocket, aliceSocket, bobSocket]) socket.emit('campaign:join', { campaignId });
  await new Promise((r) => setTimeout(r, 600));
}, 60000);

afterAll(async () => {
  for (const socket of [dmSocket, aliceSocket, bobSocket]) socket?.close();

  // Disconnect handlers broadcast presence, which queries the database. Let
  // those finish before the connection is torn out from under them.
  await new Promise((r) => setTimeout(r, 300));
  await close?.();

  // Windows keeps the file locked until the SQLite handle is released, so the
  // client must close before the directory can be removed.
  const { client } = await import('../db/index.js');
  client.close();

  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {
    // A leftover temp directory is not worth failing a passing suite over.
  }
});

describe('connection', () => {
  it('refuses a socket with no session', async () => {
    await expect(open({ cookie: '', userId: '' })).rejects.toThrow();
  });

  it('reports presence to the campaign', async () => {
    const presence = await next<{ members: WirePresence[] }>(dmSocket, 'presence', 2000).catch(() => null);
    // Presence is broadcast on join; if the window missed it, re-trigger.
    if (!presence) dmSocket.emit('campaign:join', { campaignId });
    const members = presence?.members ?? (await next<{ members: WirePresence[] }>(dmSocket, 'presence', 2000))?.members;

    expect(members?.length).toBe(3);
    expect(members?.find((m) => m.role === 'dm')?.online).toBe(true);
  });
});

describe('public chat', () => {
  it('delivers a message to everyone at the table', async () => {
    const waiting = Promise.all([
      next<{ message: WireChatMessage }>(aliceSocket, 'chat:message'),
      next<{ message: WireChatMessage }>(bobSocket, 'chat:message'),
      next<{ message: WireChatMessage }>(dmSocket, 'chat:message'),
    ]);

    aliceSocket.emit('chat:send', { body: 'I search the chest.', whisperToUserId: null, actorId: null });
    const received = await waiting;

    for (const payload of received) {
      expect(payload?.message.body).toBe('I search the chest.');
      expect(payload?.message.authorName).toBe('Alice');
    }
  });
});

describe('whispers stay private', () => {
  it('reaches only the sender and the target, never a third player', async () => {
    const bobsMessages = collect<{ message: WireChatMessage }>(bobSocket, 'chat:message');
    const dmsMessages = collect<{ message: WireChatMessage }>(dmSocket, 'chat:message');
    const aliceSees = next<{ message: WireChatMessage }>(aliceSocket, 'chat:message');

    aliceSocket.emit('chat:send', {
      body: 'psst - I pocket the ring',
      whisperToUserId: dm.userId,
      actorId: null,
    });

    const [bobSaw, dmSaw, aliceSaw] = await Promise.all([bobsMessages, dmsMessages, aliceSees]);

    expect(aliceSaw?.message.body).toContain('pocket the ring');
    expect(dmSaw.some((m) => m.message.body.includes('pocket the ring'))).toBe(true);
    // The leak test.
    expect(bobSaw.some((m) => m.message.body.includes('pocket the ring'))).toBe(false);
  });
});

describe('dice are server-authoritative', () => {
  it('ignores any total the client tries to supply', async () => {
    const waiting = next<{ message: WireChatMessage }>(dmSocket, 'chat:message');

    aliceSocket.emit('chat:roll', {
      expression: '1d20',
      label: 'Perception',
      actorId: null,
      secret: false,
      // A modified client trying to dictate the outcome.
      total: 20,
      rollData: { total: 20, isCritical: true },
    } as never);

    const payload = await waiting;
    const roll = payload?.message.rollData;

    expect(roll).toBeTruthy();
    expect(roll!.total).toBeGreaterThanOrEqual(1);
    expect(roll!.total).toBeLessThanOrEqual(20);
    expect(roll!.rolls.length).toBe(1);
  });

  it('applies keep-highest for advantage', async () => {
    const waiting = next<{ message: WireChatMessage }>(dmSocket, 'chat:message');
    aliceSocket.emit('chat:roll', { expression: '2d20kh1', label: 'Advantage', actorId: null, secret: false });

    const roll = (await waiting)?.message.rollData;
    expect(roll!.rolls.length).toBe(2);
    expect(roll!.total).toBe(Math.max(...roll!.rolls));
  });

  it('rejects an expression built to hang the server', async () => {
    const failure = next<{ message: string }>(aliceSocket, 'error');
    aliceSocket.emit('chat:roll', { expression: '99999d99999', label: '', actorId: null, secret: false });

    const error = await failure;
    expect(error?.message).toMatch(/too many dice/i);
  });
});

describe('secret rolls', () => {
  it('reach the DM and the roller but not other players', async () => {
    const bobsMessages = collect<{ message: WireChatMessage }>(bobSocket, 'chat:message');
    const dmsMessages = collect<{ message: WireChatMessage }>(dmSocket, 'chat:message');
    const aliceSees = next<{ message: WireChatMessage }>(aliceSocket, 'chat:message');

    aliceSocket.emit('chat:roll', {
      expression: '1d20',
      label: 'Secret Stealth',
      actorId: null,
      secret: true,
    });

    const [bobSaw, dmSaw, aliceSaw] = await Promise.all([bobsMessages, dmsMessages, aliceSees]);

    expect(aliceSaw?.message.body).toBe('Secret Stealth');
    expect(dmSaw.some((m) => m.message.body === 'Secret Stealth')).toBe(true);
    expect(bobSaw.some((m) => m.message.body === 'Secret Stealth')).toBe(false);
  });

  it('stays hidden in history for a player who was not party to it', async () => {
    const socket = await open(bob);
    const history = next<{ messages: WireChatMessage[] }>(socket, 'chat:history', 3000);
    socket.emit('campaign:join', { campaignId });

    const messages = (await history)?.messages ?? [];
    socket.close();

    expect(messages.length).toBeGreaterThan(0);
    // Secrecy is persisted, not just applied at delivery time.
    expect(messages.some((m) => m.body === 'Secret Stealth')).toBe(false);
    expect(messages.some((m) => m.body.includes('pocket the ring'))).toBe(false);
    expect(messages.some((m) => m.body === 'I search the chest.')).toBe(true);
  });

  it('is visible in the DM history', async () => {
    const socket = await open(dm);
    const history = next<{ messages: WireChatMessage[] }>(socket, 'chat:history', 3000);
    socket.emit('campaign:join', { campaignId });

    const messages = (await history)?.messages ?? [];
    socket.close();

    expect(messages.some((m) => m.body === 'Secret Stealth')).toBe(true);
  });
});

describe('membership is enforced per event', () => {
  it('refuses to join a campaign the user is not in', async () => {
    const socket = await open(outsider);
    const failure = next<{ message: string; code?: string }>(socket, 'error', 2000);
    socket.emit('campaign:join', { campaignId });

    const error = await failure;
    socket.close();

    expect(error?.code).toBe('NOT_A_MEMBER');
  });

  it('does not deliver table chat to a non-member', async () => {
    const socket = await open(outsider);
    socket.emit('campaign:join', { campaignId });
    await new Promise((r) => setTimeout(r, 300));

    const heard = collect<{ message: WireChatMessage }>(socket, 'chat:message');
    aliceSocket.emit('chat:send', { body: 'members only', whisperToUserId: null, actorId: null });

    const messages = await heard;
    socket.close();

    expect(messages.length).toBe(0);
  });
});

describe('NPCs stay off the player roster', () => {
  it('hides a DM-created NPC from players entirely, name included', async () => {
    // Built directly rather than from the compendium: the test database is a
    // fresh temp directory with no SRD import.
    const created = await api<{ actor: { id: string } }>(
      'POST',
      '/api/actors',
      { name: 'Ancient Red Dragon', type: 'npc' },
      dm.cookie,
    );
    await api(
      'POST',
      `/api/actors/${created.actor.id}/campaigns/${campaignId}`,
      {},
      dm.cookie,
    );

    const dmView = await api<{ actors: { name: string; type: string }[] }>(
      'GET', `/api/campaigns/${campaignId}/actors`, undefined, dm.cookie,
    );
    const playerView = await api<{ actors: { name: string; type: string }[] }>(
      'GET', `/api/campaigns/${campaignId}/actors`, undefined, alice.cookie,
    );

    expect(dmView.actors.some((a) => a.name === 'Ancient Red Dragon')).toBe(true);

    // The name alone is the spoiler, so absence - not redaction - is the fix.
    expect(playerView.actors.some((a) => a.name === 'Ancient Red Dragon')).toBe(false);
    expect(playerView.actors.some((a) => a.type === 'npc')).toBe(false);
  });
});

describe('group rolls', () => {
  beforeAll(async () => {
    // This suite otherwise only creates NPCs, and a group roll needs a party.
    const pc = await api<{ actor: { id: string } }>(
      'POST', '/api/actors', { name: 'Alice PC', type: 'character', wis: 14 }, alice.cookie,
    );
    await api('POST', `/api/actors/${pc.actor.id}/campaigns/${campaignId}`, {}, alice.cookie);

    // An NPC in the same campaign, which must not appear in any result.
    const npc = await api<{ actor: { id: string } }>(
      'POST', '/api/actors', { name: 'Tavern Keeper', type: 'npc' }, dm.cookie,
    );
    await api('POST', `/api/actors/${npc.actor.id}/campaigns/${campaignId}`, {}, dm.cookie);
  });

  it('rolls once for each player character and nothing for NPCs', async () => {

    const waiting = next<{ message: { body: string } }>(aliceSocket, 'chat:message');
    dmSocket.emit('chat:groupRoll', { kind: 'skill', key: 'perception', dc: null, secret: false });

    const body = (await waiting)?.message.body ?? '';
    expect(body).toMatch(/Group Perception check/i);
    expect(body).toContain('Alice PC');
    // The bestiary stays the DM's business.
    expect(body).not.toContain('Tavern Keeper');
  });

  it('marks each line against a DC when one is given', async () => {
    const waiting = next<{ message: { body: string } }>(aliceSocket, 'chat:message');
    dmSocket.emit('chat:groupRoll', { kind: 'save', key: 'dex', dc: 15, secret: false });

    const body = (await waiting)?.message.body ?? '';
    expect(body).toMatch(/DC 15/);
    expect(body).toMatch(/[✓✗]/);
  });

  it('keeps a secret group roll away from players', async () => {
    const toPlayer = next<{ message: { body: string } }>(aliceSocket, 'chat:message', 1200);
    const toDm = next<{ message: { body: string } }>(dmSocket, 'chat:message');

    dmSocket.emit('chat:groupRoll', { kind: 'skill', key: 'stealth', dc: null, secret: true });

    expect((await toDm)?.message.body).toMatch(/Group Stealth/i);
    // A secret roll is routed to the DM alone, never flagged and broadcast.
    expect(await toPlayer).toBeNull();
  });

  it('refuses to let a player call for one', async () => {
    const failure = next<{ message: string }>(aliceSocket, 'error');
    aliceSocket.emit('chat:groupRoll', { kind: 'skill', key: 'perception', dc: null, secret: false });
    expect((await failure)?.message).toMatch(/only the dm/i);
  });
});

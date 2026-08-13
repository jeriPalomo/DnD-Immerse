import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import type { WireToken } from '@dnd/shared';

/**
 * Death saves, and whether a linked token's hit points stay in step with its
 * sheet.
 *
 * That last one is the reason this file exists: damage writes to both the
 * token and the actor, but rests and sheet edits write only to the actor,
 * while the board reads the token. A player resting and their token still
 * showing 12/47 is the kind of thing nobody notices until mid-session.
 */

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dnd-combat-'));
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
  const payload = (await response.json()) as { user: { id: string } };
  return { cookie: (response.headers.get('set-cookie') ?? '').split(';')[0], userId: payload.user.id };
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

function next<T>(socket: Socket, event: string, timeoutMs = 3000): Promise<T | null> {
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

let dm: Account;
let alice: Account;
let campaignId: string;
let sceneId: string;
let dmSocket: Socket;
let aliceSocket: Socket;
let actorId: string;
let tokenId: string;

beforeAll(async () => {
  const { buildApp } = await import('../app.js');
  const { runMigrations } = await import('../db/migrate.js');
  const { attachRealtime } = await import('./index.js');

  await runMigrations();
  const app = await buildApp();
  attachRealtime(app);
  await app.listen({ port: 0, host: '127.0.0.1' });

  const address = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  close = async () => {
    await app.close();
  };

  dm = await register('dm@combat.local', 'DM');
  alice = await register('alice@combat.local', 'Alice');

  const campaign = await api<{ campaign: { id: string; inviteCode: string } }>(
    'POST', '/api/campaigns', { name: 'Combat Test' }, dm.cookie,
  );
  campaignId = campaign.campaign.id;
  await api('POST', '/api/campaigns/join', { inviteCode: campaign.campaign.inviteCode }, alice.cookie);

  const scene = await api<{ scene: { id: string } }>(
    'POST', `/api/campaigns/${campaignId}/scenes`, { name: 'Arena' }, dm.cookie,
  );
  sceneId = scene.scene.id;

  const actor = await api<{ actor: { id: string } }>(
    'POST',
    '/api/actors',
    { name: 'Alice PC', type: 'character', level: 5, con: 14, hpMax: 47, hpCurrent: 12, hitDiceTotal: '5d10', hitDiceUsed: 3 },
    alice.cookie,
  );
  actorId = actor.actor.id;
  await api('POST', `/api/actors/${actorId}/campaigns/${campaignId}`, {}, alice.cookie);

  [dmSocket, aliceSocket] = await Promise.all([open(dm), open(alice)]);
  for (const socket of [dmSocket, aliceSocket]) socket.emit('campaign:join', { campaignId });
  await new Promise((r) => setTimeout(r, 700));

  dmSocket.emit('scene:activate', { sceneId });
  await new Promise((r) => setTimeout(r, 400));

  const created = next<{ token: WireToken }>(dmSocket, 'token:created');
  dmSocket.emit('token:create', {
    sceneId, actorId, actorLinked: true, ownerUserId: alice.userId,
    name: 'Alice PC', x: 2, y: 2, hp: 12, maxHp: 47,
  } as never);
  tokenId = (await created)!.token.id;
}, 60000);

afterAll(async () => {
  for (const socket of [dmSocket, aliceSocket]) socket?.close();
  await new Promise((r) => setTimeout(r, 300));
  await close?.();

  const { client } = await import('../db/index.js');
  client.close();
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {
    // Not worth failing a passing suite over.
  }
});

/** The token as the board currently shows it. */
async function boardToken(): Promise<WireToken | undefined> {
  const state = await new Promise<{ tokens: WireToken[] } | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 3000);
    dmSocket.once('scene:state', (payload: { tokens: WireToken[] }) => {
      clearTimeout(timer);
      resolve(payload);
    });
    dmSocket.emit('scene:activate', { sceneId });
  });
  return state?.tokens.find((t) => t.id === tokenId);
}

describe('a linked token stays in step with its sheet', () => {
  it('shows the healed hit points after a long rest', async () => {
    await api('POST', `/api/actors/${actorId}/rest`, { type: 'long' }, alice.cookie);

    const sheet = await api<{ actor: { hpCurrent: number } }>(
      'GET', `/api/actors/${actorId}`, undefined, alice.cookie,
    );
    expect(sheet.actor.hpCurrent).toBe(47);

    // The board must agree with the sheet, or a rested player still looks hurt.
    const token = await boardToken();
    expect(token?.hp).toBe(47);
  });

  it('shows an edit made on the character sheet', async () => {
    await api('PATCH', `/api/actors/${actorId}`, { hpCurrent: 20 }, alice.cookie);

    const token = await boardToken();
    expect(token?.hp).toBe(20);
  });
});

describe('death saves', () => {
  beforeAll(async () => {
    await api('PATCH', `/api/actors/${actorId}`, { hpCurrent: 0 }, alice.cookie);
    await new Promise((r) => setTimeout(r, 300));
  });

  it('lets the character owner roll their own', async () => {
    const message = next<{ message: { body: string } }>(dmSocket, 'chat:message');
    aliceSocket.emit('death:save', { tokenId });

    const body = (await message)?.message.body ?? '';
    expect(body).toMatch(/Alice PC death save/i);
    // Every die in the app is rolled on the server, this one included.
    expect(body).toMatch(/\d+/);
  });

  it('refuses a player rolling for someone else', async () => {
    const other = await api<{ actor: { id: string } }>(
      'POST', '/api/actors', { name: 'DM NPC', type: 'npc', hpMax: 10, hpCurrent: 0 }, dm.cookie,
    );

    const created = next<{ token: WireToken }>(dmSocket, 'token:created');
    dmSocket.emit('token:create', {
      sceneId, actorId: other.actor.id, name: 'DM NPC', x: 9, y: 9, hp: 0, maxHp: 10,
    } as never);
    const npcToken = (await created)!.token.id;

    const failure = next<{ message: string }>(aliceSocket, 'error');
    aliceSocket.emit('death:save', { tokenId: npcToken });
    expect((await failure)?.message).toMatch(/not your character/i);
  });
});

describe('handout reveal', () => {
  it('refuses to let a player reveal one', async () => {
    const entry = await api<{ entry: { pages: { id: string }[] } }>(
      'POST', `/api/campaigns/${campaignId}/journal`, { title: 'Secret' }, dm.cookie,
    );

    const failure = next<{ message: string }>(aliceSocket, 'error');
    aliceSocket.emit('handout:show', { pageId: entry.entry.pages[0].id });
    expect((await failure)?.message).toMatch(/only the dm/i);
  });
});

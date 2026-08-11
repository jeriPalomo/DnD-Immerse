import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import type { WireScene, WireToken, WireVision } from '@dnd/shared';

/**
 * The three invariants the design rests on:
 *
 *   1. A player's payload contains no hidden tokens.
 *   2. A player's payload contains no tokens outside their line of sight.
 *   3. A player's payload contains no wall geometry.
 *
 * These are the regressions that cost a session, and none of them is visible
 * from the UI - a leak looks perfectly normal until someone opens devtools.
 */

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dnd-vision-'));
process.env.DATA_DIR = DATA_DIR;
process.env.NODE_ENV = 'test';

let baseUrl: string;
let close: () => Promise<void>;

interface Account {
  cookie: string;
  userId: string;
}

interface ScenePayload {
  scene: WireScene | null;
  tokens: WireToken[];
  vision: WireVision | null;
  doors: { id: string; doorState: number }[];
  walls?: unknown[];
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

/**
 * Waits for a scene:state that satisfies `until`.
 *
 * Every scene:activate broadcasts to every socket, so events queue up and a
 * plain "next event" listener drifts a beat behind. Matching on the condition
 * makes the test insensitive to how many stale broadcasts are in flight.
 */
async function waitForScene(
  socket: Socket,
  trigger: () => void,
  until: (payload: ScenePayload) => boolean = () => true,
  timeoutMs = 4000,
): Promise<ScenePayload> {
  return new Promise((resolve) => {
    const empty: ScenePayload = { scene: null, tokens: [], vision: null, doors: [] };
    const timer = setTimeout(() => {
      socket.off('scene:state', handler);
      resolve(empty);
    }, timeoutMs);

    const handler = (payload: ScenePayload) => {
      if (!until(payload)) return;
      clearTimeout(timer);
      socket.off('scene:state', handler);
      resolve(payload);
    };

    socket.on('scene:state', handler);
    trigger();
  });
}

/** Forces a fresh scene:state and returns it. */
async function refresh(socket: Socket, trigger: () => void): Promise<ScenePayload> {
  return waitForScene(socket, trigger);
}

let dm: Account;
let alice: Account;
let campaignId: string;
let sceneId: string;
let dmSocket: Socket;
let aliceSocket: Socket;
let doorId: string;
let hiddenTokenId: string;
let farTokenId: string;

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

  dm = await register('dm@vision.local', 'DM');
  alice = await register('alice@vision.local', 'Alice');

  const campaign = await api<{ campaign: { id: string; inviteCode: string } }>(
    'POST', '/api/campaigns', { name: 'Vision Test' }, dm.cookie,
  );
  campaignId = campaign.campaign.id;
  await api('POST', '/api/campaigns/join', { inviteCode: campaign.campaign.inviteCode }, alice.cookie);

  const scene = await api<{ scene: { id: string } }>(
    'POST', `/api/campaigns/${campaignId}/scenes`, { name: 'Crypt', gridSize: 70 }, dm.cookie,
  );
  sceneId = scene.scene.id;

  // A map big enough to have an inside and an outside, and vision switched on.
  await api('PATCH', `/api/scenes/${sceneId}`, { visionEnabled: true }, dm.cookie);

  const actor = await api<{ actor: { id: string } }>(
    'POST', '/api/actors', { name: 'Alice PC' }, alice.cookie,
  );
  await api('POST', `/api/actors/${actor.actor.id}/campaigns/${campaignId}`, {}, alice.cookie);

  [dmSocket, aliceSocket] = await Promise.all([open(dm), open(alice)]);
  for (const socket of [dmSocket, aliceSocket]) socket.emit('campaign:join', { campaignId });
  await new Promise((r) => setTimeout(r, 700));

  dmSocket.emit('scene:activate', { sceneId });
  await new Promise((r) => setTimeout(r, 400));

  // A sealed room around (5,5) with a door on its east side.
  const segments: [number, number, number, number][] = [
    [0, 0, 10, 0],
    [0, 10, 10, 10],
    [0, 0, 0, 10],
    [10, 0, 10, 4],
    [10, 6, 10, 10],
  ];
  for (const [x1, y1, x2, y2] of segments) {
    dmSocket.emit('wall:create', { sceneId, x1, y1, x2, y2 } as never);
    await new Promise((r) => setTimeout(r, 60));
  }

  const doorCreated = next<{ wall: { id: string } }>(dmSocket, 'wall:created');
  dmSocket.emit('wall:create', { sceneId, x1: 10, y1: 4, x2: 10, y2: 6, door: 1, doorState: 0 } as never);
  doorId = (await doorCreated)!.wall.id;

  // Alice's token inside the room.
  const mine = next<{ token: WireToken }>(dmSocket, 'token:created');
  dmSocket.emit('token:create', {
    sceneId, x: 5, y: 5, name: 'Alice PC', ownerUserId: alice.userId, visionRange: 300,
  } as never);
  await mine;

  // An enemy far outside the room, behind the wall.
  const far = next<{ token: WireToken }>(dmSocket, 'token:created');
  dmSocket.emit('token:create', { sceneId, x: 20, y: 5, name: 'Lurker' } as never);
  farTokenId = (await far)!.token.id;

  // A hidden ambusher standing right next to Alice.
  const secret = next<{ token: WireToken }>(dmSocket, 'token:created');
  dmSocket.emit('token:create', { sceneId, x: 6, y: 5, name: 'Ambusher', hidden: true } as never);
  hiddenTokenId = (await secret)!.token.id;

  await new Promise((r) => setTimeout(r, 400));
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

describe('invariant: no wall geometry reaches a player', () => {
  it('omits the walls key entirely from a player payload', async () => {
    const player = await refresh(aliceSocket, () => dmSocket.emit('scene:activate', { sceneId }));
    const dmView = await refresh(dmSocket, () => dmSocket.emit('scene:activate', { sceneId }));

    expect(Array.isArray(dmView.walls)).toBe(true);
    expect(dmView.walls!.length).toBeGreaterThan(0);

    // Absent, not empty: nothing about the dungeon's shape is inferable.
    expect(player.walls).toBeUndefined();
  });

  it('still sends doors, which players must be able to open', async () => {
    const player = await refresh(aliceSocket, () => dmSocket.emit('scene:activate', { sceneId }));
    expect(player.doors.length).toBe(1);
    expect(player.doors[0].id).toBe(doorId);
  });
});

describe('invariant: no hidden tokens reach a player', () => {
  it('strips a hidden token standing in plain sight', async () => {
    const player = await refresh(aliceSocket, () => dmSocket.emit('scene:activate', { sceneId }));
    const dmView = await refresh(dmSocket, () => dmSocket.emit('scene:activate', { sceneId }));

    expect(dmView.tokens.some((t) => t.id === hiddenTokenId)).toBe(true);
    expect(player.tokens.some((t) => t.id === hiddenTokenId)).toBe(false);
    expect(player.tokens.some((t) => t.name === 'Ambusher')).toBe(false);
  });
});

describe('invariant: no out-of-sight tokens reach a player', () => {
  it('withholds a token behind a wall', async () => {
    const player = await refresh(aliceSocket, () => dmSocket.emit('scene:activate', { sceneId }));

    expect(player.vision).not.toBeNull();
    expect(player.vision!.polygons.length).toBeGreaterThan(0);

    // The lurker is outside the sealed room, so it must not be in the payload.
    expect(player.tokens.some((t) => t.id === farTokenId)).toBe(false);
    // Alice's own token is always present.
    expect(player.tokens.some((t) => t.name === 'Alice PC')).toBe(true);
  });

  it('reveals it once the door is opened', async () => {
    const player = await waitForScene(
      aliceSocket,
      () => aliceSocket.emit('door:toggle', { wallId: doorId }),
      (payload) => payload.doors.some((d) => d.doorState === 1),
    );

    // The single best moment the board produces.
    expect(player.doors.some((d) => d.doorState === 1)).toBe(true);
    expect(player.tokens.some((t) => t.id === farTokenId)).toBe(true);
  });

  it('hides it again when the door is shut', async () => {
    const player = await waitForScene(
      aliceSocket,
      () => aliceSocket.emit('door:toggle', { wallId: doorId }),
      (payload) => payload.doors.every((d) => d.doorState !== 1),
    );

    expect(player.tokens.some((t) => t.id === farTokenId)).toBe(false);
  });
});

describe('fog exploration persists', () => {
  it('remembers ground already walked, across a reconnect', async () => {
    const before = await refresh(aliceSocket, () => dmSocket.emit('scene:activate', { sceneId }));
    const exploredBefore = before.vision!.explored.length;
    expect(exploredBefore).toBeGreaterThan(0);

    const rejoined = await open(alice);
    const state = next<ScenePayload>(rejoined, 'scene:state');
    rejoined.emit('campaign:join', { campaignId });

    const after = await state;
    rejoined.close();

    // Exploration is stored, not recomputed from nothing.
    expect(after?.vision?.explored.length).toBeGreaterThanOrEqual(exploredBefore);
  });
});

describe('door permissions', () => {
  it('refuses to let a player open a locked door', async () => {
    dmSocket.emit('wall:update', { wallId: doorId, doorState: 2 });
    await new Promise((r) => setTimeout(r, 300));

    const failure = next<{ message: string }>(aliceSocket, 'error');
    aliceSocket.emit('door:toggle', { wallId: doorId });

    expect((await failure)?.message).toMatch(/locked/i);
  });
});

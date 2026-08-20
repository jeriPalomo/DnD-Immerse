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
let myTokenId: string;

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
  myTokenId = (await mine)!.token.id;

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

  it('withholds a secret door, which is wall geometry wearing a door', async () => {
    // `door: 2` sat in the schema unread for long enough that a secret door was
    // drawn, sent and clickable exactly like an ordinary one - so the bookcase
    // announced the passage behind it.
    const made = next<{ wall: { id: string } }>(dmSocket, 'wall:created');
    dmSocket.emit('wall:create', {
      sceneId, x1: 0, y1: 9, x2: 4, y2: 9,
      blocksMovement: 1, blocksSight: 1, door: 2, doorState: 0,
    });
    const secretId = (await made)!.wall.id;

    const dmView = await refresh(dmSocket, () => dmSocket.emit('scene:activate', { sceneId }));
    const player = await refresh(aliceSocket, () => dmSocket.emit('scene:activate', { sceneId }));

    expect(dmView.doors.some((d) => d.id === secretId)).toBe(true);
    expect(player.doors.some((d) => d.id === secretId)).toBe(false);
    expect(JSON.stringify(player.doors)).not.toContain(secretId);

    // And an id obtained some other way still will not open it. No broadcast
    // is expected, so this waits a beat rather than on an event.
    aliceSocket.emit('door:toggle', { wallId: secretId });
    await new Promise((resolve) => setTimeout(resolve, 250));

    const after = await refresh(dmSocket, () => dmSocket.emit('scene:activate', { sceneId }));
    expect(after.doors.find((d) => d.id === secretId)?.doorState).toBe(0);
  });

  it('reveals the passage when the DM turns it into an ordinary door', async () => {
    const made = next<{ wall: { id: string } }>(dmSocket, 'wall:created');
    dmSocket.emit('wall:create', {
      sceneId, x1: 0, y1: 11, x2: 4, y2: 11,
      blocksMovement: 1, blocksSight: 1, door: 2, doorState: 0,
    });
    const secretId = (await made)!.wall.id;

    const hidden = await refresh(aliceSocket, () => dmSocket.emit('scene:activate', { sceneId }));
    expect(hidden.doors.some((d) => d.id === secretId)).toBe(false);

    // The bookcase swings aside: a secret door becomes a real one.
    const shown = await refresh(aliceSocket, () =>
      dmSocket.emit('wall:update', { wallId: secretId, door: 1 }),
    );
    expect(shown.doors.some((d) => d.id === secretId)).toBe(true);
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

  it('does not announce a token placed out of sight', async () => {
    // The create path used to skip the sight check entirely, so a DM placing an
    // ambusher behind a wall shipped its full stat line to every player - and
    // unlike a drag frame, nothing corrected it until the next scene push.
    const heard: string[] = [];
    aliceSocket.on('token:created', (payload: { token: { id: string } }) =>
      heard.push(payload.token.id),
    );

    const created = next<{ token: { id: string } }>(dmSocket, 'token:created');
    dmSocket.emit('token:create', {
      sceneId, x: 18, y: 2, name: 'Second Lurker', w: 1, h: 1, disposition: 'hostile',
    });
    const lurker = await created;
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(lurker?.token.id).toBeTruthy();
    expect(heard).not.toContain(lurker!.token.id);
  });
});

describe('invariant: a threat range never draws a map', () => {
  it('sends a player no square they have not explored', async () => {
    const player = await refresh(aliceSocket, () => dmSocket.emit('scene:activate', { sceneId }));
    const explored = new Set(player.vision!.explored.map(([x, y]) => `${x}:${y}`));

    const reply = next<{ squares: [number, number][] }>(aliceSocket, 'movement:range');
    aliceSocket.emit('movement:query', { tokenId: null, threat: true });
    const squares = (await reply)?.squares ?? [];

    // The lurker beyond the sealed door can move around out there; if any of
    // that reached Alice she would learn the shape of a room she has not seen.
    for (const [x, y] of squares) {
      expect(explored.has(`${x}:${y}`)).toBe(true);
    }
  });

  it('does not outline a hidden token by refusing to path through it', async () => {
    // The Ambusher stands at (6,5), hidden, right beside Alice. If occupancy
    // were taken from every token on the scene rather than the ones she can
    // see, her range would have a creature-shaped hole in it - which gives the
    // ambusher away just as surely as sending the token would.
    const player = await refresh(aliceSocket, () => dmSocket.emit('scene:activate', { sceneId }));
    const mine = player.tokens.find((t) => t.name === 'Alice PC');

    const reply = next<{ squares: [number, number][] }>(aliceSocket, 'movement:range');
    aliceSocket.emit('movement:query', { tokenId: mine!.id, threat: false });
    const squares = (await reply)?.squares ?? [];

    expect(squares.length).toBeGreaterThan(0);
    expect(squares.some(([x, y]) => x === 6 && y === 5)).toBe(true);
  });

  it('still draws a range on a scene with dynamic vision off', async () => {
    // The clip to explored ground filtered against `view.vision.explored`, and
    // `computePlayerView` returns null when a scene has vision off - so the
    // filter ran against an empty set and threw the whole range away. Since
    // `visionEnabled` defaults to false, a player on an ordinary scene selected
    // their token and saw nothing at all. Nothing is hidden on such a scene, so
    // there is nothing to clip against and nothing to leak.
    await api('PATCH', `/api/scenes/${sceneId}`, { visionEnabled: false }, dm.cookie);
    const player = await refresh(aliceSocket, () => dmSocket.emit('scene:activate', { sceneId }));
    const mine = player.tokens.find((t) => t.name === 'Alice PC');

    const reply = next<{ squares: [number, number][] }>(aliceSocket, 'movement:range');
    aliceSocket.emit('movement:query', { tokenId: mine!.id, threat: false });
    const squares = (await reply)?.squares ?? [];

    expect(squares.length).toBeGreaterThan(0);

    // Put it back: the rest of this suite is about what vision hides.
    await api('PATCH', `/api/scenes/${sceneId}`, { visionEnabled: true }, dm.cookie);
    await refresh(aliceSocket, () => dmSocket.emit('scene:activate', { sceneId }));
  });

  it('gives the DM the unclipped truth', async () => {
    const reply = next<{ squares: [number, number][] }>(dmSocket, 'movement:range');
    dmSocket.emit('movement:query', { tokenId: null, threat: true });
    const squares = (await reply)?.squares ?? [];

    // The DM has no fog to clip against, so the hostile tokens beyond the wall
    // contribute their full reach.
    expect(squares.length).toBeGreaterThan(0);
  });
});

describe('invariant: enemy hit points are the DM’s to reveal', () => {
  it('redacts hp on a monster the player can see', async () => {
    // In the room with Alice, so sight is not what is being tested here.
    const placed = next<{ token: WireToken }>(dmSocket, 'token:created');
    dmSocket.emit('token:create', {
      sceneId, x: 6, y: 6, name: 'Ogre', hp: 7, maxHp: 59, disposition: 'hostile',
    } as never);
    const ogre = await placed;

    const player = await refresh(aliceSocket, () => dmSocket.emit('scene:activate', { sceneId }));
    const dmView = await refresh(dmSocket, () => dmSocket.emit('scene:activate', { sceneId }));

    // The tracker redacted this carefully and every other channel published it
    // anyway - the board tooltip, the token HUD and the target panel all read
    // hp straight off the wire, so "the boss is on 7" was one hover away.
    const seen = player.tokens.find((t) => t.id === ogre!.token.id);
    expect(seen).toBeTruthy();
    expect(seen!.hp).toBeNull();
    expect(seen!.maxHp).toBeNull();
    expect(JSON.stringify(player.tokens)).not.toContain('59');

    // The DM still sees the real numbers.
    const dmSees = dmView.tokens.find((t) => t.id === ogre!.token.id);
    expect(dmSees?.hp).toBe(7);
    expect(dmSees?.maxHp).toBe(59);
  });
});

/**
 * Whether players may read a creature's stat block is the DM's call, and it is
 * a *separate* call from hit points. The whole point of splitting them is that
 * a table can agree "you know what an ogre is" without conceding "you know the
 * ogre is on 7", so the tests that matter here are the ones proving the second
 * never rides along with the first.
 */
describe('invariant: stat blocks are granted, hit points never', () => {
  let ogreId: string;

  beforeAll(async () => {
    const placed = next<{ token: WireToken }>(dmSocket, 'token:created');
    dmSocket.emit('token:create', {
      sceneId, x: 6, y: 6, name: 'Ogre', hp: 7, maxHp: 59, disposition: 'hostile',
    } as never);
    ogreId = (await placed)!.token.id;
  });

  it('lets a player read the block while the campaign allows it', async () => {
    const block = await api<{ statBlock: Record<string, unknown> }>(
      'GET', `/api/campaigns/${campaignId}/tokens/${ogreId}/statblock`, undefined, alice.cookie,
    );
    expect(block.statBlock).toBeTruthy();
    // The creature has no sheet behind it in this test, so what matters is that
    // the answer carries no hit points of any kind.
    expect(JSON.stringify(block)).not.toContain('59');
    expect(JSON.stringify(block)).not.toMatch(/"hit_points"|"hitPoints"|"hpMax"/);
  });

  it('refuses once the DM turns the campaign setting off', async () => {
    await api('PATCH', `/api/campaigns/${campaignId}`, { playersSeeEnemyStats: false }, dm.cookie);

    await expect(
      api('GET', `/api/campaigns/${campaignId}/tokens/${ogreId}/statblock`, undefined, alice.cookie),
    ).rejects.toThrow();

    // The DM is never locked out of their own monster.
    const dmSees = await api<{ statBlock: unknown }>(
      'GET', `/api/campaigns/${campaignId}/tokens/${ogreId}/statblock`, undefined, dm.cookie,
    );
    expect(dmSees.statBlock).toBeTruthy();

    await api('PATCH', `/api/campaigns/${campaignId}`, { playersSeeEnemyStats: true }, dm.cookie);
  });

  it('refuses the one creature the DM closes, while the rest stay open', async () => {
    const placed = next<{ token: WireToken }>(dmSocket, 'token:created');
    dmSocket.emit('token:create', {
      sceneId, x: 7, y: 7, name: 'The Boss', statsHidden: true, disposition: 'hostile',
    } as never);
    const boss = (await placed)!.token.id;

    await expect(
      api('GET', `/api/campaigns/${campaignId}/tokens/${boss}/statblock`, undefined, alice.cookie),
    ).rejects.toThrow();

    const stillOpen = await api<{ statBlock: unknown }>(
      'GET', `/api/campaigns/${campaignId}/tokens/${ogreId}/statblock`, undefined, alice.cookie,
    );
    expect(stillOpen.statBlock).toBeTruthy();
  });

  it('never tells a player which creature the DM has closed', async () => {
    const player = await refresh(aliceSocket, () => dmSocket.emit('scene:activate', { sceneId }));
    // `statsHidden` marks the interesting one. Players are told what they may
    // read, never what has been withheld from them.
    for (const token of player.tokens) expect(token.statsHidden).toBe(false);
  });

  it("refuses another player's character sheet, whatever the enemy-stats setting says", async () => {
    // The grant is about creatures the party fights. A character sheet is
    // governed by ownership, as it is everywhere else - the roster shows
    // another player's character at name level and no further. Without this
    // the route handed over their ability scores and their whole inventory.
    const bob = await register('bob@vision.local', 'Bob');
    const invite = await api<{ campaign: { inviteCode: string } }>(
      'GET', `/api/campaigns/${campaignId}`, undefined, dm.cookie,
    );
    await api('POST', '/api/campaigns/join', { inviteCode: invite.campaign.inviteCode }, bob.cookie);

    const sheet = await api<{ actor: { id: string } }>(
      'POST', '/api/actors', { name: 'Bob PC', type: 'character', str: 18 }, bob.cookie,
    );
    await api('POST', `/api/actors/${sheet.actor.id}/campaigns/${campaignId}`, {}, bob.cookie);

    const placed = next<{ token: WireToken }>(dmSocket, 'token:created');
    dmSocket.emit('token:create', {
      sceneId, x: 8, y: 8, name: 'Bob PC', actorId: sheet.actor.id, ownerUserId: bob.userId,
    } as never);
    const theirs = (await placed)!.token.id;

    await expect(
      api('GET', `/api/campaigns/${campaignId}/tokens/${theirs}/statblock`, undefined, alice.cookie),
    ).rejects.toThrow(/not been shared/i);

    // Its owner still reads it, and so does the DM.
    const own = await api<{ statBlock: unknown }>(
      'GET', `/api/campaigns/${campaignId}/tokens/${theirs}/statblock`, undefined, bob.cookie,
    );
    expect(own.statBlock).toBeTruthy();
    const dmSees = await api<{ statBlock: unknown }>(
      'GET', `/api/campaigns/${campaignId}/tokens/${theirs}/statblock`, undefined, dm.cookie,
    );
    expect(dmSees.statBlock).toBeTruthy();
  });

  it('refuses a token id from another campaign', async () => {
    const other = await api<{ campaign: { id: string } }>(
      'POST', '/api/campaigns', { name: 'Somebody else’s game' }, alice.cookie,
    );
    await expect(
      api('GET', `/api/campaigns/${other.campaign.id}/tokens/${ogreId}/statblock`, undefined, alice.cookie),
    ).rejects.toThrow();
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

describe('walls stop movement', () => {
  let aliceTokenId: string;

  beforeAll(async () => {
    // Make sure the door is shut before testing collision through it.
    dmSocket.emit('wall:update', { wallId: doorId, doorState: 0 });
    await new Promise((r) => setTimeout(r, 300));

    const state = await refresh(dmSocket, () => dmSocket.emit('scene:activate', { sceneId }));
    aliceTokenId = state.tokens.find((t) => t.name === 'Alice PC')!.id;
  });

  it('refuses to let a player walk through a wall, and snaps them back', async () => {
    const failure = next<{ message: string }>(aliceSocket, 'error');
    const correction = next<{ token: WireToken }>(dmSocket, 'token:updated');

    // From inside the sealed room, straight out through the east wall.
    aliceSocket.emit('token:commit', { tokenId: aliceTokenId, x: 20, y: 8 });

    expect((await failure)?.message).toMatch(/wall blocks/i);

    const corrected = await correction;
    // Still inside the room, at the position it started from.
    expect(corrected?.token.x).toBeLessThan(10);
  });

  it('allows movement within the room', async () => {
    const moved = next<{ token: WireToken }>(dmSocket, 'token:updated');
    aliceSocket.emit('token:commit', { tokenId: aliceTokenId, x: 8, y: 8 });

    expect((await moved)?.token.x).toBe(8);
  });

  it('lets the DM place a token anywhere, walls included', async () => {
    const moved = next<{ token: WireToken }>(dmSocket, 'token:updated');
    dmSocket.emit('token:commit', { tokenId: aliceTokenId, x: 25, y: 8 });

    // The DM needs to place things inside and beyond walls.
    expect((await moved)?.token.x).toBe(25);
  });

  it('opens the way once the door is opened', async () => {
    dmSocket.emit('token:commit', { tokenId: aliceTokenId, x: 5, y: 5 });
    await new Promise((r) => setTimeout(r, 300));

    await waitForScene(
      aliceSocket,
      () => aliceSocket.emit('door:toggle', { wallId: doorId }),
      (payload) => payload.doors.some((d) => d.doorState === 1),
    );

    const moved = next<{ token: WireToken }>(dmSocket, 'token:updated');
    // Straight through the open doorway at y=5.
    aliceSocket.emit('token:commit', { tokenId: aliceTokenId, x: 15, y: 5 });

    expect((await moved)?.token.x).toBe(15);
  });
});

describe('a blinded token sees nothing', () => {
  /**
   * Blindness is enforced where vision is computed, not by dimming the canvas.
   * A client-side blur would be a devtools inspection away from seeing the room
   * anyway, and the tokens standing in it would still be in the payload.
   */
  beforeAll(async () => {
    // Stand her in the open beside the Lurker, so the control case is "she can
    // plainly see it" and the only thing under test is the condition. Placed
    // explicitly rather than inheriting wherever an earlier block left her.
    dmSocket.emit('token:commit', { tokenId: myTokenId, x: 18, y: 5 });
    await new Promise((r) => setTimeout(r, 400));
  });

  it('opens no polygon and reveals nobody, but keeps its own token', async () => {
    const seeing = await refresh(aliceSocket, () => dmSocket.emit('scene:activate', { sceneId }));
    expect(seeing.tokens.some((t) => t.id === farTokenId)).toBe(true);
    expect(seeing.vision!.polygons.length).toBeGreaterThan(0);

    const blind = await waitForScene(
      aliceSocket,
      () => dmSocket.emit('token:update', { tokenId: myTokenId, conditions: ['blinded'] } as never),
      (payload) => payload.tokens.some((t) => t.conditions.includes('blinded')),
    );

    // No polygon at all: nothing new is seen and no fog opens.
    expect(blind.vision).not.toBeNull();
    expect(blind.vision!.polygons).toEqual([]);

    // The Lurker is standing three squares away in the open, and withheld.
    expect(blind.tokens.some((t) => t.id === farTokenId)).toBe(false);

    // Her own token stays, so the screen is readable rather than empty.
    const own = blind.tokens.find((t) => t.id === myTokenId);
    expect(own).toBeDefined();
    expect(own!.conditions).toContain('blinded');
  });

  it('remembers the ground it had already explored', async () => {
    // Blindness stops new sight; it does not erase the map she has walked.
    const blind = await refresh(aliceSocket, () => dmSocket.emit('scene:activate', { sceneId }));
    expect(blind.vision!.explored.length).toBeGreaterThan(0);
  });

  it('gives the sight back when the condition is removed', async () => {
    const restored = await waitForScene(
      aliceSocket,
      () => dmSocket.emit('token:update', { tokenId: myTokenId, conditions: [] } as never),
      (payload) => payload.vision !== null && payload.vision.polygons.length > 0,
    );

    expect(restored.tokens.some((t) => t.id === farTokenId)).toBe(true);
    expect(restored.tokens.find((t) => t.id === myTokenId)!.conditions).toEqual([]);
  });

  it('leaves the DM view untouched', async () => {
    const dmView = await refresh(dmSocket, () => dmSocket.emit('scene:activate', { sceneId }));
    expect(dmView.tokens.some((t) => t.id === farTokenId)).toBe(true);
    expect(dmView.tokens.some((t) => t.id === hiddenTokenId)).toBe(true);
  });
});

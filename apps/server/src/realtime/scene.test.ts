import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import type { WireEncounter, WireScene, WireToken } from '@dnd/shared';

/**
 * Token permission and visibility tests.
 *
 * The filtering tests are the important ones: a hidden token present in a
 * player's payload is a spoiled ambush regardless of whether the client draws
 * it, so these assert absence from the wire, not absence from the screen.
 */

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dnd-scene-'));
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

function next<T>(socket: Socket, event: string, timeoutMs = 2000): Promise<T | null> {
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

/** The latest scene:state this socket receives within the window. */
async function sceneState(socket: Socket, trigger: () => void): Promise<{ scene: WireScene | null; tokens: WireToken[] }> {
  const waiting = next<{ scene: WireScene | null; tokens: WireToken[] }>(socket, 'scene:state', 2500);
  trigger();
  return (await waiting) ?? { scene: null, tokens: [] };
}

let dm: Account;
let alice: Account;
let bob: Account;
let campaignId: string;
let sceneId: string;
let dmSocket: Socket;
let aliceSocket: Socket;
let bobSocket: Socket;
let aliceActorId: string;

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

  dm = await register('dm@scene.local', 'DM');
  alice = await register('alice@scene.local', 'Alice');
  bob = await register('bob@scene.local', 'Bob');

  const created = await api<{ campaign: { id: string; inviteCode: string } }>(
    'POST', '/api/campaigns', { name: 'Board Test' }, dm.cookie,
  );
  campaignId = created.campaign.id;
  for (const player of [alice, bob]) {
    await api('POST', '/api/campaigns/join', { inviteCode: created.campaign.inviteCode }, player.cookie);
  }

  const scene = await api<{ scene: { id: string } }>(
    'POST', `/api/campaigns/${campaignId}/scenes`, { name: 'Crypt' }, dm.cookie,
  );
  sceneId = scene.scene.id;

  // Alice's character, so she owns a token on the board.
  const actor = await api<{ actor: { id: string } }>(
    'POST', '/api/actors', { name: 'Alice PC', hpMax: 30, hpCurrent: 30 }, alice.cookie,
  );
  aliceActorId = actor.actor.id;
  await api('POST', `/api/actors/${aliceActorId}/campaigns/${campaignId}`, {}, alice.cookie);

  [dmSocket, aliceSocket, bobSocket] = await Promise.all([open(dm), open(alice), open(bob)]);
  for (const socket of [dmSocket, aliceSocket, bobSocket]) socket.emit('campaign:join', { campaignId });
  await new Promise((r) => setTimeout(r, 700));

  dmSocket.emit('scene:activate', { sceneId });
  await new Promise((r) => setTimeout(r, 500));
}, 60000);

afterAll(async () => {
  for (const socket of [dmSocket, aliceSocket, bobSocket]) socket?.close();
  await new Promise((r) => setTimeout(r, 300));
  await close?.();

  const { client } = await import('../db/index.js');
  client.close();
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {
    // Leftover temp directory is not worth failing over.
  }
});

describe('scene activation', () => {
  it('pushes the active scene to every player', async () => {
    const state = await sceneState(aliceSocket, () => dmSocket.emit('scene:activate', { sceneId }));
    expect(state.scene?.id).toBe(sceneId);
    expect(state.scene?.name).toBe('Crypt');
  });

  it('refuses to let a player change the scene', async () => {
    const failure = next<{ message: string }>(aliceSocket, 'error');
    aliceSocket.emit('scene:activate', { sceneId });
    expect((await failure)?.message).toMatch(/only the dm/i);
  });
});

describe('token placement', () => {
  it('stamps size and linkage from the actor prototype', async () => {
    // A Gargantuan, unlinked NPC.
    const dragon = await api<{ actor: { id: string } }>(
      'POST',
      '/api/actors',
      {
        name: 'Ancient Red Dragon',
        type: 'npc',
        campaignId,
        hpMax: 546,
        armorClass: 22,
        prototypeToken: { w: 4, h: 4, actorLinked: false, disposition: 'hostile' },
      },
      dm.cookie,
    );

    const created = next<{ token: WireToken }>(dmSocket, 'token:created');
    dmSocket.emit('token:create', { sceneId, actorId: dragon.actor.id, x: 2, y: 2, name: '' } as never);
    const token = (await created)?.token;

    expect(token?.w).toBe(4);
    expect(token?.h).toBe(4);
    expect(token?.actorLinked).toBe(false);
    expect(token?.name).toBe('Ancient Red Dragon');
    // Unlinked tokens carry their own HP so each copy tracks separately.
    expect(token?.maxHp).toBe(546);
    expect(token?.ac).toBe(22);
  });

  it('refuses to let a player place tokens', async () => {
    const failure = next<{ message: string }>(aliceSocket, 'error');
    aliceSocket.emit('token:create', { sceneId, x: 0, y: 0 } as never);
    expect((await failure)?.message).toMatch(/only the dm/i);
  });
});

describe('token movement permissions', () => {
  let aliceTokenId: string;
  let npcTokenId: string;
  let npcX: number;

  beforeAll(async () => {
    const first = next<{ token: WireToken }>(dmSocket, 'token:created');
    dmSocket.emit('token:create', {
      sceneId, actorId: aliceActorId, x: 1, y: 1, name: 'Alice PC', ownerUserId: alice.userId,
    } as never);
    aliceTokenId = (await first)!.token.id;

    const second = next<{ token: WireToken }>(dmSocket, 'token:created');
    dmSocket.emit('token:create', { sceneId, x: 5, y: 5, name: 'Skeleton' } as never);
    const skeleton = (await second)!.token;
    npcTokenId = skeleton.id;
    // Placement shifts off an occupied square, so record where it actually
    // landed rather than assuming the requested position.
    npcX = skeleton.x;
  });

  it('lets a player move their own token, snapped server-side', async () => {
    const updated = next<{ token: WireToken }>(dmSocket, 'token:updated');
    // Deliberately off-grid; the server should snap it.
    aliceSocket.emit('token:commit', { tokenId: aliceTokenId, x: 3.4, y: 6.8 });

    const token = (await updated)?.token;
    expect(token?.x).toBe(3);
    expect(token?.y).toBe(7);
  });

  it('refuses to let a player move a token they do not own, and corrects it', async () => {
    const failure = next<{ message: string }>(aliceSocket, 'error');
    const correction = next<{ token: WireToken }>(dmSocket, 'token:updated');

    aliceSocket.emit('token:commit', { tokenId: npcTokenId, x: 9, y: 9 });

    expect((await failure)?.message).toMatch(/cannot move/i);

    // A rejected move rebroadcasts the authoritative position, so the client
    // that tried it snaps back rather than sitting desynced.
    const corrected = await correction;
    expect(corrected?.token.id).toBe(npcTokenId);
    expect(corrected?.token.x).toBe(npcX);
  });

  it('lets the DM move anything', async () => {
    const updated = next<{ token: WireToken }>(dmSocket, 'token:updated');
    dmSocket.emit('token:commit', { tokenId: npcTokenId, x: 8, y: 8 });
    expect((await updated)?.token.x).toBe(8);
  });
});

describe('hidden tokens are filtered from the wire', () => {
  let secretId: string;

  beforeAll(async () => {
    const created = next<{ token: WireToken }>(dmSocket, 'token:created');
    dmSocket.emit('token:create', { sceneId, x: 10, y: 10, name: 'Ambusher', hidden: true } as never);
    secretId = (await created)!.token.id;
  });

  it('never sends a hidden token to a player', async () => {
    const playerState = await sceneState(bobSocket, () => dmSocket.emit('scene:activate', { sceneId }));
    const dmState = await sceneState(dmSocket, () => dmSocket.emit('scene:activate', { sceneId }));

    expect(dmState.tokens.some((t) => t.id === secretId)).toBe(true);
    // Absence from the payload, not a flag the client is trusted to respect.
    expect(playerState.tokens.some((t) => t.id === secretId)).toBe(false);
    expect(playerState.tokens.some((t) => t.name === 'Ambusher')).toBe(false);
  });

  it('removes a token from the player board when the DM hides it', async () => {
    const visible = next<{ token: WireToken }>(bobSocket, 'token:created', 2500);
    dmSocket.emit('token:create', { sceneId, x: 11, y: 11, name: 'Guard' } as never);
    const guard = (await visible)?.token;
    expect(guard?.name).toBe('Guard');

    const removal = next<{ tokenId: string }>(bobSocket, 'token:deleted');
    dmSocket.emit('token:update', { tokenId: guard!.id, hidden: true });

    expect((await removal)?.tokenId).toBe(guard!.id);
  });
});

describe('linked tokens write through to the sheet', () => {
  it('updates the actor when a linked token takes damage', async () => {
    const created = next<{ token: WireToken }>(dmSocket, 'token:created');
    dmSocket.emit('token:create', {
      sceneId, actorId: aliceActorId, x: 2, y: 6, ownerUserId: alice.userId,
    } as never);
    const token = (await created)!.token;

    // The actor's prototype defaults to linked for a character.
    await api('PATCH', `/api/actors/${aliceActorId}`, { hpCurrent: 30, hpMax: 30 }, alice.cookie);
    const relinked = next<{ token: WireToken }>(dmSocket, 'token:updated');
    dmSocket.emit('token:update', { tokenId: token.id, actorLinked: true, hp: 30, maxHp: 30 });
    await relinked;

    const damaged = next<{ token: WireToken }>(dmSocket, 'token:updated');
    dmSocket.emit('token:update', { tokenId: token.id, hp: 12 });
    expect((await damaged)?.token.hp).toBe(12);

    const sheet = await api<{ actor: { hpCurrent: number } }>(
      'GET', `/api/actors/${aliceActorId}`, undefined, alice.cookie,
    );
    // The board and the sheet must not be able to disagree.
    expect(sheet.actor.hpCurrent).toBe(12);
  });
});

describe('initiative and damage', () => {
  let pcTokenId: string;
  let orcTokenId: string;

  beforeAll(async () => {
    // A resistant, concentrating orc, so both automation paths get exercised.
    const orc = await api<{ actor: { id: string } }>(
      'POST',
      '/api/actors',
      {
        name: 'Orc',
        type: 'npc',
        campaignId,
        hpMax: 30,
        hpCurrent: 30,
        dex: 12,
        damageModifiers: { resistances: ['fire'], vulnerabilities: [], immunities: ['poison'], conditionImmunities: [] },
      },
      dm.cookie,
    );

    const a = next<{ token: WireToken }>(dmSocket, 'token:created');
    dmSocket.emit('token:create', {
      sceneId, actorId: aliceActorId, x: 1, y: 12, ownerUserId: alice.userId, name: 'Alice PC',
    } as never);
    pcTokenId = (await a)!.token.id;

    const b = next<{ token: WireToken }>(dmSocket, 'token:created');
    dmSocket.emit('token:create', {
      sceneId, actorId: orc.actor.id, x: 3, y: 12, name: 'Orc', conditions: ['concentrating'],
    } as never);
    orcTokenId = (await b)!.token.id;
  });

  it('starts an encounter and rolls initiative server-side', async () => {
    const started = next<{ encounter: WireEncounter | null }>(dmSocket, 'initiative:state');
    dmSocket.emit('encounter:start', { sceneId });
    expect((await started)?.encounter?.round).toBe(1);

    const added = next<{ encounter: WireEncounter | null }>(dmSocket, 'initiative:state');
    dmSocket.emit('initiative:add', { tokenIds: [pcTokenId, orcTokenId], roll: true });

    const encounter = (await added)?.encounter;
    expect(encounter?.entries.length).toBe(2);
    // Rolled, not zero, and within 1d20 + a small modifier.
    for (const entry of encounter!.entries) {
      expect(entry.initiative).toBeGreaterThan(0);
      expect(entry.initiative).toBeLessThanOrEqual(30);
    }
    // Sorted highest first.
    expect(encounter!.entries[0].initiative).toBeGreaterThanOrEqual(encounter!.entries[1].initiative);
  });

  it('refuses to let a player drive the turn order', async () => {
    const failure = next<{ message: string }>(aliceSocket, 'error');
    aliceSocket.emit('turn:next', {});
    expect((await failure)?.message).toMatch(/only the dm/i);
  });

  it('advances turns and rolls into the next round', async () => {
    const first = next<{ encounter: WireEncounter | null }>(dmSocket, 'initiative:state');
    dmSocket.emit('turn:next', {});
    expect((await first)?.encounter?.activeIndex).toBe(1);

    const second = next<{ encounter: WireEncounter | null }>(dmSocket, 'initiative:state');
    dmSocket.emit('turn:next', {});
    const wrapped = (await second)?.encounter;
    expect(wrapped?.activeIndex).toBe(0);
    expect(wrapped?.round).toBe(2);
  });

  it('redacts enemy hit points from players but not from the DM', async () => {
    const forDm = next<{ encounter: WireEncounter | null }>(dmSocket, 'initiative:state');
    const forPlayer = next<{ encounter: WireEncounter | null }>(aliceSocket, 'initiative:state');
    dmSocket.emit('turn:next', {});

    const dmOrc = (await forDm)?.encounter?.entries.find((e) => e.name === 'Orc');
    const playerOrc = (await forPlayer)?.encounter?.entries.find((e) => e.name === 'Orc');

    expect(dmOrc?.hp).toBe(30);
    // Knowing the boss is nearly dead changes how a table plays.
    expect(playerOrc?.hp).toBeNull();
    expect(playerOrc?.hpRedacted).toBe(true);
    // The name is still shown - the player can see something is in the order.
    expect(playerOrc?.name).toBe('Orc');
  });

  it('halves damage the target resists', async () => {
    const applied = next<{ results: { name: string; before: number; after: number; reason: string }[] }>(
      dmSocket, 'damage:applied',
    );
    dmSocket.emit('damage:apply', {
      tokenIds: [orcTokenId], amount: 13, damageType: 'fire', healing: false, halved: false,
    });

    const result = (await applied)?.results[0];
    // 13 fire, resisted, halves to 6 rounding down.
    expect(result?.before).toBe(30);
    expect(result?.after).toBe(24);
    expect(result?.reason).toBe('resistant');
  });

  it('ignores damage the target is immune to', async () => {
    const applied = next<{ results: { after: number; reason: string }[] }>(dmSocket, 'damage:applied');
    dmSocket.emit('damage:apply', {
      tokenIds: [orcTokenId], amount: 20, damageType: 'poison', healing: false, halved: false,
    });

    const result = (await applied)?.results[0];
    expect(result?.reason).toBe('immune');
    expect(result?.after).toBe(24);
  });

  it('writes damage through to a linked sheet', async () => {
    const applied = next<{ results: { after: number }[] }>(dmSocket, 'damage:applied');
    dmSocket.emit('damage:apply', {
      tokenIds: [pcTokenId], amount: 5, damageType: 'slashing', healing: false, halved: false,
    });
    await applied;

    const sheet = await api<{ actor: { hpCurrent: number } }>(
      'GET', `/api/actors/${aliceActorId}`, undefined, alice.cookie,
    );
    // The board and the sheet must not be able to disagree.
    expect(sheet.actor.hpCurrent).toBeLessThan(30);
  });

  it('lets a player damage a monster, and tells them only what it took', async () => {
    // Rolling damage and then asking the DM to retype it is a step nobody
    // enjoys, so a player may subtract from what they are fighting.
    //
    // This used to read `after < before` off a player's own payload, which is
    // the leak rather than the feature: how much a creature has left is the
    // DM's, and watching a blow land only tells you what it dealt.
    const applied = next<{ results: { amount: number; before?: number; after?: number }[] }>(
      aliceSocket,
      'damage:applied',
    );
    aliceSocket.emit('damage:apply', {
      tokenIds: [orcTokenId], amount: 4, damageType: 'slashing', healing: false, halved: false,
    });

    const result = (await applied)?.results[0];
    expect(result).toBeTruthy();
    expect(result!.amount).toBe(4);
    expect(result!.before).toBeUndefined();
    expect(result!.after).toBeUndefined();
  });

  it('refuses to let a player damage a character', async () => {
    // Anybody's character, including their own: hit points for the party are
    // the DM's to take away.
    const failure = next<{ message: string }>(aliceSocket, 'error');
    aliceSocket.emit('damage:apply', {
      tokenIds: [pcTokenId], amount: 999, damageType: 'slashing', healing: false, halved: false,
    });
    expect((await failure)?.message).toMatch(/only damage monsters/i);
  });

  it('refuses to let a player heal', async () => {
    const failure = next<{ message: string }>(aliceSocket, 'error');
    aliceSocket.emit('damage:apply', {
      tokenIds: [orcTokenId], amount: 10, damageType: '', healing: true, halved: false,
    });
    expect((await failure)?.message).toMatch(/only the dm can heal/i);
  });
});

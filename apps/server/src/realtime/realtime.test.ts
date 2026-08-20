import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import type { WireChatMessage, WirePresence, WireToken } from '@dnd/shared';

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
      { name: 'Ancient Red Dragon', type: 'npc', campaignId },
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
      'POST', '/api/actors', { name: 'Tavern Keeper', type: 'npc', campaignId }, dm.cookie,
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

/**
 * The half of this feature that earns it.
 *
 * A fireball lands on six goblins and that is six saves the DM otherwise rolls
 * by hand. What has to hold: only creatures the DM actually runs, only ones
 * with a stat block behind them, ids scoped to this campaign, and - the one
 * most likely to be silently wrong - the numbers taken from the stat block
 * rather than recomputed off an actor row that says level 1.
 */
describe('group rolls for the creatures the DM runs', () => {
  let sceneId: string;
  let goblinTokens: string[] = [];
  let playerTokenId: string;
  let bareTokenId: string;
  const monsterId = 'test-goblin-monster';

  beforeAll(async () => {
    // A compendium row to stamp from. `srd:import` is the only other way to
    // get one, and this needs a block whose published numbers are known.
    const { db } = await import('../db/index.js');
    const { srdMonsters } = await import('../db/schema.js');
    await db.insert(srdMonsters).values({
      id: monsterId,
      ruleset: '2014',
      name: 'Test Goblin',
      type: 'humanoid',
      armorClass: 15,
      hitPoints: 7,
      // DEX 14 is +2. The block below publishes +9 and +6, so any number that
      // comes back as 2 is the sheet being recomputed instead of read.
      str: 8, dex: 14, con: 10, int: 10, wis: 8, cha: 8,
      challengeRating: '1/4',
      xp: 50,
      tokenSize: 1,
      data: {
        proficiencies: [
          { value: 9, proficiency: { index: 'saving-throw-dex', name: 'Saving Throw: DEX' } },
          { value: 6, proficiency: { index: 'skill-stealth', name: 'Skill: Stealth' } },
        ],
      },
    } as never);

    const scene = await api<{ scene: { id: string } }>(
      'POST', `/api/campaigns/${campaignId}/scenes`, { name: 'Ambush', gridSize: 70 }, dm.cookie,
    );
    sceneId = scene.scene.id;
    dmSocket.emit('scene:activate', { sceneId });
    await new Promise((r) => setTimeout(r, 300));

    const stamped = await api<{ actor: { id: string } }>(
      'POST', `/api/campaigns/${campaignId}/actors/from-monster`, { monsterId }, dm.cookie,
    );

    for (const x of [2, 3]) {
      const placed = next<{ token: WireToken }>(dmSocket, 'token:created');
      dmSocket.emit('token:create', {
        sceneId, x, y: 2, name: x === 2 ? 'Goblin' : 'Goblin 2', actorId: stamped.actor.id,
      } as never);
      goblinTokens.push((await placed)!.token.id);
    }

    // A player's own token, with a real sheet behind it. The sheet matters:
    // without one this token would be dropped for having nothing to roll from,
    // and the ownership check below would be tested by nothing at all.
    const hers = await api<{ actor: { id: string } }>(
      'POST', '/api/actors', { name: 'Alice Rogue', type: 'character', dex: 16 }, alice.cookie,
    );
    const theirs = next<{ token: WireToken }>(dmSocket, 'token:created');
    dmSocket.emit('token:create', {
      sceneId, x: 8, y: 8, name: 'Alice Rogue', actorId: hers.actor.id, ownerUserId: alice.userId,
    } as never);
    playerTokenId = (await theirs)!.token.id;

    const bare = next<{ token: WireToken }>(dmSocket, 'token:created');
    dmSocket.emit('token:create', { sceneId, x: 9, y: 9, name: 'Rubble' } as never);
    bareTokenId = (await bare)!.token.id;

    await new Promise((r) => setTimeout(r, 300));
  });

  it('rolls one line per creature, under the name on the board', async () => {
    const waiting = next<{ message: WireChatMessage }>(aliceSocket, 'chat:message');
    dmSocket.emit('chat:groupRoll', {
      kind: 'save', key: 'dex', dc: 15, secret: false, who: 'creatures', tokenIds: goblinTokens,
    } as never);

    const group = (await waiting)?.message.groupData;
    expect(group?.rows).toHaveLength(2);
    // The token's name, not the sheet's: five goblins off one stat block are
    // Goblin, Goblin 2, Goblin 3 on the board, and five identical lines would
    // be unreadable.
    expect(group?.rows.map((r) => r.name).sort()).toEqual(['Goblin', 'Goblin 2']);
    expect(group?.dc).toBe(15);
  });

  it('takes the modifier from the stat block, not from the actor row', async () => {
    const waiting = next<{ message: WireChatMessage }>(dmSocket, 'chat:message');
    dmSocket.emit('chat:groupRoll', {
      kind: 'save', key: 'dex', dc: null, secret: false, who: 'creatures', tokenIds: goblinTokens,
    } as never);

    const group = (await waiting)?.message.groupData;
    // +9 published. A stamped monster's actor row carries level 1 and no
    // proficiencies, because a stat line states neither - so recomputing gives
    // DEX +2, which is a plausible number and the wrong one.
    for (const row of group!.rows) expect(row.modifier).toBe(9);
  });

  it('does the same for a published skill', async () => {
    const waiting = next<{ message: WireChatMessage }>(dmSocket, 'chat:message');
    dmSocket.emit('chat:groupRoll', {
      kind: 'skill', key: 'stealth', dc: null, secret: false, who: 'creatures', tokenIds: goblinTokens,
    } as never);

    const group = (await waiting)?.message.groupData;
    for (const row of group!.rows) expect(row.modifier).toBe(6);
  });

  it('falls back to the bare ability where the block publishes nothing', async () => {
    const waiting = next<{ message: WireChatMessage }>(dmSocket, 'chat:message');
    dmSocket.emit('chat:groupRoll', {
      kind: 'save', key: 'wis', dc: null, secret: false, who: 'creatures', tokenIds: goblinTokens,
    } as never);

    // WIS 8 is -1, and a stat line that lists no Wisdom save means exactly
    // that. A real answer, not a failure to find one.
    const group = (await waiting)?.message.groupData;
    for (const row of group!.rows) expect(row.modifier).toBe(-1);
  });

  it('adds the modifier to the die rather than reporting it beside', async () => {
    const waiting = next<{ message: WireChatMessage }>(dmSocket, 'chat:message');
    dmSocket.emit('chat:groupRoll', {
      kind: 'save', key: 'dex', dc: null, secret: false, who: 'creatures', tokenIds: goblinTokens,
    } as never);

    const group = (await waiting)?.message.groupData;
    for (const row of group!.rows) {
      expect(row.dice).toHaveLength(1);
      expect(row.total).toBe(row.dice[0] + row.modifier);
    }
  });

  it('marks each row against the DC, and null without one', async () => {
    const withDc = next<{ message: WireChatMessage }>(dmSocket, 'chat:message');
    dmSocket.emit('chat:groupRoll', {
      kind: 'save', key: 'dex', dc: 15, secret: false, who: 'creatures', tokenIds: goblinTokens,
    } as never);
    for (const row of (await withDc)!.message.groupData!.rows) {
      expect(row.passed).toBe(row.total >= 15);
    }

    const without = next<{ message: WireChatMessage }>(dmSocket, 'chat:message');
    dmSocket.emit('chat:groupRoll', {
      kind: 'save', key: 'dex', dc: null, secret: false, who: 'creatures', tokenIds: goblinTokens,
    } as never);
    for (const row of (await without)!.message.groupData!.rows) {
      expect(row.passed).toBeNull();
    }
  });

  it('refuses to roll a player’s own token for them', async () => {
    const failure = next<{ message: string }>(dmSocket, 'error');
    dmSocket.emit('chat:groupRoll', {
      kind: 'save', key: 'dex', dc: null, secret: false,
      who: 'creatures', tokenIds: [playerTokenId],
    } as never);

    // Rolling the players' dice is the half of this that was cut, and it must
    // not come back through the creature list.
    expect((await failure)?.message).toMatch(/stat block/i);
  });

  it('drops a player’s token from a mixed list rather than rolling it', async () => {
    const waiting = next<{ message: WireChatMessage }>(dmSocket, 'chat:message');
    dmSocket.emit('chat:groupRoll', {
      kind: 'save', key: 'dex', dc: null, secret: false,
      who: 'creatures', tokenIds: [...goblinTokens, playerTokenId],
    } as never);

    const group = (await waiting)?.message.groupData;
    expect(group?.rows).toHaveLength(2);
    expect(group?.rows.some((r) => r.name === 'Alice Rogue')).toBe(false);
  });

  it('skips a token with no sheet behind it', async () => {
    const failure = next<{ message: string }>(dmSocket, 'error');
    dmSocket.emit('chat:groupRoll', {
      kind: 'save', key: 'dex', dc: null, secret: false,
      who: 'creatures', tokenIds: [bareTokenId],
    } as never);

    // There are no ability scores anywhere to roll against.
    expect((await failure)?.message).toMatch(/stat block/i);
  });

  it('does not find a token id from another campaign', async () => {
    const other = await api<{ campaign: { id: string } }>(
      'POST', '/api/campaigns', { name: 'Someone Else’s Table' }, dm.cookie,
    );
    const otherScene = await api<{ scene: { id: string } }>(
      'POST', `/api/campaigns/${other.campaign.id}/scenes`, { name: 'Elsewhere' }, dm.cookie,
    );

    // A real creature, with a real sheet, that this DM genuinely runs - just
    // in another campaign. Anything less and the id would be refused for some
    // other reason and the scoping would be tested by nothing.
    const elsewhere = await api<{ actor: { id: string } }>(
      'POST', '/api/actors', { name: 'Someone Else’s Goblin', type: 'npc', campaignId: other.campaign.id },
      dm.cookie,
    );
    const { db } = await import('../db/index.js');
    const { tokens } = await import('../db/schema.js');
    const strayId = 'stray-token-id-for-scoping';
    await db.insert(tokens).values({
      id: strayId, sceneId: otherScene.scene.id, name: 'Not Yours', x: 1, y: 1,
      actorId: elsewhere.actor.id,
    } as never);

    const failure = next<{ message: string }>(dmSocket, 'error');
    dmSocket.emit('chat:groupRoll', {
      kind: 'save', key: 'dex', dc: null, secret: false, who: 'creatures', tokenIds: [strayId],
    } as never);

    // Room membership authenticates; it does not authorize. The id is looked
    // up through the scene's campaign, so a borrowed one is simply not found.
    expect((await failure)?.message).toMatch(/stat block/i);
  });

  it('keeps a secret creature roll away from the players', async () => {
    const toPlayer = next<{ message: WireChatMessage }>(aliceSocket, 'chat:message', 1200);
    const toDm = next<{ message: WireChatMessage }>(dmSocket, 'chat:message');

    dmSocket.emit('chat:groupRoll', {
      kind: 'save', key: 'dex', dc: null, secret: true, who: 'creatures', tokenIds: goblinTokens,
    } as never);

    expect((await toDm)?.message.groupData?.rows).toHaveLength(2);
    expect(await toPlayer).toBeNull();
  });

  it('still writes the result out as text', async () => {
    const waiting = next<{ message: WireChatMessage }>(dmSocket, 'chat:message');
    dmSocket.emit('chat:groupRoll', {
      kind: 'save', key: 'dex', dc: 15, secret: false, who: 'creatures', tokenIds: goblinTokens,
    } as never);

    // A log written before the column existed, and a client that has not been
    // rebuilt, both still read.
    const body = (await waiting)?.message.body ?? '';
    expect(body).toMatch(/Group DEX saving throw \(DC 15\)/);
    expect(body).toContain('Goblin 2');
  });

  it('files a save in the battle log and a skill check in the conversation', async () => {
    const asSave = next<{ message: WireChatMessage }>(dmSocket, 'chat:message');
    dmSocket.emit('chat:groupRoll', {
      kind: 'save', key: 'dex', dc: 15, secret: false, who: 'creatures', tokenIds: goblinTokens,
    } as never);
    // Beside the damage that follows it, rather than in the other tab.
    expect((await asSave)?.message.combat).toBe(true);

    const asCheck = next<{ message: WireChatMessage }>(dmSocket, 'chat:message');
    dmSocket.emit('chat:groupRoll', {
      kind: 'skill', key: 'stealth', dc: null, secret: false, who: 'creatures', tokenIds: goblinTokens,
    } as never);
    expect((await asCheck)?.message.combat).toBe(false);
  });

  it('refuses to let a player call one for the DM’s monsters', async () => {
    const failure = next<{ message: string }>(aliceSocket, 'error');
    aliceSocket.emit('chat:groupRoll', {
      kind: 'save', key: 'dex', dc: null, secret: false, who: 'creatures', tokenIds: goblinTokens,
    } as never);
    expect((await failure)?.message).toMatch(/only the dm/i);
  });
});

describe('players whisper only when their tokens are adjacent', () => {
  let sceneId: string;
  let aliceTokenId: string;
  let bobTokenId: string;

  beforeAll(async () => {
    const scene = await api<{ scene: { id: string } }>(
      'POST', `/api/campaigns/${campaignId}/scenes`, { name: 'Tavern', gridSize: 70 }, dm.cookie,
    );
    sceneId = scene.scene.id;

    dmSocket.emit('scene:activate', { sceneId });
    await new Promise((r) => setTimeout(r, 300));

    const mine = next<{ token: WireToken }>(dmSocket, 'token:created');
    dmSocket.emit('token:create', {
      sceneId, name: 'Alice PC', x: 5, y: 5, ownerUserId: alice.userId,
    } as never);
    aliceTokenId = (await mine)!.token.id;

    // Adjacent to start with: one square east.
    const theirs = next<{ token: WireToken }>(dmSocket, 'token:created');
    dmSocket.emit('token:create', {
      sceneId, name: 'Bob PC', x: 6, y: 5, ownerUserId: bob.userId,
    } as never);
    bobTokenId = (await theirs)!.token.id;
    await new Promise((r) => setTimeout(r, 300));
  });

  it('delivers between two adjacent players', async () => {
    const bobSees = next<{ message: WireChatMessage }>(bobSocket, 'chat:message');
    aliceSocket.emit('chat:send', {
      body: 'cover me', whisperToUserId: bob.userId, actorId: null,
    });

    expect((await bobSees)?.message.body).toContain('cover me');
  });

  it('counts a diagonal as adjacent', async () => {
    dmSocket.emit('token:commit', { tokenId: bobTokenId, x: 6, y: 6 });
    await new Promise((r) => setTimeout(r, 300));

    const bobSees = next<{ message: WireChatMessage }>(bobSocket, 'chat:message');
    aliceSocket.emit('chat:send', {
      body: 'still close', whisperToUserId: bob.userId, actorId: null,
    });

    expect((await bobSees)?.message.body).toContain('still close');
  });

  it('refuses once they step apart, and delivers to nobody', async () => {
    dmSocket.emit('token:commit', { tokenId: bobTokenId, x: 12, y: 12 });
    await new Promise((r) => setTimeout(r, 400));

    const refusal = next<{ message: string }>(aliceSocket, 'error');
    const bobSees = next<{ message: WireChatMessage }>(bobSocket, 'chat:message', 1200);

    aliceSocket.emit('chat:send', {
      body: 'across the room', whisperToUserId: bob.userId, actorId: null,
    });

    expect((await refusal)?.message).toMatch(/cannot whisper them from here/i);
    // Refused, not downgraded to a public message - which would be far worse
    // than not sending it.
    expect((await bobSees)?.message.body ?? '').not.toContain('across the room');
  });

  it('still lets either of them reach the DM from anywhere', async () => {
    const dmSees = next<{ message: WireChatMessage }>(dmSocket, 'chat:message');
    aliceSocket.emit('chat:send', {
      body: 'a note for you', whisperToUserId: dm.userId, actorId: null,
    });

    expect((await dmSees)?.message.body).toContain('a note for you');
  });

  it('lets the DM whisper a player at any distance', async () => {
    const bobSees = next<{ message: WireChatMessage }>(bobSocket, 'chat:message');
    dmSocket.emit('chat:send', {
      body: 'you notice something', whisperToUserId: bob.userId, actorId: null,
    });

    expect((await bobSees)?.message.body).toContain('you notice something');
  });

  it('refuses a whisper to somebody outside the campaign', async () => {
    // The hole this closed: `whisperToUserId` was never validated, and every
    // socket joins its own personal room regardless of campaign - so an id
    // borrowed from another game received the message.
    const refusal = next<{ message: string }>(aliceSocket, 'error');
    aliceSocket.emit('chat:send', {
      body: 'hello stranger', whisperToUserId: outsider.userId, actorId: null,
    });

    expect((await refusal)?.message).toMatch(/cannot whisper them from here/i);
  });

  it('refuses when the sender has no token on the board at all', async () => {
    dmSocket.emit('token:delete', { tokenId: aliceTokenId });
    await new Promise((r) => setTimeout(r, 300));

    const refusal = next<{ message: string }>(aliceSocket, 'error');
    aliceSocket.emit('chat:send', {
      body: 'where am I', whisperToUserId: bob.userId, actorId: null,
    });

    expect((await refusal)?.message).toMatch(/cannot whisper them from here/i);
  });
});

describe('a socket acts in the campaign it last joined', () => {
  it('does not fall back to whichever room it entered first', async () => {
    // Handlers used to take "the first room in the map", which is arbitrary. The
    // official client closes its socket when the campaign changes, so this was
    // unreachable through the UI -- but room membership authenticates and does
    // not authorize, and a client joining two rooms is the case that rule is for.
    const second = await api<{ campaign: { id: string } }>(
      'POST', '/api/campaigns', { name: 'Second Table' }, dm.cookie,
    );

    dmSocket.emit('campaign:join', { campaignId: second.campaign.id });
    await new Promise((r) => setTimeout(r, 600));

    const landed = await new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 3000);
      dmSocket.once('chat:message', (p: { message: { campaignId: string } }) => {
        clearTimeout(timer);
        resolve(p.message.campaignId);
      });
      dmSocket.emit('chat:send', { body: 'which table is this', whisperToUserId: null, actorId: null });
    });

    expect(landed).toBe(second.campaign.id);

    // And back again, so the socket follows the player rather than a join order.
    dmSocket.emit('campaign:join', { campaignId });
    await new Promise((r) => setTimeout(r, 600));

    const backAgain = await new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 3000);
      dmSocket.once('chat:message', (p: { message: { campaignId: string } }) => {
        clearTimeout(timer);
        resolve(p.message.campaignId);
      });
      dmSocket.emit('chat:send', { body: 'and back', whisperToUserId: null, actorId: null });
    });

    expect(backAgain).toBe(campaignId);
  });
});

/**
 * Campaign content is the DM's.
 *
 * `POST /api/actors` accepted `type: 'npc'` from anyone for the life of the
 * project - the one creation path left open to players, while tokens, scenes
 * and `from-monster` were all gated. Nothing in the UI offered it, which is
 * exactly why it went unnoticed: the check has to be on the server, because
 * the absence of a button is not a permission.
 */
describe('only a DM creates campaign content', () => {
  it('refuses an NPC from a player', async () => {
    await expect(
      api('POST', '/api/actors', { name: 'Smuggled NPC', type: 'npc', campaignId }, alice.cookie),
    ).rejects.toThrow(/Only the DM/i);
  });

  it('refuses an NPC that names no campaign, so there is nothing to authorise against', async () => {
    await expect(
      api('POST', '/api/actors', { name: 'Homeless NPC', type: 'npc' }, alice.cookie),
    ).rejects.toThrow(/needs a campaign/i);
  });

  it('refuses an NPC in a campaign the player does not run', async () => {
    const theirs = await api<{ campaign: { id: string } }>(
      'POST', '/api/campaigns', { name: "Alice's own game" }, alice.cookie,
    );

    // Alice is a DM - of her own campaign. That must not carry over.
    await expect(
      api('POST', '/api/actors', { name: 'Trespasser', type: 'npc', campaignId }, alice.cookie),
    ).rejects.toThrow(/Only the DM/i);

    // ...and she can still make one in the game she does run.
    const mine = await api<{ actor: { id: string; type: string } }>(
      'POST', '/api/actors', { name: 'Her NPC', type: 'npc', campaignId: theirs.campaign.id }, alice.cookie,
    );
    expect(mine.actor.type).toBe('npc');
  });

  it('still lets a player create their own character', async () => {
    const created = await api<{ actor: { type: string } }>(
      'POST', '/api/actors', { name: 'Alice Second', type: 'character' }, alice.cookie,
    );
    expect(created.actor.type).toBe('character');
  });
});

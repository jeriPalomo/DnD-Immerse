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

/** Any token on the board, by id. */
async function boardTokenById(id: string): Promise<WireToken | undefined> {
  const state = await new Promise<{ tokens: WireToken[] } | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 3000);
    dmSocket.once('scene:state', (payload: { tokens: WireToken[] }) => {
      clearTimeout(timer);
      resolve(payload);
    });
    dmSocket.emit('scene:activate', { sceneId });
  });
  return state?.tokens.find((t) => t.id === id);
}

describe('timed effects', () => {
  let goblinId: string;

  beforeAll(async () => {
    const created = next<{ token: WireToken }>(dmSocket, 'token:created');
    dmSocket.emit('token:create', {
      sceneId, name: 'Goblin', x: 4, y: 4, hp: 7, maxHp: 7,
    } as never);
    goblinId = (await created)!.token.id;

    // A fight, so there are rounds for a duration to count against.
    dmSocket.emit('encounter:start', { sceneId });
    await new Promise((r) => setTimeout(r, 300));
    dmSocket.emit('initiative:add', { tokenIds: [tokenId, goblinId], roll: true });
    await new Promise((r) => setTimeout(r, 400));
  });

  it('applies a condition with a countdown', async () => {
    dmSocket.emit('effect:apply', { tokenIds: [goblinId], condition: 'paralyzed', rounds: 2 } as never);
    await new Promise((r) => setTimeout(r, 300));

    const goblin = await boardTokenById(goblinId);
    expect(goblin?.conditions).toContain('paralyzed');
    expect(goblin?.effects[0]?.roundsRemaining).toBe(2);
  });

  it('counts down as the rounds advance', async () => {
    dmSocket.emit('turn:next', {});
    await new Promise((r) => setTimeout(r, 200));
    dmSocket.emit('turn:next', {});
    await new Promise((r) => setTimeout(r, 300));

    // Two turns is one full round with two combatants.
    const goblin = await boardTokenById(goblinId);
    expect(goblin?.effects[0]?.roundsRemaining).toBe(1);
  });

  it('wears off, and says so in the log', async () => {
    // Matched on content, not "the next message": advancing a turn also posts
    // whose turn it is, and that arrives first.
    const announced = new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve(''), 4000);
      const handler = (payload: { message: { body: string } }) => {
        if (!/paralyzed/i.test(payload.message.body)) return;
        clearTimeout(timer);
        dmSocket.off('chat:message', handler);
        resolve(payload.message.body);
      };
      dmSocket.on('chat:message', handler);
    });

    dmSocket.emit('turn:next', {});
    await new Promise((r) => setTimeout(r, 200));
    dmSocket.emit('turn:next', {});
    await new Promise((r) => setTimeout(r, 500));

    const goblin = await boardTokenById(goblinId);
    expect(goblin?.conditions).not.toContain('paralyzed');
    expect(goblin?.effects).toEqual([]);
    expect(await announced).toMatch(/paralyzed expires/i);
  });

  it('lets the DM shorten a running effect', async () => {
    dmSocket.emit('effect:apply', { tokenIds: [goblinId], condition: 'restrained', rounds: 10 } as never);
    await new Promise((r) => setTimeout(r, 300));

    const before = await boardTokenById(goblinId);
    expect(before?.effects[0]?.roundsRemaining).toBe(10);

    dmSocket.emit('effect:update', { effectId: before!.effects[0].id, rounds: 1 } as never);
    await new Promise((r) => setTimeout(r, 300));

    expect((await boardTokenById(goblinId))?.effects[0]?.roundsRemaining).toBe(1);
  });

  it('lets the DM remove one by hand', async () => {
    const current = await boardTokenById(goblinId);
    dmSocket.emit('effect:remove', { effectId: current!.effects[0].id } as never);
    await new Promise((r) => setTimeout(r, 300));

    expect((await boardTokenById(goblinId))?.effects).toEqual([]);
  });

  it('lasts until removed when no duration is given', async () => {
    dmSocket.emit('effect:apply', { tokenIds: [goblinId], condition: 'poisoned', rounds: null } as never);
    await new Promise((r) => setTimeout(r, 300));

    const goblin = await boardTokenById(goblinId);
    expect(goblin?.effects[0]?.roundsRemaining).toBeNull();

    // And is still there several rounds later.
    for (let i = 0; i < 4; i++) {
      dmSocket.emit('turn:next', {});
      await new Promise((r) => setTimeout(r, 120));
    }
    expect((await boardTokenById(goblinId))?.conditions).toContain('poisoned');
  });
});

describe('who may apply a condition', () => {
  let goblinId: string;

  beforeAll(async () => {
    const created = next<{ token: WireToken }>(dmSocket, 'token:created');
    dmSocket.emit('token:create', { sceneId, name: 'Orc', x: 6, y: 6, hp: 15, maxHp: 15 } as never);
    goblinId = (await created)!.token.id;
    await new Promise((r) => setTimeout(r, 200));
  });

  it('lets a player condition a monster', async () => {
    aliceSocket.emit('effect:apply', { tokenIds: [goblinId], condition: 'prone', rounds: null } as never);
    await new Promise((r) => setTimeout(r, 400));

    expect((await boardTokenById(goblinId))?.conditions).toContain('prone');
  });

  it('refuses a player conditioning a character', async () => {
    // The same rule damage follows: whose hit points move, and now whose
    // creature is paralysed, is not a thing one player decides for another.
    const refusal = next<{ message: string }>(aliceSocket, 'error');
    aliceSocket.emit('effect:apply', { tokenIds: [tokenId], condition: 'paralyzed', rounds: null } as never);

    expect((await refusal)?.message).toMatch(/only apply conditions to monsters/i);
    expect((await boardTokenById(tokenId))?.conditions).not.toContain('paralyzed');
  });

  it('refuses a condition it cannot model', async () => {
    const refusal = next<{ message: string }>(dmSocket, 'error');
    dmSocket.emit('effect:apply', { tokenIds: [goblinId], condition: 'bewildered', rounds: null } as never);

    expect((await refusal)?.message).toMatch(/not a condition/i);
  });

  it('lets a player clear one from their own token', async () => {
    dmSocket.emit('effect:apply', { tokenIds: [tokenId], condition: 'frightened', rounds: null } as never);
    await new Promise((r) => setTimeout(r, 300));

    const mine = await boardTokenById(tokenId);
    const frightened = mine!.effects.find((e) => e.statusId === 'frightened');
    expect(frightened).toBeDefined();

    aliceSocket.emit('effect:remove', { effectId: frightened!.id } as never);
    await new Promise((r) => setTimeout(r, 300));

    expect((await boardTokenById(tokenId))?.conditions).not.toContain('frightened');
  });

  it('refuses a player removing one from a monster', async () => {
    const current = await boardTokenById(goblinId);
    const prone = current!.effects.find((e) => e.statusId === 'prone');

    const refusal = next<{ message: string }>(aliceSocket, 'error');
    aliceSocket.emit('effect:remove', { effectId: prone!.id } as never);

    expect((await refusal)?.message).toMatch(/cannot remove/i);
    expect((await boardTokenById(goblinId))?.conditions).toContain('prone');
  });
});

describe('a spell that inflicts a condition applies it', () => {
  let ogreId: string;
  let holdPersonId: string;
  let netId: string;

  beforeAll(async () => {
    const created = next<{ token: WireToken }>(dmSocket, 'token:created');
    dmSocket.emit('token:create', { sceneId, name: 'Ogre', x: 8, y: 8, hp: 59, maxHp: 59 } as never);
    ogreId = (await created)!.token.id;

    // A caster with a known spellcasting ability, so there is a real save DC.
    await api('PATCH', `/api/actors/${actorId}`, { spellcastingAbility: 'wis', wis: 20 }, alice.cookie);

    const spell = await api<{ item: { id: string } }>(
      'POST',
      `/api/actors/${actorId}/items`,
      {
        type: 'spell',
        name: 'Hold Person',
        system: { level: 2, save: { ability: 'wis', halfOnSuccess: false } },
      },
      alice.cookie,
    );
    holdPersonId = spell.item.id;

    // A hand-entered item carries its own condition, since the curated table
    // only knows the SRD.
    const net = await api<{ item: { id: string } }>(
      'POST',
      `/api/actors/${actorId}/items`,
      {
        type: 'weapon',
        name: 'Weighted Net',
        system: {
          damageDice: '1d4',
          appliesConditions: [{ condition: 'restrained', rounds: 3, save: 'str' }],
        },
      },
      alice.cookie,
    );
    netId = net.item.id;
    await new Promise((r) => setTimeout(r, 200));
  });

  it('rolls the save with the TARGET, not the caster', async () => {
    const rolled = next<{ message: { body: string; rollData: { label: string } | null } }>(
      dmSocket,
      'chat:message',
      4000,
    );

    aliceSocket.emit('chat:cardAction', {
      itemId: holdPersonId, actorId, action: 'save', targetTokenId: ogreId,
    } as never);

    const label = (await rolled)?.message.rollData?.label ?? '';
    // The Ogre saves, against Alice's DC - not Alice saving against her own.
    expect(label).toMatch(/^Ogre — WIS save vs Hold Person \(DC \d+\)$/);
  });

  it('applies paralyzed from the curated table when the save fails', async () => {
    // The save is a real d20, so drive it to a certainty: an Ogre has no WIS
    // save bonus worth the name and the DC is pushed out of reach.
    await api('PATCH', `/api/actors/${actorId}`, { wis: 20, level: 20 }, alice.cookie);

    let applied = false;
    for (let attempt = 0; attempt < 25 && !applied; attempt++) {
      aliceSocket.emit('chat:cardAction', {
        itemId: holdPersonId, actorId, action: 'save', targetTokenId: ogreId,
      } as never);
      await new Promise((r) => setTimeout(r, 200));
      applied = Boolean((await boardTokenById(ogreId))?.conditions.includes('paralyzed'));
    }

    expect(applied).toBe(true);

    // 10 rounds, straight from SPELL_CONDITIONS, and nobody typed it in.
    const ogre = await boardTokenById(ogreId);
    const effect = ogre!.effects.find((e) => e.statusId === 'paralyzed');
    expect(effect?.roundsRemaining).toBe(10);
  });

  it('uses a hand-entered item own condition and duration', async () => {
    let applied = false;
    for (let attempt = 0; attempt < 25 && !applied; attempt++) {
      aliceSocket.emit('chat:cardAction', {
        itemId: netId, actorId, action: 'save', targetTokenId: ogreId,
      } as never);
      await new Promise((r) => setTimeout(r, 200));
      applied = Boolean((await boardTokenById(ogreId))?.conditions.includes('restrained'));
    }

    expect(applied).toBe(true);
    const ogre = await boardTokenById(ogreId);
    expect(ogre!.effects.find((e) => e.statusId === 'restrained')?.roundsRemaining).toBe(3);
  });

  it('will not condition another character from a player spell', async () => {
    // Alice casting at her own party. The save still rolls and is posted; the
    // application is the DM's, which is the same line damage:apply draws.
    for (let attempt = 0; attempt < 6; attempt++) {
      aliceSocket.emit('chat:cardAction', {
        itemId: holdPersonId, actorId, action: 'save', targetTokenId: tokenId,
      } as never);
      await new Promise((r) => setTimeout(r, 200));
    }

    expect((await boardTokenById(tokenId))?.conditions).not.toContain('paralyzed');
  });
});

describe('the DM can correct the tracker', () => {
  let entryId: string;
  let encounterId: string;

  async function tracker(): Promise<{ id: string; entries: { id: string; name: string; initiative: number }[] }> {
    return new Promise((resolve) => {
      dmSocket.once('initiative:state', (payload: { encounter: never }) => resolve(payload.encounter));
      dmSocket.emit('turn:next', {});
    });
  }

  beforeAll(async () => {
    const state = await tracker();
    encounterId = state.id;
    entryId = state.entries[0].id;
  });

  it('changes a mistyped initiative', async () => {
    // 71 for 17, the classic. Before this was wired there was no way back.
    dmSocket.emit('initiative:update', {
      encounterId,
      entries: [{ id: entryId, initiative: 3, sortOrder: 0 }],
    } as never);
    await new Promise((r) => setTimeout(r, 300));

    const state = await tracker();
    expect(state.entries.find((e) => e.id === entryId)?.initiative).toBe(3);
  });

  it('sets the round', async () => {
    dmSocket.emit('initiative:update', { encounterId, round: 7 } as never);
    await new Promise((r) => setTimeout(r, 300));

    const state = (await tracker()) as unknown as { round: number };
    expect(state.round).toBeGreaterThanOrEqual(7);
  });

  it('refuses a player', async () => {
    const refusal = next<{ message: string }>(aliceSocket, 'error');
    aliceSocket.emit('initiative:update', {
      encounterId,
      entries: [{ id: entryId, initiative: 30, sortOrder: 0 }],
    } as never);

    expect((await refusal)?.message).toMatch(/only the dm/i);
  });

  it('ignores an encounter id from another campaign', async () => {
    // Scoped through `encounters.campaignId`. Room membership says which games
    // this socket is in, never which one an id came from.
    dmSocket.emit('initiative:update', {
      encounterId: 'not-this-campaign',
      entries: [{ id: entryId, initiative: 99, sortOrder: 0 }],
    } as never);
    await new Promise((r) => setTimeout(r, 300));

    const state = await tracker();
    expect(state.entries.find((e) => e.id === entryId)?.initiative).not.toBe(99);
  });
});

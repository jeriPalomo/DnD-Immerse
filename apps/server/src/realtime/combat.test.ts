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
      'POST', '/api/actors', { name: 'DM NPC', type: 'npc', campaignId, hpMax: 10, hpCurrent: 0 }, dm.cookie,
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

/** Every number anywhere in a payload, keys and strings ignored. */
function numbersInPayload(value: unknown, found: number[] = []): number[] {
  if (typeof value === 'number') found.push(value);
  else if (Array.isArray(value)) for (const item of value) numbersInPayload(item, found);
  else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) numbersInPayload(item, found);
  }
  return found;
}

/**
 * Damage tells the table what landed, never what is left.
 *
 * `damage:applied` used to carry `before` and `after` to the whole campaign
 * room, and the initiative tracker rendered them - so a player watching a fight
 * read an enemy's exact hit points off their own screen, which is the one thing
 * every other payload in this app is careful to redact. Watching a blow land
 * tells you what it took; it does not tell you how much the creature had left.
 */
describe('applied damage does not leak the pool', () => {
  let ogreId: string;

  beforeAll(async () => {
    const created = next<{ token: WireToken }>(dmSocket, 'token:created');
    dmSocket.emit('token:create', {
      sceneId, name: 'Leak Ogre', x: 9, y: 9, hp: 59, maxHp: 59,
    } as never);
    ogreId = (await created)!.token.id;
  });

  it('tells a player how much was dealt, and not the hit points', async () => {
    const toPlayer = next<{ results: Record<string, unknown>[] }>(aliceSocket, 'damage:applied');
    const toDm = next<{ results: Record<string, unknown>[] }>(dmSocket, 'damage:applied');

    dmSocket.emit('damage:apply', {
      tokenIds: [ogreId], amount: 7, damageType: 'slashing', healing: false, halved: false,
    } as never);

    const seen = (await toPlayer)?.results?.find((r) => r.tokenId === ogreId);
    expect(seen, 'the player is told something landed').toBeTruthy();
    expect(seen!.amount).toBe(7);
    expect(seen!.before).toBeUndefined();
    expect(seen!.after).toBeUndefined();

    // Walked as values rather than searched as text: a JSON search for "59"
    // matches the digits of an id about as often as it matches hit points,
    // which is the flake `visionleak.test.ts` was written to avoid.
    expect(numbersInPayload(seen)).not.toContain(59);
    expect(numbersInPayload(seen)).not.toContain(52);

    // The DM still gets the pool - it is theirs to see.
    const dmSaw = (await toDm)?.results?.find((r) => r.tokenId === ogreId);
    expect(dmSaw!.before).toBe(59);
    expect(dmSaw!.after).toBe(52);
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

  /**
   * Waits for the broadcast the handler itself sends, rather than sleeping and
   * hoping.
   *
   * `initiative:update` ends in `broadcastEncounter`, so the state that comes
   * back IS the applied change. Sleeping a fixed 300ms and then calling
   * `tracker()` raced it two ways: socket.io does not await a listener, so the
   * update's write could still be in flight, and `tracker()` reads by emitting
   * `turn:next` - a second event that advances the turn while the first is
   * unfinished. Under load that read the round before the update landed and
   * the test failed with "expected 6 to be greater than or equal to 7".
   */
  function afterUpdate(): Promise<{ round: number; entries: { id: string; initiative: number }[] }> {
    return new Promise((resolve) => {
      dmSocket.once('initiative:state', (payload: { encounter: never }) => resolve(payload.encounter));
    });
  }

  it('changes a mistyped initiative', async () => {
    // 71 for 17, the classic. Before this was wired there was no way back.
    const applied = afterUpdate();
    dmSocket.emit('initiative:update', {
      encounterId,
      entries: [{ id: entryId, initiative: 3, sortOrder: 0 }],
    } as never);

    const state = await applied;
    expect(state.entries.find((e) => e.id === entryId)?.initiative).toBe(3);
  });

  it('sets the round', async () => {
    const applied = afterUpdate();
    dmSocket.emit('initiative:update', { encounterId, round: 7 } as never);

    // Exactly 7, not "at least": nothing advances the turn now, where reading
    // through `tracker()` used to move it on and could tip into the next round.
    const state = await applied;
    expect(state.round).toBe(7);
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

describe('the card offers a save wherever one is forced', () => {
  let netId: string;
  let webId: string;
  let ogreId: string;

  beforeAll(async () => {
    const created = next<{ token: WireToken }>(dmSocket, 'token:created');
    dmSocket.emit('token:create', { sceneId, name: 'Troll', x: 12, y: 2, hp: 84, maxHp: 84 } as never);
    ogreId = (await created)!.token.id;

    const net = await api<{ item: { id: string } }>(
      'POST', `/api/actors/${actorId}/items`,
      {
        type: 'weapon',
        name: 'Net',
        system: {
          damageDice: '1d4', ability: 'dex',
          appliesConditions: [{ condition: 'restrained', rounds: null, save: 'str' }],
        },
      },
      alice.cookie,
    );
    netId = net.item.id;

    // Web as the SRD actually ships it: no `save` blob at all. The curated
    // table is the only thing that knows it forces a DEX save.
    const web = await api<{ item: { id: string } }>(
      'POST', `/api/actors/${actorId}/items`,
      { type: 'spell', name: 'Web', system: { level: 2, save: null } },
      alice.cookie,
    );
    webId = web.item.id;
    await new Promise((r) => setTimeout(r, 200));
  });

  /** The card as it is posted to the log. */
  async function cardFor(itemId: string) {
    const posted = new Promise<{ actions: string[]; saveAbility: string | null; saveDC: number | null }>(
      (resolve) => {
        const timer = setTimeout(() => resolve({ actions: [], saveAbility: null, saveDC: null }), 3000);
        const handler = (p: { message: { cardData: never } }) => {
          if (!p.message.cardData) return;
          clearTimeout(timer);
          dmSocket.off('chat:message', handler);
          resolve(p.message.cardData);
        };
        dmSocket.on('chat:message', handler);
      },
    );
    aliceSocket.emit('chat:card', { itemId, actorId, targetTokenId: ogreId, longRange: false } as never);
    return posted;
  }

  it('gives a weapon that inflicts something a Save button', async () => {
    // Without this the appliesConditions field on a weapon was decorative:
    // the form could set it and no card could ever fire it.
    const card = await cardFor(netId);
    expect(card.actions).toContain('save');
    expect(card.saveAbility).toBe('str');
    expect(card.saveDC).toBeGreaterThan(8);
  });

  it('gives a spell the SRD ships with no dc block one too', async () => {
    const card = await cardFor(webId);
    expect(card.actions).toContain('save');
    expect(card.saveAbility).toBe('dex');
  });

  it('rolls against the DC the card printed', async () => {
    // Two computations of the same number is how a card reading DC 15 ends up
    // compared against 10.
    const card = await cardFor(netId);
    const rolled = new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve(''), 3000);
      const handler = (p: { message: { rollData: { label: string } | null } }) => {
        if (!p.message.rollData?.label?.includes('save vs')) return;
        clearTimeout(timer);
        dmSocket.off('chat:message', handler);
        resolve(p.message.rollData.label);
      };
      dmSocket.on('chat:message', handler);
    });
    aliceSocket.emit('chat:cardAction', {
      itemId: netId, actorId, action: 'save', targetTokenId: ogreId,
    } as never);
    expect(await rolled).toContain(`DC ${card.saveDC}`);
  });

  it('leaves an item that forces nothing without one', async () => {
    const plain = await api<{ item: { id: string } }>(
      'POST', `/api/actors/${actorId}/items`,
      { type: 'weapon', name: 'Club', system: { damageDice: '1d4' } },
      alice.cookie,
    );
    const card = await cardFor(plain.item.id);
    expect(card.actions).not.toContain('save');
  });
});

describe('a partial payload does not throw', () => {
  it('ignores an effect:update that changes nothing', async () => {
    // db.update().set({}) throws "No values to set". wall:update had exactly
    // this bug once already.
    const created = next<{ token: WireToken }>(dmSocket, 'token:created');
    dmSocket.emit('token:create', { sceneId, name: 'Kobold', x: 14, y: 2, hp: 5, maxHp: 5 } as never);
    const kobold = (await created)!.token.id;

    dmSocket.emit('effect:apply', { tokenIds: [kobold], condition: 'prone', rounds: null } as never);
    await new Promise((r) => setTimeout(r, 400));

    const before = await boardTokenById(kobold);
    const effectId = before!.effects[0].id;

    const failure = next<{ message: string }>(dmSocket, 'error', 1200);
    dmSocket.emit('effect:update', { effectId } as never);
    await new Promise((r) => setTimeout(r, 400));

    expect(await failure).toBeNull();
    expect((await boardTokenById(kobold))?.conditions).toContain('prone');
  });

  it('ignores an empty item patch instead of returning a 500', async () => {
    const made = await api<{ item: { id: string } }>(
      'POST', `/api/actors/${actorId}/items`,
      { type: 'weapon', name: 'Dagger', system: { damageDice: '1d4' } },
      alice.cookie,
    );
    const patched = await api<{ item: { name: string } }>(
      'PATCH', `/api/items/${made.item.id}`, {}, alice.cookie,
    );
    expect(patched.item.name).toBe('Dagger');
  });
});

describe('range is measured when the button is pressed', () => {
  let bowId: string;
  let farId: string;

  beforeAll(async () => {
    const created = next<{ token: WireToken }>(dmSocket, 'token:created');
    dmSocket.emit('token:create', { sceneId, name: 'Archer target', x: 20, y: 2, hp: 9, maxHp: 9 } as never);
    farId = (await created)!.token.id;

    const bow = await api<{ item: { id: string } }>(
      'POST', `/api/actors/${actorId}/items`,
      {
        type: 'weapon', name: 'Longbow',
        system: { damageDice: '1d8', ability: 'dex', range: { type: 'ranged', value: 30, long: 300 } },
      },
      alice.cookie,
    );
    bowId = bow.item.id;
    await new Promise((r) => setTimeout(r, 200));
  });

  /** The label of the next attack roll, which names the mode and why. */
  async function attackLabel(targetTokenId: string): Promise<string> {
    const rolled = new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve(''), 3000);
      const handler = (p: { message: { rollData: { label: string } | null } }) => {
        if (!p.message.rollData?.label?.includes('attack')) return;
        clearTimeout(timer);
        dmSocket.off('chat:message', handler);
        resolve(p.message.rollData.label);
      };
      dmSocket.on('chat:message', handler);
    });
    aliceSocket.emit('chat:cardAction', {
      itemId: bowId, actorId, action: 'attack', targetTokenId,
    } as never);
    return rolled;
  }

  it('takes disadvantage on a shot beyond normal range', async () => {
    // Alice is at (2,2), the target at (20,2): 90 ft, past a longbow's 30.
    const label = await attackLabel(farId);
    expect(label).toMatch(/at disadvantage.*beyond normal range/);
    // And it says who is shooting at whom, which a bare item name never did.
    expect(label).toMatch(/Alice PC attacks .* with Longbow/);
  });

  it('drops it once the target closes, without reposting the card', async () => {
    // The client used to send this with the card, freezing it at posting time:
    // step into melee before pressing Attack and the roll still carried it.
    dmSocket.emit('token:commit', { tokenId: farId, x: 4, y: 2 });
    await new Promise((r) => setTimeout(r, 500));

    const label = await attackLabel(farId);
    expect(label).not.toMatch(/beyond normal range/);
    expect(label).not.toMatch(/disadvantage/);
  });
});

describe('a card cannot claim a target from another campaign', () => {
  let anyItemId: string;

  beforeAll(async () => {
    const made = await api<{ item: { id: string } }>(
      'POST', `/api/actors/${actorId}/items`,
      { type: 'weapon', name: 'Sling', system: { damageDice: '1d4' } },
      alice.cookie,
    );
    anyItemId = made.item.id;
  });

  it('drops an id the campaign does not own', async () => {
    const posted = new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 3000);
      const handler = (p: { message: { cardData: { targetTokenId: string | null } | null } }) => {
        if (!p.message.cardData) return;
        clearTimeout(timer);
        dmSocket.off('chat:message', handler);
        resolve(p.message.cardData.targetTokenId);
      };
      dmSocket.on('chat:message', handler);
    });

    aliceSocket.emit('chat:card', {
      itemId: anyItemId, actorId, targetTokenId: 'borrowed-from-another-table',
    } as never);

    expect(await posted).toBeNull();
  });
});

/**
 * One swing is one message, and it says where every number came from.
 *
 * The verdict used to be a sentence appended to the roll's label and the damage
 * a second message underneath, which meant the answer to "did it hit" could
 * only be had by parsing prose, and the two halves of one action could be
 * separated by anything else the table rolled in between.
 */
describe('an attack is one message, and says what it did', () => {
  let swordId: string;
  let boltId: string;
  let dummyId: string;

  /** Fires the attack and returns the structured result. */
  async function swing(itemId: string, targetTokenId: string, versatile = false) {
    const posted = new Promise<any>((resolve) => {
      const timer = setTimeout(() => resolve(null), 4000);
      const handler = (p: { message: { attackData: unknown } }) => {
        if (!p.message.attackData) return;
        clearTimeout(timer);
        dmSocket.off('chat:message', handler);
        resolve(p.message);
      };
      dmSocket.on('chat:message', handler);
    });

    aliceSocket.emit('chat:cardAction', {
      itemId, actorId, action: 'attack', targetTokenId, versatile,
    } as never);
    return posted;
  }

  /**
   * Swings until one lands.
   *
   * The dummy's AC of 1 is not enough on its own: a natural 1 misses whatever
   * the numbers say, which is a one-in-twenty flake on every test below that
   * needs a hit to inspect. Retrying is honest here because the thing under
   * test is what a *hit* carries, not how often one happens - and a suite that
   * fails a few runs in a hundred for no reason is worse than no suite, since
   * the usual response to a flake is to stop believing it.
   */
  async function swingUntilHit(itemId: string, targetTokenId: string, versatile = false) {
    for (let attempt = 0; attempt < 20; attempt++) {
      const message = await swing(itemId, targetTokenId, versatile);
      if (!message) continue;
      const { outcome } = message.attackData;
      if (outcome === 'hit' || outcome === 'critical') return message;
    }
    throw new Error('twenty swings at AC 1 and none landed');
  }

  beforeAll(async () => {
    // Strength 8 is a -1 modifier, and an AC of 1 makes every swing land - so
    // the damage expression is the only variable left in the check below.
    //
    // The level is set here rather than assumed: an earlier suite in this file
    // pushes the actor to level 20 to force a save, and proficiency rides on
    // it - so a test written against the level in `beforeAll` reads +6 where it
    // expected +3 and blames the wrong thing.
    await api(
      'PATCH', `/api/actors/${actorId}`,
      { str: 8, int: 18, level: 5, spellcastingAbility: 'int' },
      alice.cookie,
    );

    const created = next<{ token: WireToken }>(dmSocket, 'token:created');
    dmSocket.emit('token:create', {
      sceneId, name: 'Practice dummy', x: 3, y: 2, hp: 200, maxHp: 200, ac: 1,
    } as never);
    dummyId = (await created)!.token.id;

    const sword = await api<{ item: { id: string } }>(
      'POST', `/api/actors/${actorId}/items`,
      {
        type: 'weapon', name: 'Longsword',
        system: { damageDice: '1d8', damageType: 'slashing', versatile: true, versatileDice: '1d10' },
      },
      alice.cookie,
    );
    swordId = sword.item.id;

    const bolt = await api<{ item: { id: string } }>(
      'POST', `/api/actors/${actorId}/items`,
      {
        type: 'spell', name: 'Fire Bolt',
        system: { level: 0, attackRoll: true, damageDice: '1d10', damageType: 'fire' },
      },
      alice.cookie,
    );
    boltId = bolt.item.id;
    await new Promise((r) => setTimeout(r, 200));
  });

  it('carries the damage inside the swing that landed it', async () => {
    const message = await swingUntilHit(swordId, dummyId);
    const attack = message.attackData;

    expect(attack.weapon).toBe('Longsword');
    expect(attack.target).toBe('Practice dummy');
    // The creature it applies to travels with it, so a hit three messages ago
    // still lands on the right goblin.
    expect(attack.damage?.tokenId).toBe(dummyId);
    expect(attack.damage?.type).toBe('slashing');
  });

  it('spells out where the to-hit bonus came from', async () => {
    const message = await swing(swordId, dummyId);
    // A -1 from Strength 8 and +3 of proficiency at level 5. Named rather than
    // summed, because `+2` on its own is a number a player cannot check.
    expect(message.attackData.toHitParts).toEqual([
      { label: 'STR', value: -1 },
      { label: 'proficiency', value: 3 },
    ]);
  });

  it('rolls the two-handed dice when the swing was two-handed, and says so', async () => {
    // The die SIZE is the thing under test, and the count is not: a critical
    // doubles the dice, so a two-handed crit reads `2d10-1` and asserting on
    // `1d10` fails one run in twenty on a test that is right.
    const oneHanded = await swingUntilHit(swordId, dummyId, false);
    expect(oneHanded.attackData.damage.roll.expression).toMatch(/^\d*d8/);
    expect(oneHanded.attackData.damage.twoHanded).toBe(false);

    const twoHanded = await swingUntilHit(swordId, dummyId, true);
    expect(twoHanded.attackData.damage.roll.expression).toMatch(/^\d*d10/);
    expect(twoHanded.attackData.damage.twoHanded).toBe(true);
  });

  /**
   * The bug this test exists for: a spell that rolled to hit chained into
   * `damageExpression` with the spell's own blob, where `ability` is absent and
   * therefore defaults to `str`. Every Fire Bolt that landed rolled the
   * wizard's *Strength* modifier into its damage - a penalty, for a wizard.
   */
  it('adds no ability modifier to a spell that hits', async () => {
    const message = await swingUntilHit(boltId, dummyId);
    // The published dice and nothing else: no +INT, and emphatically no -1
    // from Strength. Anchored at both ends so a trailing modifier fails it,
    // while leaving the count free - a critical doubles the dice.
    expect(message.attackData.damage.roll.expression).toMatch(/^\d*d10$/);
    expect(message.attackData.damage.parts).toEqual([]);
  });

  it('offers no two-handed button, and reports the grip as a number instead', async () => {
    const carded = new Promise<any>((resolve) => {
      const timer = setTimeout(() => resolve(null), 4000);
      const handler = (p: { message: { cardData: unknown } }) => {
        if (!p.message.cardData) return;
        clearTimeout(timer);
        dmSocket.off('chat:message', handler);
        resolve(p.message.cardData);
      };
      dmSocket.on('chat:message', handler);
    });
    aliceSocket.emit('chat:card', { itemId: swordId, actorId, targetTokenId: dummyId } as never);

    const card = await carded;
    expect(card.actions).not.toContain('versatile');
    expect(card.numbers.versatileDice).toBe('1d10');
    // What the button will roll, printed before it is pressed: -1 and +3.
    expect(card.numbers.toHit).toBe(2);
    expect(card.numbers.damageDice).toBe('1d8');
  });
});

/**
 * A blow that landed takes the hit points, and says so without saying how many
 * are left.
 */
describe('a landed attack applies its own damage', () => {
  let clubId: string;
  let dummyId: string;

  beforeAll(async () => {
    await api('PATCH', `/api/actors/${actorId}`, { str: 10, level: 5 }, alice.cookie);

    const created = next<{ token: WireToken }>(dmSocket, 'token:created');
    dmSocket.emit('token:create', {
      sceneId, name: 'Straw dummy', x: 5, y: 5, hp: 500, maxHp: 500, ac: 1,
    } as never);
    dummyId = (await created)!.token.id;

    const club = await api<{ item: { id: string } }>(
      'POST', `/api/actors/${actorId}/items`,
      { type: 'weapon', name: 'Club', system: { damageDice: '1d4', damageType: 'bludgeoning' } },
      alice.cookie,
    );
    clubId = club.item.id;
    await new Promise((r) => setTimeout(r, 200));
  });

  /** Swings until one lands, and returns the attack and the board after it. */
  async function landOne() {
    for (let attempt = 0; attempt < 20; attempt++) {
      const posted = new Promise<any>((resolve) => {
        const timer = setTimeout(() => resolve(null), 4000);
        const handler = (p: { message: { attackData: unknown } }) => {
          if (!p.message.attackData) return;
          clearTimeout(timer);
          dmSocket.off('chat:message', handler);
          resolve(p.message);
        };
        dmSocket.on('chat:message', handler);
      });

      aliceSocket.emit('chat:cardAction', {
        itemId: clubId, actorId, action: 'attack', targetTokenId: dummyId,
      } as never);

      const message = await posted;
      if (!message) continue;
      const { outcome } = message.attackData;
      if (outcome === 'hit' || outcome === 'critical') {
        await new Promise((r) => setTimeout(r, 500));
        return message;
      }
    }
    throw new Error('twenty swings at AC 1 and none landed');
  }

  it('takes the hit points off without being asked', async () => {
    const before = (await boardTokenById(dummyId))!.hp!;
    const message = await landOne();

    expect(message.attackData.damage.applied).toBe(true);
    const after = (await boardTokenById(dummyId))!.hp!;
    expect(before - after).toBe(message.attackData.damage.roll.total);
  });

  /**
   * The line the whole table reads used to end `— 2/7`, which is the exact
   * number the `damage:applied` payload three lines above goes to some trouble
   * to redact for players. Watching a blow land says what it took, never what
   * is left.
   */
  it('says what it took and not what is left', async () => {
    const posted = new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve(''), 5000);
      const handler = (p: { message: { kind: string; body: string } }) => {
        if (p.message.kind !== 'system' || !/takes/.test(p.message.body)) return;
        clearTimeout(timer);
        aliceSocket.off('chat:message', handler);
        resolve(p.message.body);
      };
      aliceSocket.on('chat:message', handler);
    });

    await landOne();
    const body = await posted;

    expect(body).toMatch(/Straw dummy takes \d+ damage/);
    // No `12/500`, and no bare "of" either - nothing that reports the pool.
    expect(body).not.toMatch(/\d+\s*\/\s*\d+/);
  });
});

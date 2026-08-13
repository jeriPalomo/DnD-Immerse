import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import type { WireAmbientSound, WireAudioState, WireTemplate } from '@dnd/shared';

/**
 * Audio, templates and the journal.
 *
 * The journal sharing test is the important one: an unshared entry must be
 * absent from a player's payload, the same invariant as hidden tokens and wall
 * geometry. It was verified once by hand; this stops it regressing quietly.
 */

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dnd-ambience-'));
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

/** Uploads a small silent WAV, exercising the real audio upload path. */
async function uploadTrack(playlistId: string, cookie: string): Promise<{ id: string; fileUrl: string }> {
  const header = Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.from(new Uint32Array([36 + 800]).buffer),
    Buffer.from('WAVEfmt '),
    Buffer.from(new Uint32Array([16]).buffer),
    Buffer.from(new Uint16Array([1, 1]).buffer),
    Buffer.from(new Uint32Array([8000, 8000]).buffer),
    Buffer.from(new Uint16Array([1, 8]).buffer),
    Buffer.from('data'),
    Buffer.from(new Uint32Array([800]).buffer),
    Buffer.alloc(800, 128),
  ]);

  const form = new FormData();
  form.append('file', new Blob([header], { type: 'audio/wav' }), 'ambience.wav');

  const response = await fetch(`${baseUrl}/api/playlists/${playlistId}/tracks`, {
    method: 'POST',
    headers: { cookie },
    body: form,
  });
  const payload = (await response.json()) as { error?: string; track: { id: string; fileUrl: string } };
  if (!response.ok) throw new Error(payload.error);
  return payload.track;
}

let dm: Account;
let alice: Account;
let campaignId: string;
let sceneId: string;
let dmSocket: Socket;
let aliceSocket: Socket;
let playlistId: string;
let trackId: string;
let trackUrl: string;

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

  dm = await register('dm@ambience.local', 'DM');
  alice = await register('alice@ambience.local', 'Alice');

  const campaign = await api<{ campaign: { id: string; inviteCode: string } }>(
    'POST', '/api/campaigns', { name: 'Ambience Test' }, dm.cookie,
  );
  campaignId = campaign.campaign.id;
  await api('POST', '/api/campaigns/join', { inviteCode: campaign.campaign.inviteCode }, alice.cookie);

  const scene = await api<{ scene: { id: string } }>(
    'POST', `/api/campaigns/${campaignId}/scenes`, { name: 'Cavern' }, dm.cookie,
  );
  sceneId = scene.scene.id;

  const playlist = await api<{ playlist: { id: string } }>(
    'POST', `/api/campaigns/${campaignId}/playlists`, { name: 'Ambience' }, dm.cookie,
  );
  playlistId = playlist.playlist.id;

  const track = await uploadTrack(playlistId, dm.cookie);
  trackId = track.id;
  trackUrl = track.fileUrl;

  [dmSocket, aliceSocket] = await Promise.all([open(dm), open(alice)]);
  for (const socket of [dmSocket, aliceSocket]) socket.emit('campaign:join', { campaignId });
  await new Promise((r) => setTimeout(r, 700));

  dmSocket.emit('scene:activate', { sceneId });
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

describe('audio upload and playback', () => {
  it('stores an uploaded track under a generated filename', () => {
    expect(trackUrl).toMatch(/^\/uploads\/audio\/[A-Za-z0-9]+\.wav$/);
    // Never the name the user supplied.
    expect(trackUrl).not.toContain('ambience.wav');
  });

  it('rejects a non-audio upload', async () => {
    const form = new FormData();
    form.append('file', new Blob([Buffer.from('not audio')], { type: 'text/plain' }), 'x.txt');

    const response = await fetch(`${baseUrl}/api/playlists/${playlistId}/tracks`, {
      method: 'POST',
      headers: { cookie: dm.cookie },
      body: form,
    });
    expect(response.ok).toBe(false);
  });

  it('broadcasts playback with a server-stamped start time', async () => {
    const waiting = next<WireAudioState>(aliceSocket, 'audio:state');
    dmSocket.emit('audio:control', { playlistId, trackId, playing: true, loop: true });

    const state = await waiting;
    expect(state?.playing).toBe(true);
    expect(state?.trackUrl).toBe(trackUrl);
    // Stamped by the server, not by whichever browser pressed play.
    expect(state?.startedAt).toBeGreaterThan(Date.now() - 10_000);
  });

  it('refuses to let a player control the music', async () => {
    const failure = next<{ message: string }>(aliceSocket, 'error');
    aliceSocket.emit('audio:control', { playlistId, trackId, playing: false, loop: true });
    expect((await failure)?.message).toMatch(/only the dm/i);
  });

  it('stops playback and clears the start time', async () => {
    const waiting = next<WireAudioState>(aliceSocket, 'audio:state');
    dmSocket.emit('audio:control', { playlistId, trackId: null, playing: false, loop: true });

    const state = await waiting;
    expect(state?.playing).toBe(false);
    expect(state?.startedAt).toBeNull();
  });
});

describe('ambient sounds', () => {
  it('reaches players when placed', async () => {
    const waiting = next<{ sounds: WireAmbientSound[] }>(aliceSocket, 'audio:sounds');
    dmSocket.emit('ambient:create', {
      sceneId, name: 'Waterfall', fileUrl: trackUrl, x: 5, y: 5, radius: 8, volume: 0.8, easing: true,
    });

    const payload = await waiting;
    expect(payload?.sounds.some((s) => s.name === 'Waterfall')).toBe(true);
  });

  it('muffles a sound the listener cannot hear directly', async () => {
    // Alice's token on one side of a sound-blocking wall, the sound on the other.
    const actor = await api<{ actor: { id: string } }>(
      'POST', '/api/actors', { name: 'Alice PC' }, alice.cookie,
    );
    await api('POST', `/api/actors/${actor.actor.id}/campaigns/${campaignId}`, {}, alice.cookie);

    const placed = next<{ token: { id: string } }>(dmSocket, 'token:created');
    dmSocket.emit('token:create', {
      sceneId, actorId: actor.actor.id, x: 20, y: 5, ownerUserId: alice.userId, name: 'Alice PC',
    } as never);
    await placed;

    dmSocket.emit('wall:create', {
      sceneId, x1: 12, y1: 0, x2: 12, y2: 12, blocksSight: 1, blocksMovement: 1, blocksSound: 1,
    } as never);
    await new Promise((r) => setTimeout(r, 400));

    const waiting = next<{ sounds: WireAmbientSound[] }>(aliceSocket, 'audio:sounds');
    dmSocket.emit('ambient:create', {
      sceneId, name: 'Forge', fileUrl: trackUrl, x: 2, y: 5, radius: 40, volume: 1,
      easing: true, blockedByWalls: true,
    });

    const forge = (await waiting)?.sounds.find((s) => s.name === 'Forge');
    // Muffled, not silenced: a forge behind a wall is still audible.
    expect(forge?.occlusion).toBeLessThan(1);
    expect(forge?.occlusion).toBeGreaterThan(0);
  });

  it('leaves a sound with a clear path unmuffled', async () => {
    const waiting = next<{ sounds: WireAmbientSound[] }>(aliceSocket, 'audio:sounds');
    dmSocket.emit('ambient:create', {
      sceneId, name: 'Nearby brook', fileUrl: trackUrl, x: 21, y: 5, radius: 20, volume: 1,
      easing: true, blockedByWalls: true,
    });

    const brook = (await waiting)?.sounds.find((s) => s.name === 'Nearby brook');
    expect(brook?.occlusion).toBe(1);
  });

  it('refuses to let a player place one', async () => {
    const failure = next<{ message: string }>(aliceSocket, 'error');
    aliceSocket.emit('ambient:create', {
      sceneId, name: 'Fake', fileUrl: trackUrl, x: 0, y: 0, radius: 5, volume: 1, easing: true,
    });
    expect((await failure)?.message).toMatch(/only the dm/i);
  });
});

describe('area templates', () => {
  let templateId: string;

  it('lets a player place one — aiming a spell is their job', async () => {
    const waiting = next<{ templates: WireTemplate[] }>(dmSocket, 'template:state');
    aliceSocket.emit('template:create', {
      sceneId, shape: 'circle', x: 4, y: 4, direction: 0, distance: 20, width: 5, color: '#4a9eff',
    });

    const payload = await waiting;
    const placed = payload?.templates.find((t) => t.shape === 'circle');
    expect(placed).toBeTruthy();
    expect(placed?.distance).toBe(20);
    expect(placed?.ownerUserId).toBe(alice.userId);
    templateId = placed!.id;
  });

  it('refuses to let a player clear someone else’s template', async () => {
    const mine = next<{ templates: WireTemplate[] }>(dmSocket, 'template:state');
    dmSocket.emit('template:create', {
      sceneId, shape: 'cone', x: 1, y: 1, direction: 0, distance: 15, width: 5, color: '#fff',
    });
    const dmTemplate = (await mine)?.templates.find((t) => t.shape === 'cone');

    const failure = next<{ message: string }>(aliceSocket, 'error');
    aliceSocket.emit('template:delete', { templateId: dmTemplate!.id });
    expect((await failure)?.message).toMatch(/not your template/i);
  });

  it('lets the owner clear their own', async () => {
    const waiting = next<{ templates: WireTemplate[] }>(aliceSocket, 'template:state');
    aliceSocket.emit('template:delete', { templateId });

    const payload = await waiting;
    expect(payload?.templates.some((t) => t.id === templateId)).toBe(false);
  });
});

describe('invariant: unshared journal entries never reach a player', () => {
  let entryId: string;

  beforeAll(async () => {
    const created = await api<{ entry: { id: string; pages: { id: string }[] } }>(
      'POST', `/api/campaigns/${campaignId}/journal`, { title: 'Strahd' }, dm.cookie,
    );
    entryId = created.entry.id;

    await api(
      'PATCH',
      `/api/journal/pages/${created.entry.pages[0].id}`,
      { bodyMarkdown: 'He is vulnerable to sunlight.' },
      dm.cookie,
    );
  });

  const read = (cookie: string) =>
    api<{ entries: { id: string; title: string; shared: boolean; pages: { bodyMarkdown: string }[] }[] }>(
      'GET', `/api/campaigns/${campaignId}/journal`, undefined, cookie,
    );

  it('is absent from the player payload before sharing', async () => {
    const forDm = await read(dm.cookie);
    const forPlayer = await read(alice.cookie);

    expect(forDm.entries.some((e) => e.id === entryId)).toBe(true);

    // Absence, not redaction: the title alone would give the game away.
    expect(forPlayer.entries.some((e) => e.id === entryId)).toBe(false);
    expect(JSON.stringify(forPlayer.entries)).not.toContain('sunlight');
    expect(JSON.stringify(forPlayer.entries)).not.toContain('Strahd');
  });

  it('appears once the DM shows it', async () => {
    await api('POST', `/api/journal/${entryId}/share`, { shared: true }, dm.cookie);

    const forPlayer = await read(alice.cookie);
    const entry = forPlayer.entries.find((e) => e.id === entryId);

    expect(entry).toBeTruthy();
    expect(entry?.pages[0].bodyMarkdown).toContain('sunlight');
  });

  it('disappears again when the DM takes it back', async () => {
    await api('POST', `/api/journal/${entryId}/share`, { shared: false }, dm.cookie);

    const forPlayer = await read(alice.cookie);
    expect(forPlayer.entries.some((e) => e.id === entryId)).toBe(false);
  });

  it('reports share state to the DM, so the button cannot lie', async () => {
    // The UI used to keep this in local state, which read "not shared" after
    // any reload - and clicking then un-shared while claiming the opposite.
    await api('POST', `/api/journal/${entryId}/share`, { shared: true }, dm.cookie);
    const shown = await read(dm.cookie);
    expect(shown.entries.find((e) => e.id === entryId)?.shared).toBe(true);

    await api('POST', `/api/journal/${entryId}/share`, { shared: false }, dm.cookie);
    const hidden = await read(dm.cookie);
    expect(hidden.entries.find((e) => e.id === entryId)?.shared).toBe(false);
  });

  it('shares in a campaign the DM has not filled yet', async () => {
    // The regression: sharedness used to be inferred from ownership grants,
    // which were written per *other* member. A campaign with nobody else in it
    // therefore stored nothing, reported shared: false straight back, and the
    // button appeared to do nothing at all.
    const solo = await api<{ campaign: { id: string } }>(
      'POST', '/api/campaigns', { name: 'Session zero' }, dm.cookie,
    );
    const entry = await api<{ entry: { id: string } }>(
      'POST', `/api/campaigns/${solo.campaign.id}/journal`, { title: 'Prep' }, dm.cookie,
    );

    await api('POST', `/api/journal/${entry.entry.id}/share`, { shared: true }, dm.cookie);

    const read = await api<{ entries: { id: string; shared: boolean }[] }>(
      'GET', `/api/campaigns/${solo.campaign.id}/journal`, undefined, dm.cookie,
    );
    expect(read.entries.find((e) => e.id === entry.entry.id)?.shared).toBe(true);
  });

  it('refuses to let a player write to the journal', async () => {
    await expect(
      api('POST', `/api/campaigns/${campaignId}/journal`, { title: 'Mine' }, alice.cookie),
    ).rejects.toThrow(/only the dm/i);
  });

  it('refuses to let a player share an entry with themselves', async () => {
    await expect(
      api('POST', `/api/journal/${entryId}/share`, { shared: true }, alice.cookie),
    ).rejects.toThrow(/only the dm/i);
  });
});

describe('map pins', () => {
  it('hides an unrevealed pin from players', async () => {
    await api(
      'POST',
      `/api/scenes/${sceneId}/notes`,
      { label: 'Secret door', x: 3, y: 3, hidden: true },
      dm.cookie,
    );

    const forDm = await api<{ notes: { label: string }[] }>(
      'GET', `/api/scenes/${sceneId}/notes`, undefined, dm.cookie,
    );
    const forPlayer = await api<{ notes: { label: string }[] }>(
      'GET', `/api/scenes/${sceneId}/notes`, undefined, alice.cookie,
    );

    expect(forDm.notes.some((n) => n.label === 'Secret door')).toBe(true);
    expect(forPlayer.notes.some((n) => n.label === 'Secret door')).toBe(false);
  });

  it('reveals it when the DM unhides it', async () => {
    const created = await api<{ note: { id: string } }>(
      'POST', `/api/scenes/${sceneId}/notes`, { label: 'Well', x: 6, y: 6, hidden: true }, dm.cookie,
    );
    await api('PATCH', `/api/notes/${created.note.id}`, { hidden: false }, dm.cookie);

    const forPlayer = await api<{ notes: { label: string }[] }>(
      'GET', `/api/scenes/${sceneId}/notes`, undefined, alice.cookie,
    );
    expect(forPlayer.notes.some((n) => n.label === 'Well')).toBe(true);
  });

  it('refuses to let a player place a pin', async () => {
    await expect(
      api('POST', `/api/scenes/${sceneId}/notes`, { label: 'X', x: 0, y: 0 }, alice.cookie),
    ).rejects.toThrow(/only the dm/i);
  });
});

describe('uploads are cleaned up', () => {
  it('removes a deleted image handout from disk', async () => {
    const entry = await api<{ entry: { id: string } }>(
      'POST', `/api/campaigns/${campaignId}/journal`, { title: 'Handout' }, dm.cookie,
    );

    // A 1x1 PNG is enough to exercise the sharp pipeline.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const form = new FormData();
    form.append('file', new Blob([png], { type: 'image/png' }), 'map.png');

    const uploaded = await fetch(`${baseUrl}/api/journal/${entry.entry.id}/pages/image`, {
      method: 'POST', headers: { cookie: dm.cookie }, body: form,
    }).then((r) => r.json() as Promise<{ page: { id: string; fileUrl: string } }>);

    const onDisk = path.join(DATA_DIR, 'uploads', ...uploaded.page.fileUrl.split('/').slice(2));
    expect(fs.existsSync(onDisk)).toBe(true);

    await api('DELETE', `/api/journal/pages/${uploaded.page.id}`, undefined, dm.cookie);
    // Otherwise every replaced handout stays on disk for the life of the server.
    expect(fs.existsSync(onDisk)).toBe(false);
  });

  it('keeps a track file that an ambient emitter still plays', async () => {
    const track = await uploadTrack(playlistId, dm.cookie);
    const onDisk = path.join(DATA_DIR, 'uploads', ...track.fileUrl.split('/').slice(2));

    dmSocket.emit('ambient:create', {
      sceneId, name: 'Keeps playing', fileUrl: track.fileUrl, x: 1, y: 1,
      radius: 5, volume: 1, easing: true, blockedByWalls: false,
    });
    await new Promise((r) => setTimeout(r, 500));

    await api('DELETE', `/api/tracks/${track.id}`, undefined, dm.cookie);

    // Placing a sound copies the URL, so deleting the track must not break it.
    expect(fs.existsSync(onDisk)).toBe(true);
  });

  it('removes a track file nothing references', async () => {
    const track = await uploadTrack(playlistId, dm.cookie);
    const onDisk = path.join(DATA_DIR, 'uploads', ...track.fileUrl.split('/').slice(2));
    expect(fs.existsSync(onDisk)).toBe(true);

    await api('DELETE', `/api/tracks/${track.id}`, undefined, dm.cookie);
    expect(fs.existsSync(onDisk)).toBe(false);
  });
});

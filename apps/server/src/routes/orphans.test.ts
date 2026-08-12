import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Uploaded files are removed with the rows that own them — but never one that
 * something else still points at.
 *
 * Both halves matter. Leaving files behind fills the disk over a campaign;
 * deleting a shared one turns that into broken images, which is worse.
 */

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dnd-orphans-'));
process.env.DATA_DIR = DATA_DIR;
process.env.NODE_ENV = 'test';

let baseUrl: string;
let close: () => Promise<void>;
let cookie: string;

/** A 1x1 PNG, enough to exercise the sharp pipeline. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function api<T>(method: string, route: string, body?: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = (await response.json()) as { error?: string };
  if (!response.ok) throw new Error(payload.error ?? 'request failed');
  return payload as T;
}

async function upload<T>(route: string, filename = 'x.png'): Promise<T> {
  const form = new FormData();
  form.append('file', new Blob([PNG], { type: 'image/png' }), filename);

  const response = await fetch(`${baseUrl}${route}`, { method: 'POST', headers: { cookie }, body: form });
  const payload = (await response.json()) as { error?: string };
  if (!response.ok) throw new Error(payload.error);
  return payload as T;
}

/** Whether an uploaded file is still on disk. */
function onDisk(url: string): boolean {
  return fs.existsSync(path.join(DATA_DIR, 'uploads', ...url.split('/').slice(2)));
}

beforeAll(async () => {
  const { buildApp } = await import('../app.js');
  const { runMigrations } = await import('../db/migrate.js');

  await runMigrations();
  const app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });

  const address = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  close = async () => {
    await app.close();
  };

  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'dm@orphans.local', displayName: 'DM', password: 'password12345' }),
  });
  cookie = (response.headers.get('set-cookie') ?? '').split(';')[0];
}, 60000);

afterAll(async () => {
  await close?.();
  const { client } = await import('../db/index.js');
  client.close();
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {
    // Not worth failing a passing suite over.
  }
});

async function makeCampaign(name: string) {
  const created = await api<{ campaign: { id: string } }>('POST', '/api/campaigns', { name });
  return created.campaign.id;
}

describe('deleting a scene', () => {
  it('takes its map with it', async () => {
    const campaignId = await makeCampaign('Scene cleanup');
    const scene = await api<{ scene: { id: string } }>(
      'POST', `/api/campaigns/${campaignId}/scenes`, { name: 'Cavern' },
    );

    const uploaded = await upload<{ scene: { mapImageUrl: string } }>(
      `/api/scenes/${scene.scene.id}/map`,
      'cavern.png',
    );
    const mapUrl = uploaded.scene.mapImageUrl;
    expect(onDisk(mapUrl)).toBe(true);

    await api('DELETE', `/api/scenes/${scene.scene.id}`);
    // A 25MB map per deleted scene adds up fast.
    expect(onDisk(mapUrl)).toBe(false);
  });
});

describe('deleting a campaign', () => {
  it('takes its banner and every scene map with it', async () => {
    const campaignId = await makeCampaign('Full cleanup');

    const banner = await upload<{ bannerUrl: string }>(`/api/campaigns/${campaignId}/banner`);
    const scene = await api<{ scene: { id: string } }>(
      'POST', `/api/campaigns/${campaignId}/scenes`, { name: 'Hall' },
    );
    const map = await upload<{ scene: { mapImageUrl: string } }>(`/api/scenes/${scene.scene.id}/map`);

    expect(onDisk(banner.bannerUrl)).toBe(true);
    expect(onDisk(map.scene.mapImageUrl)).toBe(true);

    await api('DELETE', `/api/campaigns/${campaignId}`);

    // Rows cascade; files have to be chased deliberately.
    expect(onDisk(banner.bannerUrl)).toBe(false);
    expect(onDisk(map.scene.mapImageUrl)).toBe(false);
  });

  it('leaves a portable character portrait alone', async () => {
    const campaignId = await makeCampaign('Keeps portraits');

    // A player character belongs to its owner, not to any one campaign.
    const actor = await api<{ actor: { id: string } }>('POST', '/api/actors', { name: 'Thorin' });
    const portrait = await upload<{ portraitUrl: string }>(`/api/actors/${actor.actor.id}/portrait`);
    await api('POST', `/api/actors/${actor.actor.id}/campaigns/${campaignId}`, {});

    await api('DELETE', `/api/campaigns/${campaignId}`);

    // The character survives the campaign ending, and so must its portrait.
    expect(onDisk(portrait.portraitUrl)).toBe(true);
  });
});

describe('shared files', () => {
  it('keeps an image two records still point at', async () => {
    const campaignId = await makeCampaign('Shared art');
    const sceneA = await api<{ scene: { id: string } }>(
      'POST', `/api/campaigns/${campaignId}/scenes`, { name: 'A' },
    );
    const sceneB = await api<{ scene: { id: string } }>(
      'POST', `/api/campaigns/${campaignId}/scenes`, { name: 'B' },
    );

    // The same artwork used as the map for two different scenes.
    const first = await upload<{ scene: { mapImageUrl: string } }>(`/api/scenes/${sceneA.scene.id}/map`);
    const url = first.scene.mapImageUrl;

    await api('PATCH', `/api/scenes/${sceneB.scene.id}`, { name: 'B' });
    const { db } = await import('../db/index.js');
    const { scenes } = await import('../db/schema.js');
    const { eq } = await import('drizzle-orm');
    await db.update(scenes).set({ mapImageUrl: url }).where(eq(scenes.id, sceneB.scene.id));

    await api('DELETE', `/api/scenes/${sceneA.scene.id}`);

    // Scene B still uses it, so removing it would leave a broken map.
    expect(onDisk(url)).toBe(true);
  });
});

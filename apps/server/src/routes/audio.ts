import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { db } from '../db/index.js';
import { ambientSounds, playlistTracks, playlists } from '../db/schema.js';
import { HttpError, assertUser, requireAuth, requireDM } from '../auth/guards.js';
import { newId } from '../lib/id.js';
import { deleteUpload, storeAudio } from '../lib/uploads.js';

/** Playlists are DM-authored; players only ever hear the result. */
export async function audioRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.post('/api/campaigns/:campaignId/playlists', async (request) => {
    const user = assertUser(request);
    const { campaignId } = request.params as { campaignId: string };
    await requireDM(campaignId, user.id);

    const input = z
      .object({
        name: z.string().min(1).max(60).default('New playlist'),
        mode: z.enum(['sequential', 'shuffle', 'simultaneous']).default('sequential'),
      })
      .parse(request.body ?? {});

    const playlist = {
      id: newId(),
      campaignId,
      name: input.name,
      mode: input.mode,
      fadeMs: 1500,
      createdAt: Date.now(),
    };

    await db.insert(playlists).values(playlist);
    return { playlist };
  });

  app.patch('/api/playlists/:id', async (request) => {
    const user = assertUser(request);
    const { id } = request.params as { id: string };
    const playlist = await loadPlaylist(id);
    await requireDM(playlist.campaignId, user.id);

    const patch = z
      .object({
        name: z.string().min(1).max(60).optional(),
        mode: z.enum(['sequential', 'shuffle', 'simultaneous']).optional(),
        role: z.enum(['none', 'combat']).optional(),
        fadeMs: z.number().int().min(0).max(10000).optional(),
      })
      .parse(request.body);

    if (Object.keys(patch).length > 0) {
      await db.update(playlists).set(patch).where(eq(playlists.id, id));
    }

    const rows = await db.select().from(playlists).where(eq(playlists.id, id)).limit(1);
    return { playlist: rows[0] };
  });

  app.delete('/api/playlists/:id', async (request) => {
    const user = assertUser(request);
    const { id } = request.params as { id: string };
    const playlist = await loadPlaylist(id);
    await requireDM(playlist.campaignId, user.id);

    await db.delete(playlists).where(eq(playlists.id, id));
    return { ok: true };
  });

  /**
   * Uploads a track. Audio cannot be re-encoded cheaply, so it is validated by
   * MIME type and stored under a generated filename.
   */
  app.post('/api/playlists/:id/tracks', async (request) => {
    const user = assertUser(request);
    const { id } = request.params as { id: string };
    const playlist = await loadPlaylist(id);
    await requireDM(playlist.campaignId, user.id);

    const file = await request.file();
    if (!file) throw new HttpError(400, 'No file uploaded');

    const fileUrl = await storeAudio(await file.toBuffer(), file.mimetype);

    const existing = await db
      .select({ id: playlistTracks.id })
      .from(playlistTracks)
      .where(eq(playlistTracks.playlistId, id));

    const track = {
      id: newId(),
      playlistId: id,
      // Strip the extension so "rain-loop.mp3" reads as "rain-loop".
      name: (file.filename ?? 'Track').replace(/\.[^.]+$/, ''),
      fileUrl,
      volume: 0.7,
      loop: true,
      sortOrder: existing.length,
    };

    await db.insert(playlistTracks).values(track);
    return { track };
  });

  app.patch('/api/tracks/:id', async (request) => {
    const user = assertUser(request);
    const { id } = request.params as { id: string };

    const rows = await db.select().from(playlistTracks).where(eq(playlistTracks.id, id)).limit(1);
    if (!rows[0]) throw new HttpError(404, 'Track not found');

    const playlist = await loadPlaylist(rows[0].playlistId);
    await requireDM(playlist.campaignId, user.id);

    const patch = z
      .object({
        name: z.string().min(1).max(80).optional(),
        volume: z.number().min(0).max(1).optional(),
        loop: z.boolean().optional(),
      })
      .parse(request.body);

    if (Object.keys(patch).length > 0) {
      await db.update(playlistTracks).set(patch).where(eq(playlistTracks.id, id));
    }

    const updated = await db.select().from(playlistTracks).where(eq(playlistTracks.id, id)).limit(1);
    return { track: updated[0] };
  });

  app.delete('/api/tracks/:id', async (request) => {
    const user = assertUser(request);
    const { id } = request.params as { id: string };

    const rows = await db.select().from(playlistTracks).where(eq(playlistTracks.id, id)).limit(1);
    if (!rows[0]) throw new HttpError(404, 'Track not found');

    const playlist = await loadPlaylist(rows[0].playlistId);
    await requireDM(playlist.campaignId, user.id);

    await db.delete(playlistTracks).where(eq(playlistTracks.id, id));

    // An ambient emitter may still be playing this file - placing a sound
    // copies the URL - so only remove it when nothing points at it.
    const stillUsed = await db
      .select({ id: ambientSounds.id })
      .from(ambientSounds)
      .where(eq(ambientSounds.fileUrl, rows[0].fileUrl))
      .limit(1);

    if (stillUsed.length === 0) await deleteUpload(rows[0].fileUrl);
    return { ok: true };
  });

  app.get('/api/campaigns/:campaignId/playlists', async (request) => {
    const user = assertUser(request);
    const { campaignId } = request.params as { campaignId: string };
    await requireDM(campaignId, user.id);

    const lists = await db
      .select()
      .from(playlists)
      .where(eq(playlists.campaignId, campaignId))
      .orderBy(asc(playlists.createdAt));

    const tracks = await db
      .select()
      .from(playlistTracks)
      .orderBy(asc(playlistTracks.sortOrder));

    return {
      playlists: lists.map((list) => ({
        ...list,
        tracks: tracks.filter((track) => track.playlistId === list.id),
      })),
    };
  });
}

async function loadPlaylist(id: string) {
  const rows = await db.select().from(playlists).where(eq(playlists.id, id)).limit(1);
  if (!rows[0]) throw new HttpError(404, 'Playlist not found');
  return rows[0];
}

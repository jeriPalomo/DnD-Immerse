import { asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { campaignRoom } from '@dnd/shared';
import type { FastifyInstance } from 'fastify';
import { db } from '../db/index.js';
import { journalEntries, journalPages, mapNotes, scenes } from '../db/schema.js';
import { HttpError, assertUser, requireAuth, requireDM, requireMembership } from '../auth/guards.js';
import { newId } from '../lib/id.js';
import { deleteUpload, storeImage } from '../lib/uploads.js';

/**
 * The campaign journal and the map pins that open its pages.
 *
 * Sharing is explicit: an entry is DM-only until they show it to the party,
 * recorded as a flag on the entry itself. A pin the DM has not revealed is
 * filtered out of the player payload entirely rather than hidden on the client.
 */
export async function journalRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/api/campaigns/:campaignId/journal', async (request) => {
    const user = assertUser(request);
    const { campaignId } = request.params as { campaignId: string };
    const membership = await requireMembership(campaignId, user.id);

    const entries = await db
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.campaignId, campaignId))
      .orderBy(asc(journalEntries.sortOrder), asc(journalEntries.createdAt));

    if (entries.length === 0) return { entries: [] };

    // Unshared entries are absent from a player's payload, not merely undrawn -
    // the DM's notes on the villain never reach the browser.
    const visible = membership.isDM ? entries : entries.filter((entry) => entry.shared);
    if (visible.length === 0) return { entries: [] };

    // Only the pages of the entries this reader may have. Unscoped, this read
    // every journal page in the database - every campaign's - and leaned on a
    // filter in JavaScript to keep them apart. Nothing leaked, because the
    // filter is correct, but the query is one edit away from being the leak.
    const pages = await db
      .select()
      .from(journalPages)
      .where(inArray(journalPages.entryId, visible.map((entry) => entry.id)))
      .orderBy(asc(journalPages.sortOrder));

    return {
      entries: visible.map((entry) => ({
        ...entry,
        pages: pages.filter((page) => page.entryId === entry.id),
      })),
    };
  });

  app.post('/api/campaigns/:campaignId/journal', async (request) => {
    const user = assertUser(request);
    const { campaignId } = request.params as { campaignId: string };
    await requireDM(campaignId, user.id);

    const input = z
      .object({ title: z.string().min(1).max(120).default('New entry') })
      .parse(request.body ?? {});

    const entry = {
      id: newId(),
      campaignId,
      title: input.title,
      sortOrder: 0,
      createdAt: Date.now(),
    };
    await db.insert(journalEntries).values(entry);

    // An entry with no page is not useful; start it with one.
    const page = {
      id: newId(),
      entryId: entry.id,
      title: input.title,
      type: 'text' as const,
      bodyMarkdown: '',
      fileUrl: null,
      sortOrder: 0,
      updatedAt: Date.now(),
    };
    await db.insert(journalPages).values(page);

    return { entry: { ...entry, pages: [page] } };
  });

  app.patch('/api/journal/pages/:id', async (request) => {
    const user = assertUser(request);
    const { id } = request.params as { id: string };

    const rows = await db.select().from(journalPages).where(eq(journalPages.id, id)).limit(1);
    if (!rows[0]) throw new HttpError(404, 'Page not found');

    const entry = await db
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.id, rows[0].entryId))
      .limit(1);
    if (!entry[0]) throw new HttpError(404, 'Page not found');
    await requireDM(entry[0].campaignId, user.id);

    const patch = z
      .object({
        title: z.string().min(1).max(120).optional(),
        bodyMarkdown: z.string().max(100000).optional(),
      })
      .parse(request.body);

    if (Object.keys(patch).length > 0) {
      await db
        .update(journalPages)
        .set({ ...patch, updatedAt: Date.now() })
        .where(eq(journalPages.id, id));
    }

    const updated = await db.select().from(journalPages).where(eq(journalPages.id, id)).limit(1);
    return { page: updated[0] };
  });

  /**
   * Adds an image page - a map fragment, a portrait, a letter. Sharing works
   * exactly as it does for text, so a handout is revealed deliberately.
   */
  app.post('/api/journal/:id/pages/image', async (request) => {
    const user = assertUser(request);
    const { id } = request.params as { id: string };

    const rows = await db.select().from(journalEntries).where(eq(journalEntries.id, id)).limit(1);
    if (!rows[0]) throw new HttpError(404, 'Entry not found');
    await requireDM(rows[0].campaignId, user.id);

    const file = await request.file();
    if (!file) throw new HttpError(400, 'No file uploaded');

    const stored = await storeImage(await file.toBuffer(), 'handouts', { maxDimension: 2048 });

    const existing = await db
      .select({ id: journalPages.id })
      .from(journalPages)
      .where(eq(journalPages.entryId, id));

    const page = {
      id: newId(),
      entryId: id,
      title: (file.filename ?? 'Image').replace(/\.[^.]+$/, ''),
      type: 'image' as const,
      bodyMarkdown: '',
      fileUrl: stored.url,
      sortOrder: existing.length,
      updatedAt: Date.now(),
    };

    await db.insert(journalPages).values(page);
    return { page };
  });

  app.delete('/api/journal/pages/:id', async (request) => {
    const user = assertUser(request);
    const { id } = request.params as { id: string };

    const rows = await db.select().from(journalPages).where(eq(journalPages.id, id)).limit(1);
    if (!rows[0]) throw new HttpError(404, 'Page not found');

    const entry = await db
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.id, rows[0].entryId))
      .limit(1);
    if (!entry[0]) throw new HttpError(404, 'Page not found');
    await requireDM(entry[0].campaignId, user.id);

    await db.delete(journalPages).where(eq(journalPages.id, id));
    // An image page owns its file outright, so it goes with the page.
    await deleteUpload(rows[0].fileUrl);
    return { ok: true };
  });

  app.delete('/api/journal/:id', async (request) => {
    const user = assertUser(request);
    const { id } = request.params as { id: string };

    const rows = await db.select().from(journalEntries).where(eq(journalEntries.id, id)).limit(1);
    if (!rows[0]) throw new HttpError(404, 'Entry not found');
    await requireDM(rows[0].campaignId, user.id);

    const owned = await db.select().from(journalPages).where(eq(journalPages.entryId, id));
    await db.delete(journalEntries).where(eq(journalEntries.id, id));
    for (const page of owned) await deleteUpload(page.fileUrl);

    return { ok: true };
  });

  /** Shows an entry to the whole party, or takes it back again. */
  app.post('/api/journal/:id/share', async (request) => {
    const user = assertUser(request);
    const { id } = request.params as { id: string };

    const rows = await db.select().from(journalEntries).where(eq(journalEntries.id, id)).limit(1);
    if (!rows[0]) throw new HttpError(404, 'Entry not found');
    await requireDM(rows[0].campaignId, user.id);

    const { shared } = z.object({ shared: z.boolean() }).parse(request.body);

    await db.update(journalEntries).set({ shared }).where(eq(journalEntries.id, id));

    // Players already at the table refetch on this; without it the DM presses
    // show, nothing appears on anyone's screen, and the button takes the blame.
    app.io?.to(campaignRoom(rows[0].campaignId)).emit('journal:changed', {});

    return { ok: true, shared };
  });

  /* ------------------------------------------------------------ map pins */

  app.get('/api/scenes/:sceneId/notes', async (request) => {
    const user = assertUser(request);
    const { sceneId } = request.params as { sceneId: string };

    const scene = await loadScene(sceneId);
    const membership = await requireMembership(scene.campaignId, user.id);

    const rows = await db.select().from(mapNotes).where(eq(mapNotes.sceneId, sceneId));

    // A pin the DM has not revealed is absent, not merely undrawn.
    return { notes: membership.isDM ? rows : rows.filter((note) => !note.hidden) };
  });

  app.post('/api/scenes/:sceneId/notes', async (request) => {
    const user = assertUser(request);
    const { sceneId } = request.params as { sceneId: string };

    const scene = await loadScene(sceneId);
    await requireDM(scene.campaignId, user.id);

    const input = z
      .object({
        label: z.string().max(80).default(''),
        journalPageId: z.string().nullable().default(null),
        x: z.number(),
        y: z.number(),
        hidden: z.boolean().default(true),
      })
      .parse(request.body);

    const note = { id: newId(), sceneId, icon: 'pin', ...input };
    await db.insert(mapNotes).values(note);
    await refreshScene(app, scene.campaignId);
    return { note };
  });

  app.patch('/api/notes/:id', async (request) => {
    const user = assertUser(request);
    const { id } = request.params as { id: string };

    const rows = await db.select().from(mapNotes).where(eq(mapNotes.id, id)).limit(1);
    if (!rows[0]) throw new HttpError(404, 'Note not found');

    const scene = await loadScene(rows[0].sceneId);
    await requireDM(scene.campaignId, user.id);

    const patch = z
      .object({
        label: z.string().max(80).optional(),
        hidden: z.boolean().optional(),
        x: z.number().optional(),
        y: z.number().optional(),
      })
      .parse(request.body);

    if (Object.keys(patch).length > 0) {
      await db.update(mapNotes).set(patch).where(eq(mapNotes.id, id));
    }

    await refreshScene(app, scene.campaignId);
    const updated = await db.select().from(mapNotes).where(eq(mapNotes.id, id)).limit(1);
    return { note: updated[0] };
  });

  app.delete('/api/notes/:id', async (request) => {
    const user = assertUser(request);
    const { id } = request.params as { id: string };

    const rows = await db.select().from(mapNotes).where(eq(mapNotes.id, id)).limit(1);
    if (!rows[0]) throw new HttpError(404, 'Note not found');

    const scene = await loadScene(rows[0].sceneId);
    await requireDM(scene.campaignId, user.id);

    await db.delete(mapNotes).where(eq(mapNotes.id, id));
    await refreshScene(app, scene.campaignId);
    return { ok: true };
  });
}

/** Pushes the scene to every client, so a pin appears without a reload. */
async function refreshScene(app: FastifyInstance, campaignId: string): Promise<void> {
  if (!app.io) return;
  const { broadcastSceneState } = await import('../realtime/scene.js');
  await broadcastSceneState(app.io, campaignId);
}

async function loadScene(sceneId: string) {
  const rows = await db.select().from(scenes).where(eq(scenes.id, sceneId)).limit(1);
  if (!rows[0]) throw new HttpError(404, 'Scene not found');
  return rows[0];
}

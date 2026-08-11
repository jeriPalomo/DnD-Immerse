import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { db } from '../db/index.js';
import {
  campaignMembers,
  journalEntries,
  journalPages,
  mapNotes,
  ownership,
  scenes,
} from '../db/schema.js';
import { HttpError, assertUser, requireAuth, requireDM, requireMembership } from '../auth/guards.js';
import { newId } from '../lib/id.js';

/**
 * The campaign journal and the map pins that open its pages.
 *
 * Sharing is explicit: an entry is DM-only until they show it to the party,
 * recorded in the same ownership table actors use. A pin the DM has not
 * revealed is filtered out of the player payload entirely rather than hidden
 * on the client.
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

    const pages = await db.select().from(journalPages).orderBy(asc(journalPages.sortOrder));

    let visible = entries;
    if (!membership.isDM) {
      const grants = await db
        .select({ documentId: ownership.documentId })
        .from(ownership)
        .where(and(eq(ownership.documentType, 'journal'), eq(ownership.userId, user.id)));

      const shared = new Set(grants.map((grant) => grant.documentId));
      visible = entries.filter((entry) => shared.has(entry.id));
    }

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
      folder: '',
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

  app.delete('/api/journal/:id', async (request) => {
    const user = assertUser(request);
    const { id } = request.params as { id: string };

    const rows = await db.select().from(journalEntries).where(eq(journalEntries.id, id)).limit(1);
    if (!rows[0]) throw new HttpError(404, 'Entry not found');
    await requireDM(rows[0].campaignId, user.id);

    await db.delete(journalEntries).where(eq(journalEntries.id, id));
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

    const members = await db
      .select({ userId: campaignMembers.userId })
      .from(campaignMembers)
      .where(eq(campaignMembers.campaignId, rows[0].campaignId));

    for (const member of members) {
      if (member.userId === user.id) continue;

      if (shared) {
        await db
          .insert(ownership)
          .values({ documentType: 'journal', documentId: id, userId: member.userId, level: 2 })
          .onConflictDoUpdate({
            target: [ownership.documentType, ownership.documentId, ownership.userId],
            set: { level: 2 },
          });
      } else {
        await db
          .delete(ownership)
          .where(
            and(
              eq(ownership.documentType, 'journal'),
              eq(ownership.documentId, id),
              eq(ownership.userId, member.userId),
            ),
          );
      }
    }

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
    return { ok: true };
  });
}

async function loadScene(sceneId: string) {
  const rows = await db.select().from(scenes).where(eq(scenes.id, sceneId)).limit(1);
  if (!rows[0]) throw new HttpError(404, 'Scene not found');
  return rows[0];
}

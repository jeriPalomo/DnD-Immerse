import { eq } from 'drizzle-orm';
import { campaignRoom, templateCreateSchema } from '@dnd/shared';
import type { Socket } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents, WireTemplate } from '@dnd/shared';
import { db } from '../db/index.js';
import { campaigns, scenes, templates } from '../db/schema.js';
import { getMembership } from '../auth/guards.js';
import { newId } from '../lib/id.js';
import type { IOServer, SocketData } from './index.js';

type OverlaySocket = Socket<ClientToServerEvents, ServerToClientEvents, object, SocketData>;

/**
 * Things drawn over the table rather than on it: area-of-effect templates, and
 * revealing a journal image to everyone at once.
 *
 * Was `ambience.ts` when it also carried the audio system. Audio now lives in
 * Discord, so the name would have been a lie.
 */

/* ----------------------------------------------------- scene-scoped state */

async function activeSceneId(campaignId: string): Promise<string | null> {
  const rows = await db
    .select({ activeSceneId: campaigns.activeSceneId })
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);
  return rows[0]?.activeSceneId ?? null;
}

export async function broadcastTemplates(io: IOServer, campaignId: string): Promise<void> {
  const sceneId = await activeSceneId(campaignId);
  if (!sceneId) {
    io.to(campaignRoom(campaignId)).emit('template:state', { templates: [] });
    return;
  }

  const rows = await db.select().from(templates).where(eq(templates.sceneId, sceneId));

  const wire: WireTemplate[] = rows.map((template) => ({
    id: template.id,
    sceneId: template.sceneId,
    ownerUserId: template.ownerUserId,
    shape: template.shape,
    x: template.x,
    y: template.y,
    direction: template.direction,
    distance: template.distance,
    width: template.width,
    color: template.color,
  }));

  io.to(campaignRoom(campaignId)).emit('template:state', { templates: wire });
}

/* -------------------------------------------------------------- handlers */

export function registerOverlayHandlers(io: IOServer, socket: OverlaySocket): void {
  const user = socket.data.user;

  async function context(): Promise<{ campaignId: string; isDM: boolean } | null> {
    // The campaign this socket declared it is acting in, not whichever room it
    // happens to have joined first.
    const campaignId = socket.data.activeCampaignId;
    if (!campaignId) return null;

    const membership = await getMembership(campaignId, user.id);
    if (!membership) {
      socket.emit('error', { message: 'You are not in that campaign', code: 'NOT_A_MEMBER' });
      return null;
    }
    return { campaignId, isDM: membership.isDM };
  }

  /** Shows a journal image large on every screen for a moment. */
  socket.on('handout:show', async ({ pageId }) => {
    const ctx = await context();
    if (!ctx || !ctx.isDM) {
      socket.emit('error', { message: 'Only the DM can show a handout' });
      return;
    }

    const { journalEntries, journalPages } = await import('../db/schema.js');
    const rows = await db
      .select({ page: journalPages, entry: journalEntries })
      .from(journalPages)
      .innerJoin(journalEntries, eq(journalPages.entryId, journalEntries.id))
      .where(eq(journalPages.id, pageId))
      .limit(1);

    const found = rows[0];
    if (!found?.page.fileUrl || found.entry.campaignId !== ctx.campaignId) return;

    io.to(campaignRoom(ctx.campaignId)).emit('handout:reveal', {
      imageUrl: found.page.fileUrl,
      title: found.page.title,
    });
  });

  /** Templates are placed by players too — aiming a fireball is their job. */
  socket.on('template:create', async (payload) => {
    const ctx = await context();
    if (!ctx) return;

    const input = templateCreateSchema.parse(payload);
    const scene = await db.select().from(scenes).where(eq(scenes.id, input.sceneId)).limit(1);
    if (scene[0]?.campaignId !== ctx.campaignId) return;

    await db.insert(templates).values({
      id: newId(),
      sceneId: input.sceneId,
      ownerUserId: user.id,
      shape: input.shape,
      x: input.x,
      y: input.y,
      direction: input.direction,
      distance: input.distance,
      width: input.width,
      color: input.color,
    });

    await broadcastTemplates(io, ctx.campaignId);
  });

  socket.on('template:delete', async ({ templateId }) => {
    const ctx = await context();
    if (!ctx) return;

    const rows = await db.select().from(templates).where(eq(templates.id, templateId)).limit(1);
    const template = rows[0];
    if (!template) return;

    // You may clear your own template; the DM may clear anyone's.
    if (!ctx.isDM && template.ownerUserId !== user.id) {
      socket.emit('error', { message: 'That is not your template' });
      return;
    }

    await db.delete(templates).where(eq(templates.id, templateId));
    await broadcastTemplates(io, ctx.campaignId);
  });
}

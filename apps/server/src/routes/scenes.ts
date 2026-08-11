import { and, asc, eq } from 'drizzle-orm';
import { sceneInputSchema } from '@dnd/shared';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { db } from '../db/index.js';
import { campaigns, scenes, tokens } from '../db/schema.js';
import { HttpError, assertUser, requireAuth, requireDM, requireMembership } from '../auth/guards.js';
import { newId } from '../lib/id.js';
import { storeImage } from '../lib/uploads.js';

/**
 * Scenes are DM-authored. Players never list them - they only ever see the one
 * the DM has made active, which arrives over the socket.
 */
export async function sceneRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/api/campaigns/:campaignId/scenes', async (request) => {
    const user = assertUser(request);
    const { campaignId } = request.params as { campaignId: string };
    await requireDM(campaignId, user.id);

    const rows = await db
      .select()
      .from(scenes)
      .where(eq(scenes.campaignId, campaignId))
      .orderBy(asc(scenes.sortOrder), asc(scenes.createdAt));

    const campaign = await db
      .select({ activeSceneId: campaigns.activeSceneId })
      .from(campaigns)
      .where(eq(campaigns.id, campaignId))
      .limit(1);

    return { scenes: rows, activeSceneId: campaign[0]?.activeSceneId ?? null };
  });

  app.post('/api/campaigns/:campaignId/scenes', async (request) => {
    const user = assertUser(request);
    const { campaignId } = request.params as { campaignId: string };
    await requireDM(campaignId, user.id);

    const input = sceneInputSchema.partial().parse(request.body ?? {});
    const name = input.name?.trim() || 'New Scene';

    const scene = {
      id: newId(),
      campaignId,
      name,
      mapImageUrl: null,
      mapWidth: 0,
      mapHeight: 0,
      gridSize: input.gridSize ?? 70,
      gridOffsetX: input.gridOffsetX ?? 0,
      gridOffsetY: input.gridOffsetY ?? 0,
      gridVisible: input.gridVisible ?? true,
      feetPerSquare: input.feetPerSquare ?? 5,
      visionEnabled: false,
      globalIllumination: true,
      darkness: 0,
      revealedPolygons: [],
      sortOrder: 0,
      createdAt: Date.now(),
    };

    await db.insert(scenes).values(scene);
    return { scene };
  });

  app.patch('/api/scenes/:id', async (request) => {
    const user = assertUser(request);
    const { id } = request.params as { id: string };
    const scene = await loadScene(id);
    await requireDM(scene.campaignId, user.id);

    const patch = z
      .object({
        name: z.string().min(1).max(80).optional(),
        gridSize: z.number().min(4).max(512).optional(),
        gridOffsetX: z.number().optional(),
        gridOffsetY: z.number().optional(),
        gridVisible: z.boolean().optional(),
        feetPerSquare: z.number().min(1).max(100).optional(),
        visionEnabled: z.boolean().optional(),
        globalIllumination: z.boolean().optional(),
        darkness: z.number().min(0).max(1).optional(),
      })
      .parse(request.body);

    await db.update(scenes).set(patch).where(eq(scenes.id, id));
    const rows = await db.select().from(scenes).where(eq(scenes.id, id)).limit(1);
    return { scene: rows[0] };
  });

  app.delete('/api/scenes/:id', async (request) => {
    const user = assertUser(request);
    const { id } = request.params as { id: string };
    const scene = await loadScene(id);
    await requireDM(scene.campaignId, user.id);

    await db.delete(scenes).where(eq(scenes.id, id));

    // Do not leave the campaign pointing at a scene that no longer exists.
    await db
      .update(campaigns)
      .set({ activeSceneId: null })
      .where(and(eq(campaigns.id, scene.campaignId), eq(campaigns.activeSceneId, id)));

    return { ok: true };
  });

  /**
   * Uploading a map records its natural pixel size, which the client needs to
   * convert between grid units and screen position.
   */
  app.post('/api/scenes/:id/map', async (request) => {
    const user = assertUser(request);
    const { id } = request.params as { id: string };
    const scene = await loadScene(id);
    await requireDM(scene.campaignId, user.id);

    const file = await request.file();
    if (!file) throw new HttpError(400, 'No file uploaded');

    // Battle maps are large; 4096 keeps detail without a 30MB payload.
    const stored = await storeImage(await file.toBuffer(), 'maps', { maxDimension: 4096 });

    await db
      .update(scenes)
      .set({ mapImageUrl: stored.url, mapWidth: stored.width, mapHeight: stored.height })
      .where(eq(scenes.id, id));

    const rows = await db.select().from(scenes).where(eq(scenes.id, id)).limit(1);
    return { scene: rows[0] };
  });

  app.get('/api/scenes/:id/tokens', async (request) => {
    const user = assertUser(request);
    const { id } = request.params as { id: string };
    const scene = await loadScene(id);
    await requireMembership(scene.campaignId, user.id);

    // The socket payload is the filtered one; this REST route is DM-only so it
    // cannot become a way around that filtering.
    await requireDM(scene.campaignId, user.id);

    const rows = await db.select().from(tokens).where(eq(tokens.sceneId, id));
    return { tokens: rows };
  });
}

async function loadScene(id: string) {
  const rows = await db.select().from(scenes).where(eq(scenes.id, id)).limit(1);
  if (!rows[0]) throw new HttpError(404, 'Scene not found');
  return rows[0];
}

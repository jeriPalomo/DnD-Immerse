import { and, asc, eq } from 'drizzle-orm';
import { sceneInputSchema } from '@dnd/shared';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { db } from '../db/index.js';
import { campaigns, scenes, tokens } from '../db/schema.js';
import { HttpError, assertUser, requireAuth, requireDM, requireMembership } from '../auth/guards.js';
import { newId } from '../lib/id.js';
import { deleteUpload, storeImage } from '../lib/uploads.js';
import { deleteOrphanedUploads, sceneFileUrls } from '../lib/orphans.js';
import { detectGrid } from '@dnd/shared';
import sharp from 'sharp';

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
      weather: 'none' as const,
      weatherIntensity: 0.5,
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
        weather: z.enum(['none', 'rain', 'storm', 'snow', 'fog', 'ash']).optional(),
        weatherIntensity: z.number().min(0).max(1).optional(),
        playerDrawing: z.boolean().optional(),
      })
      .parse(request.body);

    // An empty patch is a no-op, not a 500: `set({})` has no columns to write.
    if (Object.keys(patch).length > 0) {
      await db.update(scenes).set(patch).where(eq(scenes.id, id));
    }

    const rows = await db.select().from(scenes).where(eq(scenes.id, id)).limit(1);
    return { scene: rows[0] };
  });

  app.delete('/api/scenes/:id', async (request) => {
    const user = assertUser(request);
    const { id } = request.params as { id: string };
    const scene = await loadScene(id);
    await requireDM(scene.campaignId, user.id);

    // Collected before the delete, since the rows go with it.
    const files = await sceneFileUrls(id);

    await db.delete(scenes).where(eq(scenes.id, id));
    await deleteOrphanedUploads(files);

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
    const original = await file.toBuffer();
    const stored = await storeImage(original, 'maps', { maxDimension: 4096 });

    /*
     * Guess the grid the map already has printed on it, so the DM confirms a
     * number instead of nudging three sliders.
     *
     * Measured on a downscaled copy - the pattern is the same and the
     * autocorrelation is far cheaper - then scaled back up to the stored
     * image's coordinates.
     */
    let grid: { size: number; offsetX: number; offsetY: number; confidence: number } | null = null;
    try {
      const sample = await sharp(original)
        .greyscale()
        .resize(900, 900, { fit: 'inside', withoutEnlargement: true })
        .raw()
        .toBuffer({ resolveWithObject: true });

      const guess = detectGrid(
        new Uint8Array(sample.data),
        sample.info.width,
        sample.info.height,
      );

      if (guess.size > 0) {
        const scale = stored.width / sample.info.width;
        grid = {
          size: Math.round(guess.size * scale),
          offsetX: Math.round(guess.offsetX * scale),
          offsetY: Math.round(guess.offsetY * scale),
          confidence: guess.confidence,
        };
      }
    } catch {
      // Detection is a convenience; a map that resists it still uploads.
    }

    await db
      .update(scenes)
      .set({ mapImageUrl: stored.url, mapWidth: stored.width, mapHeight: stored.height })
      .where(eq(scenes.id, id));

    const rows = await db.select().from(scenes).where(eq(scenes.id, id)).limit(1);
    // Reported, not applied: the DM sees the overlay and accepts it.
    return { scene: rows[0], grid };
  });

  app.post('/api/tokens/:tokenId/image', async (request) => {
    const user = assertUser(request);
    const { tokenId } = request.params as { tokenId: string };

    const rows = await db.select().from(tokens).where(eq(tokens.id, tokenId)).limit(1);
    const token = rows[0];
    if (!token) throw new HttpError(404, 'Token not found');

    const scene = await db.select().from(scenes).where(eq(scenes.id, token.sceneId)).limit(1);
    if (!scene[0]) throw new HttpError(404, 'Token not found');

    const membership = await requireMembership(scene[0].campaignId, user.id);
    if (!membership.isDM && token.ownerUserId !== user.id) {
      throw new HttpError(403, 'That is not your token');
    }

    const file = await request.file();
    if (!file) throw new HttpError(400, 'No file uploaded');

    const stored = await storeImage(await file.toBuffer(), 'tokens', { maxDimension: 512 });
    const previous = token.imageUrl;

    await db.update(tokens).set({ imageUrl: stored.url }).where(eq(tokens.id, tokenId));

    // Only remove the old art if it was this token's own upload; an inherited
    // actor portrait is still in use by the sheet.
    if (previous?.startsWith('/uploads/tokens/')) await deleteUpload(previous);

    if (app.io) {
      const { broadcastSceneState } = await import('../realtime/scene.js');
      await broadcastSceneState(app.io, scene[0].campaignId);
    }

    return { imageUrl: stored.url };
  });
}

/** Loads a scene and checks it exists, for the routes keyed by scene id. */
async function loadScene(sceneId: string) {
  const rows = await db.select().from(scenes).where(eq(scenes.id, sceneId)).limit(1);
  if (!rows[0]) throw new HttpError(404, 'Scene not found');
  return rows[0];
}

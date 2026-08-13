import { and, desc, eq } from 'drizzle-orm';
import { campaignInputSchema } from '@dnd/shared';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { db } from '../db/index.js';
import { campaignMembers, campaigns, encounters, scenes, users } from '../db/schema.js';
import { HttpError, assertUser, requireAuth, requireDM, requireMembership } from '../auth/guards.js';
import { newId, newInviteCode } from '../lib/id.js';
import { storeImage } from '../lib/uploads.js';
import { campaignFileUrls, deleteOrphanedUploads } from '../lib/orphans.js';

export async function campaignRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  /** Campaigns the signed-in user belongs to, as DM or player. */
  app.get('/api/campaigns', async (request) => {
    const user = assertUser(request);

    const rows = await db
      .select({
        campaign: campaigns,
        role: campaignMembers.role,
      })
      .from(campaignMembers)
      .innerJoin(campaigns, eq(campaignMembers.campaignId, campaigns.id))
      .where(eq(campaignMembers.userId, user.id))
      .orderBy(desc(campaigns.createdAt));

    return {
      campaigns: rows.map(({ campaign, role }) => ({
        ...campaign,
        role,
        // The invite code is a credential; only the DM needs it.
        inviteCode: role === 'dm' ? campaign.inviteCode : null,
      })),
    };
  });

  app.post('/api/campaigns', async (request) => {
    const user = assertUser(request);
    const input = campaignInputSchema.parse(request.body);

    const campaign = {
      id: newId(),
      name: input.name,
      description: input.description,
      dmUserId: user.id,
      activeSceneId: null,
      inviteCode: newInviteCode(),
      bannerUrl: null,
      createdAt: Date.now(),
    };

    await db.insert(campaigns).values(campaign);
    await db.insert(campaignMembers).values({
      campaignId: campaign.id,
      userId: user.id,
      role: 'dm',
      joinedAt: Date.now(),
    });

    return { campaign: { ...campaign, role: 'dm' as const } };
  });

  app.get('/api/campaigns/:id', async (request) => {
    const user = assertUser(request);
    const { id } = request.params as { id: string };
    const membership = await requireMembership(id, user.id);

    const rows = await db.select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
    const campaign = rows[0];
    if (!campaign) throw new HttpError(404, 'Campaign not found');

    return {
      campaign: {
        ...campaign,
        role: membership.role,
        inviteCode: membership.isDM ? campaign.inviteCode : null,
      },
      lastSession: await lastSession(campaign.id, campaign.activeSceneId),
    };
  });

  app.patch('/api/campaigns/:id', async (request) => {
    const user = assertUser(request);
    const { id } = request.params as { id: string };
    await requireDM(id, user.id);

    const input = campaignInputSchema
      .extend({ ruleset: z.enum(['2014', '2024']) })
      .partial()
      .parse(request.body);
    await db.update(campaigns).set(input).where(eq(campaigns.id, id));

    const rows = await db.select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
    return { campaign: { ...rows[0], role: 'dm' as const } };
  });

  app.delete('/api/campaigns/:id', async (request) => {
    const user = assertUser(request);
    const { id } = request.params as { id: string };
    await requireDM(id, user.id);

    // Rows cascade; files do not. Gathered first, removed after, and each one
    // re-checked so a track an emitter still plays is left alone.
    const files = await campaignFileUrls(id);

    await db.delete(campaigns).where(eq(campaigns.id, id));
    await deleteOrphanedUploads(files);

    return { ok: true };
  });

  /* ------------------------------------------------------------- invites */

  app.post('/api/campaigns/join', async (request) => {
    const user = assertUser(request);
    const body = (request.body ?? {}) as { inviteCode?: unknown };

    const code = typeof body.inviteCode === 'string' ? body.inviteCode.trim().toUpperCase() : '';
    if (!code) throw new HttpError(400, 'Invite code required');

    const rows = await db
      .select()
      .from(campaigns)
      .where(eq(campaigns.inviteCode, code))
      .limit(1);

    const campaign = rows[0];
    if (!campaign) throw new HttpError(404, 'No campaign with that invite code');

    const existing = await db
      .select({ role: campaignMembers.role })
      .from(campaignMembers)
      .where(
        and(eq(campaignMembers.campaignId, campaign.id), eq(campaignMembers.userId, user.id)),
      )
      .limit(1);

    if (existing.length > 0) {
      // Re-joining is not an error; it just takes you to the campaign.
      return { campaign: { ...campaign, role: existing[0].role, inviteCode: null } };
    }

    await db.insert(campaignMembers).values({
      campaignId: campaign.id,
      userId: user.id,
      role: 'player',
      joinedAt: Date.now(),
    });

    return { campaign: { ...campaign, role: 'player' as const, inviteCode: null } };
  });

  /** Rotates the invite code, revoking any link already shared. */
  app.post('/api/campaigns/:id/invite/rotate', async (request) => {
    const user = assertUser(request);
    const { id } = request.params as { id: string };
    await requireDM(id, user.id);

    const inviteCode = newInviteCode();
    await db.update(campaigns).set({ inviteCode }).where(eq(campaigns.id, id));
    return { inviteCode };
  });

  /* ------------------------------------------------------------- members */

  app.get('/api/campaigns/:id/members', async (request) => {
    const user = assertUser(request);
    const { id } = request.params as { id: string };
    await requireMembership(id, user.id);

    const rows = await db
      .select({
        id: users.id,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        role: campaignMembers.role,
        joinedAt: campaignMembers.joinedAt,
      })
      .from(campaignMembers)
      .innerJoin(users, eq(campaignMembers.userId, users.id))
      .where(eq(campaignMembers.campaignId, id));

    return { members: rows };
  });

  /** The DM removes a player; anyone else may only remove themselves. */
  app.delete('/api/campaigns/:id/members/:userId', async (request) => {
    const user = assertUser(request);
    const { id, userId } = request.params as { id: string; userId: string };
    const membership = await requireMembership(id, user.id);

    if (userId !== user.id && !membership.isDM) {
      throw new HttpError(403, 'Only the DM can remove other players');
    }
    if (membership.isDM && userId === user.id) {
      throw new HttpError(400, 'The DM cannot leave their own campaign; delete it instead');
    }

    await db
      .delete(campaignMembers)
      .where(and(eq(campaignMembers.campaignId, id), eq(campaignMembers.userId, userId)));

    return { ok: true };
  });

  app.post('/api/campaigns/:id/banner', async (request) => {
    const user = assertUser(request);
    const { id } = request.params as { id: string };
    await requireDM(id, user.id);

    const file = await request.file();
    if (!file) throw new HttpError(400, 'No file uploaded');

    const stored = await storeImage(await file.toBuffer(), 'maps', { maxDimension: 1600 });
    await db.update(campaigns).set({ bannerUrl: stored.url }).where(eq(campaigns.id, id));

    return { bannerUrl: stored.url };
  });
}

/**
 * Where the table left off: the scene that is live, and whether a fight is
 * still open on it.
 *
 * Derived every time rather than stored, so it cannot go stale the way a
 * written note does. An unfinished combat is the thing most worth knowing
 * before a session starts.
 */
async function lastSession(
  campaignId: string,
  activeSceneId: string | null,
): Promise<{
  scene: { id: string; name: string; mapImageUrl: string | null } | null;
  combat: { round: number } | null;
}> {
  const scene = activeSceneId
    ? (
        await db
          .select({ id: scenes.id, name: scenes.name, mapImageUrl: scenes.mapImageUrl })
          .from(scenes)
          .where(eq(scenes.id, activeSceneId))
          .limit(1)
      )[0] ?? null
    : null;

  const open = (
    await db
      .select({ round: encounters.round })
      .from(encounters)
      .where(and(eq(encounters.campaignId, campaignId), eq(encounters.isActive, true)))
      .limit(1)
  )[0];

  return { scene, combat: open ? { round: open.round } : null };
}

import { and, asc, desc, eq } from 'drizzle-orm';
import { campaignInputSchema, classInfo, classSaves, hitDicePool } from '@dnd/shared';
import type { SaveProficiencies } from '@dnd/shared';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { db } from '../db/index.js';
import {
  actorCampaigns,
  actors,
  campaignMembers,
  campaigns,
  encounters,
  scenes,
  users,
} from '../db/schema.js';
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

    // Re-read rather than echoing the literal above: `ruleset` and `recap` come
    // from column defaults, and the settings panel opens on this response - it
    // would show the fallback edition instead of the real one.
    const rows = await db.select().from(campaigns).where(eq(campaigns.id, campaign.id)).limit(1);

    return { campaign: { ...rows[0], role: 'dm' as const } };
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
      .extend({
        ruleset: z.enum(['2014', '2024']),
        playersSeeEnemyStats: z.boolean(),
      })
      .partial()
      .parse(request.body);

    // Every field is optional, so a payload of `{}` reaches `set({})`, which
    // throws "No values to set". The fourth place in this codebase to need
    // this guard - see the invariant in CLAUDE.md.
    if (Object.keys(input).length > 0) {
      await db.update(campaigns).set(input).where(eq(campaigns.id, id));
    }

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

  /**
   * Levels the whole party at once.
   *
   * The DM declares level-ups as the story reaches them, and everybody moves
   * together - so this is one action and one announcement rather than a level
   * typed onto four sheets and four lines in the log.
   *
   * It sets the level and the things that follow from it - the hit dice pool,
   * the class's saving throws, the casting ability - and stops there.
   * `levelAcknowledged` is deliberately left behind, which is what makes each
   * player's sheet greet them with what they gained. Hit points are not rolled
   * here either: the handbook offers a roll or the average and that is the
   * player's to take, on their own sheet, where they can watch the die.
   *
   * Characters only. An NPC has a level for its stat block, not for a story.
   */
  app.post('/api/campaigns/:id/level-party', async (request) => {
    const user = assertUser(request);
    const { id } = request.params as { id: string };
    await requireDM(id, user.id);

    const input = z.object({ level: z.number().int().min(1).max(20) }).parse(request.body);

    const party = await db
      .select({
        id: actors.id,
        name: actors.name,
        className: actors.className,
        level: actors.level,
        saveProficiencies: actors.saveProficiencies,
      })
      .from(actorCampaigns)
      .innerJoin(actors, eq(actorCampaigns.actorId, actors.id))
      .where(and(eq(actorCampaigns.campaignId, id), eq(actors.type, 'character')));

    if (party.length === 0) {
      throw new HttpError(400, 'No characters are assigned to this campaign yet.');
    }

    // Only the ones actually going up. Re-running at the same level must not
    // re-announce it, and must not drag anybody who is already higher back down.
    const climbing = party.filter((character) => character.level < input.level);

    for (const character of climbing) {
      const info = classInfo(character.className);
      const saves: SaveProficiencies = { ...character.saveProficiencies };
      // Added, never cleared: a multiclass or a house rule has to be able to
      // keep a proficiency this table does not know about.
      for (const ability of classSaves(character.className)) saves[ability] = true;

      await db
        .update(actors)
        .set({
          level: input.level,
          hitDiceTotal: hitDicePool(character.className, input.level),
          saveProficiencies: saves,
          ...(info?.casting ? { spellcastingAbility: info.casting } : {}),
          updatedAt: Date.now(),
        })
        .where(eq(actors.id, character.id));
    }

    // One banner, and only when somebody actually moved.
    if (app.io && climbing.length > 0) {
      const { persistAndDeliver } = await import('../realtime/chat.js');
      await persistAndDeliver(
        app.io,
        id,
        {
          userId: user.id,
          actorId: null,
          kind: 'levelup',
          body: `Level ${input.level} Reached`,
          // Not a combat event: reaching a level belongs in the conversation,
          // which both views of the log show.
          combat: false,
        },
        { authorName: user.displayName, actorName: null },
      );
    }

    return { level: input.level, levelled: climbing.map((c) => c.name), unchanged: party.length - climbing.length };
  });

  /* ------------------------------------------------------------- members */

  /**
   * Who is in the campaign, and who they are playing.
   *
   * Characters are carried here so the roster does not have to correlate two
   * requests by owner id. Only name and portrait travel, which every member can
   * already see on the party panel - and only `character` actors, never NPCs:
   * a monster's name in a roster spoils the encounter as thoroughly as its
   * stat block would.
   */
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

    const characters = await db
      .select({
        id: actors.id,
        name: actors.name,
        portraitUrl: actors.portraitUrl,
        ownerUserId: actors.ownerUserId,
      })
      .from(actorCampaigns)
      .innerJoin(actors, eq(actorCampaigns.actorId, actors.id))
      .where(and(eq(actorCampaigns.campaignId, id), eq(actors.type, 'character')))
      .orderBy(asc(actors.name));

    return {
      members: rows.map((row) => ({
        ...row,
        characters: characters
          .filter((character) => character.ownerUserId === row.id)
          .map(({ ownerUserId: _owner, ...character }) => character),
      })),
    };
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

    const previous = await db
      .select({ url: campaigns.bannerUrl })
      .from(campaigns)
      .where(eq(campaigns.id, id))
      .limit(1);

    const stored = await storeImage(await file.toBuffer(), 'maps', { maxDimension: 1600 });
    await db.update(campaigns).set({ bannerUrl: stored.url }).where(eq(campaigns.id, id));

    // Replacing a banner used to leave the old one on disk with nothing
    // pointing at it.
    await deleteOrphanedUploads([previous[0]?.url ?? null]);

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

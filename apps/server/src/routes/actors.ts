import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  ABILITIES,
  ABILITY_ROLL,
  OWNERSHIP,
  abilityModifier,
  actorInputSchema,
  applyRest,
  classInfo,
  emptyActor,
  hitPointsForLevel,
  hitPointsGained,
  ownershipLevelSchema,
  parseHitDicePool,
} from '@dnd/shared';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { db } from '../db/index.js';
import { actorCampaigns, actors, campaignMembers, campaigns, items, ownership } from '../db/schema.js';
import { HttpError, assertUser, requireAuth, requireDM, requireMembership } from '../auth/guards.js';
import { getBulkActorAccess, requireActorRead, requireActorWrite } from '../lib/access.js';
import { rollExpression } from '../lib/dice.js';
import { newId } from '../lib/id.js';
import { syncLinkedTokens } from '../lib/linkedTokens.js';
import { storeImage } from '../lib/uploads.js';
import { deleteOrphanedUploads } from '../lib/orphans.js';
import type { ActorInput } from '@dnd/shared';

/** Maps a validated ActorInput onto the column set the table expects. */
function toRow(input: ActorInput) {
  const { skillProficiencies, saveProficiencies, spellSlots, currency, damageModifiers, prototypeToken, ...rest } =
    input;
  return {
    ...rest,
    skillProficiencies,
    saveProficiencies,
    spellSlots,
    currency,
    damageModifiers,
    prototypeToken,
  };
}

export async function actorRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  /* -------------------------------------------------------------- roster */

  /** Every actor the signed-in user personally owns. */
  app.get('/api/actors', async (request) => {
    const user = assertUser(request);

    const rows = await db
      .select()
      .from(actors)
      .where(eq(actors.ownerUserId, user.id))
      .orderBy(asc(actors.name));

    const assignments =
      rows.length === 0
        ? []
        : await db
            .select({ actorId: actorCampaigns.actorId, campaignId: actorCampaigns.campaignId, name: campaigns.name })
            .from(actorCampaigns)
            .innerJoin(campaigns, eq(actorCampaigns.campaignId, campaigns.id))
            .where(inArray(actorCampaigns.actorId, rows.map((r) => r.id)));

    return {
      actors: rows.map((actor) => ({
        ...actor,
        campaigns: assignments
          .filter((a) => a.actorId === actor.id)
          .map((a) => ({ id: a.campaignId, name: a.name })),
      })),
    };
  });

  /** The party roster for a campaign, filtered by what the viewer may see. */
  app.get('/api/campaigns/:campaignId/actors', async (request) => {
    const user = assertUser(request);
    const { campaignId } = request.params as { campaignId: string };
    const membership = await requireMembership(campaignId, user.id);

    const rows = await db
      .select({ actor: actors })
      .from(actorCampaigns)
      .innerJoin(actors, eq(actorCampaigns.actorId, actors.id))
      .where(eq(actorCampaigns.campaignId, campaignId))
      .orderBy(asc(actors.name));

    if (membership.isDM) {
      return { actors: rows.map((r) => ({ ...r.actor, access: OWNERSHIP.owner })) };
    }

    const dmCampaigns = new Set<string>();
    const levels = await getBulkActorAccess(rows.map((r) => r.actor.id), user.id, dmCampaigns);

    // Players see their own sheets in full, other player characters at name
    // level, and NPCs not at all.
    //
    // NPCs default to `none` rather than `limited` because a roster listing
    // "Ancient Red Dragon" spoils the encounter before the party has met it -
    // the name alone is the leak, even with every stat hidden. The DM shares an
    // NPC deliberately, by granting ownership.
    const visible = rows.filter(({ actor }) => {
      const level = levels.get(actor.id) ?? OWNERSHIP.none;
      return actor.type === 'character' || level >= OWNERSHIP.limited;
    });

    return {
      actors: visible.map(({ actor }) => {
        const level = levels.get(actor.id) ?? OWNERSHIP.limited;
        if (level >= OWNERSHIP.observer) return { ...actor, access: level };
        return {
          id: actor.id,
          name: actor.name,
          portraitUrl: actor.portraitUrl,
          type: actor.type,
          className: actor.className,
          level: actor.level,
          access: OWNERSHIP.limited,
        };
      }),
    };
  });

  /* ------------------------------------------------------------- read/write */

  app.get('/api/actors/:id', async (request) => {
    const user = assertUser(request);
    const { id } = request.params as { id: string };
    const { actor, level } = await requireActorRead(id, user.id);

    const ownedItems = await db
      .select()
      .from(items)
      .where(eq(items.ownerActorId, id))
      .orderBy(asc(items.sortOrder), asc(items.name));

    // `ruleset` travels so the sheet's compendium picker offers the edition the
    // campaign actually plays - it used to browse 2014 equipment regardless.
    const assignments = await db
      .select({ id: campaigns.id, name: campaigns.name, ruleset: campaigns.ruleset })
      .from(actorCampaigns)
      .innerJoin(campaigns, eq(actorCampaigns.campaignId, campaigns.id))
      .where(eq(actorCampaigns.actorId, id));

    // Who this sheet is shared with, so the sharing control can show the
    // truth rather than assume nothing has been granted.
    const grants = await db
      .select({ userId: ownership.userId, level: ownership.level })
      .from(ownership)
      .where(and(eq(ownership.documentType, 'actor'), eq(ownership.documentId, id)));

    return { actor, items: ownedItems, campaigns: assignments, access: level, grants };
  });

  app.post('/api/actors', async (request) => {
    const user = assertUser(request);
    const body = (request.body ?? {}) as Record<string, unknown>;

    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'New Character';
    const type = body.type === 'npc' ? 'npc' : 'character';

    // Start from a fully defaulted sheet, then layer any supplied fields over it.
    const input = actorInputSchema.parse({ ...emptyActor(name, type), ...body, name, type });

    const actor = {
      id: newId(),
      ownerUserId: user.id,
      campaignId: typeof body.campaignId === 'string' ? body.campaignId : null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...toRow(input),
    };

    await db.insert(actors).values(actor);
    return { actor };
  });

  app.patch('/api/actors/:id', async (request) => {
    const user = assertUser(request);
    const { id } = request.params as { id: string };
    await requireActorWrite(id, user.id);

    const patch = actorInputSchema.partial().parse(request.body);
    await db
      .update(actors)
      .set({ ...patch, updatedAt: Date.now() })
      .where(eq(actors.id, id));

    // A linked token is the same creature as its sheet; keep the board in step.
    if (patch.hpCurrent !== undefined || patch.hpMax !== undefined || patch.armorClass !== undefined) {
      await syncLinkedTokens(app, id);
    }

    const rows = await db.select().from(actors).where(eq(actors.id, id)).limit(1);
    return { actor: rows[0] };
  });

  app.delete('/api/actors/:id', async (request) => {
    const user = assertUser(request);
    const { id } = request.params as { id: string };
    const { actor } = await requireActorWrite(id, user.id);

    // Deleting someone else's character is the DM overstepping; only the
    // creator can destroy a sheet.
    if (actor.ownerUserId !== user.id) {
      throw new HttpError(403, 'Only the character owner can delete it');
    }

    await db.delete(actors).where(eq(actors.id, id));
    // Reference-checked, not deleted outright: `tokens.actorId` is `set null`,
    // so tokens stamped from this actor OUTLIVE it while still holding the
    // portrait they inherited. Deleting the file unconditionally left broken
    // images on every board the actor had ever appeared on.
    await deleteOrphanedUploads([actor.portraitUrl]);
    return { ok: true };
  });

  app.post('/api/actors/:id/portrait', async (request) => {
    const user = assertUser(request);
    const { id } = request.params as { id: string };
    await requireActorWrite(id, user.id);

    const file = await request.file();
    if (!file) throw new HttpError(400, 'No file uploaded');

    const stored = await storeImage(await file.toBuffer(), 'avatars', { maxDimension: 800 });

    const previous = await db.select({ url: actors.portraitUrl }).from(actors).where(eq(actors.id, id)).limit(1);
    await db.update(actors).set({ portraitUrl: stored.url }).where(eq(actors.id, id));
    // Replacing a portrait should not leave the old one on disk forever - but
    // tokens inherit that URL by value, so only remove it once nothing else
    // points at it.
    await deleteOrphanedUploads([previous[0]?.url ?? null]);

    return { portraitUrl: stored.url };
  });

  /* -------------------------------------------------------- campaign assignment */

  app.post('/api/actors/:id/campaigns/:campaignId', async (request) => {
    const user = assertUser(request);
    const { id, campaignId } = request.params as { id: string; campaignId: string };

    const { actor } = await requireActorWrite(id, user.id);
    if (actor.ownerUserId !== user.id) {
      throw new HttpError(403, 'Only the character owner can bring it into a campaign');
    }
    // Assigning requires being in the campaign, not just owning the character.
    await requireMembership(campaignId, user.id);

    await db
      .insert(actorCampaigns)
      .values({ actorId: id, campaignId, assignedAt: Date.now() })
      .onConflictDoNothing();

    return { ok: true };
  });

  app.delete('/api/actors/:id/campaigns/:campaignId', async (request) => {
    const user = assertUser(request);
    const { id, campaignId } = request.params as { id: string; campaignId: string };
    await requireActorWrite(id, user.id);

    await db
      .delete(actorCampaigns)
      .where(and(eq(actorCampaigns.actorId, id), eq(actorCampaigns.campaignId, campaignId)));

    return { ok: true };
  });

  /* ------------------------------------------------------------- sharing */

  /** The DM grants a player visibility into a sheet they do not own. */
  app.put('/api/actors/:id/ownership/:userId', async (request) => {
    const user = assertUser(request);
    const { id, userId } = request.params as { id: string; userId: string };
    const { actor } = await requireActorWrite(id, user.id);

    const { level } = z.object({ level: ownershipLevelSchema }).parse(request.body);

    // The target must share a campaign with this actor, so sharing cannot leak
    // a sheet to an arbitrary account.
    const shared = await db
      .select({ campaignId: actorCampaigns.campaignId })
      .from(actorCampaigns)
      .innerJoin(campaignMembers, eq(actorCampaigns.campaignId, campaignMembers.campaignId))
      .where(and(eq(actorCampaigns.actorId, id), eq(campaignMembers.userId, userId)))
      .limit(1);

    if (shared.length === 0 && actor.ownerUserId !== userId) {
      throw new HttpError(400, 'That player is not in a campaign with this character');
    }

    if (level === OWNERSHIP.none) {
      await db
        .delete(ownership)
        .where(
          and(
            eq(ownership.documentType, 'actor'),
            eq(ownership.documentId, id),
            eq(ownership.userId, userId),
          ),
        );
    } else {
      await db
        .insert(ownership)
        .values({ documentType: 'actor', documentId: id, userId, level })
        .onConflictDoUpdate({
          target: [ownership.documentType, ownership.documentId, ownership.userId],
          set: { level },
        });
    }

    return { ok: true };
  });

  /**
   * Rests. Resolved here rather than on the client because hit dice are dice,
   * and every other die in the app is rolled on the server.
   */
  app.post('/api/actors/:id/rest', async (request) => {
    const user = assertUser(request);
    const { id } = request.params as { id: string };
    const { actor } = await requireActorWrite(id, user.id);

    const input = z
      .object({
        type: z.enum(['short', 'long']),
        hitDiceSpent: z.number().int().min(0).max(20).default(0),
      })
      .parse(request.body);

    const owned = await db.select().from(items).where(eq(items.ownerActorId, id));
    const features = owned.map((item) => {
      const uses = (item.system as { uses?: { value: number; max: number; per: string } }).uses;
      return {
        id: item.id,
        name: item.name,
        uses: uses ? { value: uses.value, max: uses.max, per: uses.per as never } : null,
      };
    });

    // Roll the spent hit dice here, so the table sees real numbers.
    const pool = parseHitDicePool(actor.hitDiceTotal);
    const available = Math.max(0, pool.count - actor.hitDiceUsed);
    const spending = input.type === 'short' ? Math.min(input.hitDiceSpent, available) : 0;

    let healing = 0;
    const conMod = Math.floor((actor.con - 10) / 2);
    if (spending > 0 && pool.die > 0) {
      const roll = rollExpression(`${spending}d${pool.die}`, `${actor.name} hit dice`);
      // Constitution applies per die, and a die never heals less than one.
      healing = Math.max(spending, roll.total + conMod * spending);
    }

    const result = applyRest({
      actor: {
        level: actor.level,
        hpCurrent: actor.hpCurrent,
        hpMax: actor.hpMax,
        hpTemp: actor.hpTemp,
        hitDiceTotal: actor.hitDiceTotal,
        hitDiceUsed: actor.hitDiceUsed,
        spellSlots: actor.spellSlots,
      },
      features,
      type: input.type,
      hitDiceSpent: spending,
      hitDiceHealing: healing,
    });

    await db
      .update(actors)
      .set({
        hpCurrent: result.hpCurrent,
        hpTemp: result.hpTemp,
        hitDiceUsed: result.hitDiceUsed,
        spellSlots: result.spellSlots,
        updatedAt: Date.now(),
      })
      .where(eq(actors.id, id));

    await syncLinkedTokens(app, id);

    for (const entry of result.restored) {
      const item = owned.find((candidate) => candidate.id === entry.id);
      if (!item) continue;

      const system = item.system as { uses?: { value: number } };
      await db
        .update(items)
        .set({ system: { ...item.system, uses: { ...system.uses, value: entry.to } } as never })
        .where(eq(items.id, entry.id));
    }

    return { result };
  });

  /**
   * Rolls a fresh set of ability scores.
   *
   * Over HTTP rather than the table socket: the character sheet is not the
   * table page and holds no socket, so the socket version emitted into the void
   * and looked like a dead button. The roll still happens on the server, and is
   * still posted to the chat of every campaign the character belongs to - the
   * point was always that the table can see the scores were genuinely rolled.
   */
  app.post('/api/actors/:id/roll-abilities', async (request) => {
    const user = assertUser(request);
    const { id } = request.params as { id: string };
    const { actor } = await requireActorWrite(id, user.id);

    const results = ABILITIES.map((ability) => ({
      ability,
      result: rollExpression(ABILITY_ROLL, `${actor.name} — ${ability.toUpperCase()}`),
    }));

    const assigned = await db
      .select({ campaignId: actorCampaigns.campaignId })
      .from(actorCampaigns)
      .where(eq(actorCampaigns.actorId, id));

    if (app.io) {
      const { persistAndDeliver } = await import('../realtime/chat.js');
      for (const row of assigned) {
        for (const { result } of results) {
          await persistAndDeliver(
            app.io,
            row.campaignId,
            { userId: user.id, actorId: actor.id, kind: 'roll', body: result.label, rollData: result },
            { authorName: user.displayName, actorName: actor.name },
          );
        }
      }
    }

    // Returned as well as posted, so a character with no campaign yet still
    // sees its numbers.
    return { rolls: results.map((r) => ({ ability: r.ability, total: r.result.total, dice: r.result.rolls })) };
  });

  /**
   * Gains a level's worth of hit points.
   *
   * The handbook offers two ways and this offers both: roll the class hit die,
   * or take the fixed average. Either is added to the Constitution modifier,
   * and a level never grants less than one hit point however bad the
   * constitution. Rolled on the server like every other roll, and posted to the
   * table so the number is not simply asserted.
   *
   * `hpMax` was previously only ever typed in by hand, so levelling up healed
   * nobody and the sheet quietly disagreed with the hit dice pool beside it.
   */
  app.post('/api/actors/:id/level-hit-points', async (request) => {
    const user = assertUser(request);
    const { id } = request.params as { id: string };
    const { actor } = await requireActorWrite(id, user.id);

    const input = z.object({ method: z.enum(['roll', 'average']) }).parse(request.body);

    const info = classInfo(actor.className);
    if (!info) throw new HttpError(400, `No hit die known for "${actor.className}"`);

    const { roll, average } = hitPointsForLevel(info.hitDie);
    const conMod = abilityModifier(actor.con);

    let dieResult = average;
    let rolled = null;
    if (input.method === 'roll') {
      rolled = rollExpression(roll, `${actor.name} — hit points`);
      dieResult = rolled.total;
    }

    const gained = hitPointsGained(dieResult, conMod);
    const hpMax = actor.hpMax + gained;

    await db
      .update(actors)
      .set({ hpMax, hpCurrent: actor.hpCurrent + gained, updatedAt: Date.now() })
      .where(eq(actors.id, id));

    await syncLinkedTokens(app, id);

    if (app.io && rolled) {
      const assigned = await db
        .select({ campaignId: actorCampaigns.campaignId })
        .from(actorCampaigns)
        .where(eq(actorCampaigns.actorId, id));

      const { persistAndDeliver } = await import('../realtime/chat.js');
      for (const row of assigned) {
        await persistAndDeliver(
          app.io,
          row.campaignId,
          { userId: user.id, actorId: actor.id, kind: 'roll', body: rolled.label, rollData: rolled },
          { authorName: user.displayName, actorName: actor.name },
        );
      }
    }

    return { gained, hpMax, dieResult, conMod, method: input.method };
  });

  /* ----------------------------------------------------------- NPC creation */

  /** Stamps an NPC sheet from an SRD monster, for the DM's bestiary. */
  app.post('/api/campaigns/:campaignId/actors/from-monster', async (request) => {
    const user = assertUser(request);
    const { campaignId } = request.params as { campaignId: string };
    await requireDM(campaignId, user.id);

    const { monsterId } = z.object({ monsterId: z.string() }).parse(request.body);

    const { srdMonsters } = await import('../db/schema.js');
    const found = await db.select().from(srdMonsters).where(eq(srdMonsters.id, monsterId)).limit(1);
    const monster = found[0];
    if (!monster) throw new HttpError(404, 'Monster not found');

    const input = actorInputSchema.parse({
      ...emptyActor(monster.name, 'npc'),
      name: monster.name,
      type: 'npc',
      str: monster.str,
      dex: monster.dex,
      con: monster.con,
      int: monster.int,
      wis: monster.wis,
      cha: monster.cha,
      armorClass: monster.armorClass,
      hpCurrent: monster.hitPoints,
      hpMax: monster.hitPoints,
      hitDiceTotal: monster.hitDice,
      challengeRating: monster.challengeRating,
      race: monster.type,
      alignment: monster.alignment,
      // Bestiary art, where upstream published any. This is a `/srd-images/`
      // URL shared by every copy of the monster, not an upload - deleting one
      // goblin must not take the goblin picture away from the other four.
      portraitUrl: monster.imageUrl,
      // Monsters are unlinked so each copy tracks its own HP, and sized from
      // the stat block: a Gargantuan dragon lands as a 4x4 token.
      prototypeToken: {
        // No `imageUrl` here on purpose: `token:create` stamps board art from
        // `actor.portraitUrl`, and nothing has ever read the prototype's own
        // image. Setting it would be a value with no reader, and one that a
        // later portrait upload could never override.
        w: monster.tokenSize,
        h: monster.tokenSize,
        actorLinked: false,
        disposition: 'hostile',
      },
    });

    const actor = {
      id: newId(),
      ownerUserId: user.id,
      campaignId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...toRow(input),
    };

    await db.insert(actors).values(actor);
    await db.insert(actorCampaigns).values({ actorId: actor.id, campaignId, assignedAt: Date.now() });

    return { actor };
  });
}
